import type { BrowserContext, Page } from "@playwright/test";

/** One recording the page uploaded. */
export interface Upload {
  readonly contentType: string;
  readonly bytes: Buffer;
  readonly path: string;
}

/** Server-side state the voice tests observe and control. */
export interface VoiceWorkspace {
  readonly uploads: Upload[];
  readonly sends: string[];
  /** What the next transcription returns. */
  transcript: string;
  /** Status for the next transcription; 200 returns the transcript. */
  status: number;
  /** When set, transcriptions wait until the test opens the gate. */
  gate: Promise<void> | null;
}

/**
 * Mock every API route the conversation page uses, so tests run against an isolated UI server
 * without a cluster. The teammate Avery has a model and voice input is available unless disabled;
 * `streaming` offers the streaming lane too.
 */
export async function voiceWorkspace(
  context: BrowserContext,
  {
    available = true,
    streaming = false,
  }: { available?: boolean; streaming?: boolean } = {},
): Promise<VoiceWorkspace> {
  const state: VoiceWorkspace = {
    uploads: [],
    sends: [],
    transcript: "there",
    status: 200,
    gate: null,
  };
  // Registered first, so it only answers what no specific route below handles.
  await context.route("**/v1/**", (route) =>
    route.fulfill({
      status: 404,
      json: { code: "NOT_FOUND", message: "Not found" },
    }),
  );
  await context.route("**/v1/session", (route) =>
    route.fulfill({
      json: {
        profile: { subject: "voice-test-owner", displayName: "Voice owner" },
      },
    }),
  );
  await context.route("**/v1/providers", (route) =>
    route.fulfill({ json: { providers: [] } }),
  );
  const avery = {
    id: "avery",
    name: "Avery",
    avatarId: "avatar-03",
    systemPrompt: "Help with project planning.",
    createdAt: "2026-10-12T10:00:00Z",
    inference: {
      provider: "openai-compatible",
      model: "o3-mini",
      effort: "high",
    },
  };
  await context.route("**/v1/agents", (route) =>
    route.fulfill({ json: { agents: [avery] } }),
  );
  await context.route("**/v1/agents/recent", (route) =>
    route.fulfill({ json: { agents: [avery] } }),
  );
  await context.route("**/v1/agents/*/interactions", (route) =>
    route.fulfill({ status: 204 }),
  );
  await context.route("**/v1/workspaces", (route) =>
    route.fulfill({ json: { workspaces: [] } }),
  );
  await context.route("**/v1/agents/*/workspaces", (route) =>
    route.fulfill({
      json: { workspaces: [], observedAt: new Date().toISOString() },
    }),
  );
  await context.route("**/v1/agents/*/runtime", (route) =>
    route.fulfill({
      json: {
        status: "idle",
        compacting: false,
        compactionStartedAt: null,
        typing: false,
        backgroundCount: 0,
        sessionId: "voice-session",
        runId: null,
        error: null,
      },
    }),
  );
  await context.route(/\/v1\/agents\/[^/]+\/messages(?:\?.*)?$/, (route) => {
    if (route.request().method() === "POST") {
      state.sends.push(
        (route.request().postDataJSON() as { text: string }).text,
      );
      return route.fulfill({
        status: 202,
        json: { messageId: `message-${state.sends.length}`, runId: "run" },
      });
    }
    return route.fulfill({ json: { messages: [], nextCursor: null } });
  });
  await context.route("**/v1/agents/*/messages/read", (route) =>
    route.fulfill({ status: 204 }),
  );
  await context.route("**/v1/updates**", (route) =>
    route.fulfill({
      json: { updates: [], nextCursor: null, unread: 0, byAgent: {} },
    }),
  );
  await context.route("**/v1/voice/capabilities", (route) =>
    route.fulfill({
      json: {
        available,
        maxDurationMs: 60_000,
        maxBytes: 8 * 1024 * 1024,
        mediaTypes: ["audio/webm", "audio/ogg", "audio/mp4"],
        responseTimeoutMs: 195_000,
        ...(streaming ? { streaming, streamFinalTimeoutMs: 30_000 } : {}),
      },
    }),
  );
  await context.route("**/v1/agents/*/voice/transcriptions", async (route) => {
    const request = route.request();
    state.uploads.push({
      contentType: request.headers()["content-type"] ?? "",
      bytes: request.postDataBuffer() ?? Buffer.alloc(0),
      path: new URL(request.url()).pathname,
    });
    if (state.gate) await state.gate;
    // The page may have abandoned the request, for example by sending its draft.
    await route
      .fulfill(
        state.status === 200
          ? { json: { text: state.transcript } }
          : {
              status: state.status,
              json: { code: "FAILED", message: "Private detail" },
            },
      )
      .catch(() => undefined);
  });
  return state;
}

/** How the fake microphone answers permission requests. */
export type Permission = "grant" | "deny" | "manual";

/** A stand-in microphone and MediaRecorder that negotiate formats like one browser engine. */
export interface FakeMicrophoneOptions {
  readonly permission: Permission;
  /** Types `MediaRecorder.isTypeSupported` accepts, as the engine being imitated reports them. */
  readonly supported: readonly string[];
  /** The container signature the fake's first chunk starts with. */
  readonly container: "webm" | "mp4";
}

/** Chromium records Opus in WebM. */
export const chromiumFormats: FakeMicrophoneOptions = {
  permission: "grant",
  supported: ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"],
  container: "webm",
};

/** Safari records AAC in MP4 and doesn't record WebM. */
export const safariFormats: FakeMicrophoneOptions = {
  permission: "grant",
  supported: ["audio/mp4;codecs=mp4a.40.2", "audio/mp4"],
  container: "mp4",
};

/** Counters the fake microphone keeps, read from the page. */
export interface MicrophoneState {
  requests: number;
  tracksStarted: number;
  tracksStopped: number;
  recordersCreated: number;
  pending: number;
}

/**
 * Replace the page's microphone and MediaRecorder before it loads. No real device is opened and no
 * real audio is captured; chunks are fixed bytes that begin with the container's signature.
 */
export async function installFakeMicrophone(
  context: BrowserContext,
  options: FakeMicrophoneOptions,
): Promise<void> {
  await context.addInitScript((settings: FakeMicrophoneOptions) => {
    const state = {
      requests: 0,
      tracksStarted: 0,
      tracksStopped: 0,
      recordersCreated: 0,
      pending: 0,
    };
    const waiting: { grant(): void; deny(): void }[] = [];
    /** A stream with one track that counts being stopped. */
    const stream = () => {
      state.tracksStarted++;
      let stopped = false;
      const track = {
        kind: "audio",
        stop() {
          if (!stopped) state.tracksStopped++;
          stopped = true;
        },
      };
      return { getTracks: () => [track], getAudioTracks: () => [track] };
    };
    const denied = () =>
      new DOMException("Permission denied", "NotAllowedError");
    const mediaDevices = {
      getUserMedia: () => {
        state.requests++;
        if (settings.permission === "deny") return Promise.reject(denied());
        return new Promise((resolve, reject) => {
          if (settings.permission === "grant") return resolve(stream());
          state.pending++;
          waiting.push({
            grant: () => resolve(stream()),
            deny: () => reject(denied()),
          });
        });
      },
    };
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      get: () => mediaDevices,
    });
    const signature =
      settings.container === "webm"
        ? [0x1a, 0x45, 0xdf, 0xa3]
        : [0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70];
    /** A recorder that emits a chunk each timeslice and a final chunk on stop. */
    class FakeMediaRecorder extends EventTarget {
      static isTypeSupported(type: string): boolean {
        return settings.supported.includes(type);
      }
      readonly mimeType: string;
      state = "inactive";
      private chunks = 0;
      private timer: ReturnType<typeof setInterval> | undefined;
      constructor(_stream: unknown, init: { mimeType?: string } = {}) {
        super();
        state.recordersCreated++;
        this.mimeType = init.mimeType ?? "";
      }
      start(timeslice = 1000): void {
        this.state = "recording";
        this.timer = setInterval(() => this.emit(), timeslice);
      }
      stop(): void {
        if (this.state === "inactive") return;
        this.state = "inactive";
        clearInterval(this.timer);
        setTimeout(() => {
          this.emit();
          this.dispatchEvent(new Event("stop"));
        }, 0);
      }
      private emit(): void {
        const bytes =
          this.chunks++ === 0
            ? new Uint8Array([
                ...signature,
                ...new TextEncoder().encode("FAKE"),
              ])
            : new TextEncoder().encode("MORE");
        const event = new Event("dataavailable") as Event & { data: Blob };
        event.data = new Blob([bytes], { type: this.mimeType });
        this.dispatchEvent(event);
      }
    }
    Object.defineProperty(window, "MediaRecorder", {
      configurable: true,
      value: FakeMediaRecorder,
    });
    Object.assign(window, {
      fakeMicrophone: {
        state,
        grant: () => waiting.splice(0).forEach((entry) => entry.grant()),
        deny: () => waiting.splice(0).forEach((entry) => entry.deny()),
      },
    });
  }, options);
}

/** Read the fake microphone's counters. */
export function microphone(page: Page): Promise<MicrophoneState> {
  return page.evaluate(
    () =>
      (window as unknown as { fakeMicrophone: { state: MicrophoneState } })
        .fakeMicrophone.state,
  );
}

/** Answer the fake microphone's pending permission prompt. */
export function answerPermission(
  page: Page,
  answer: "grant" | "deny",
): Promise<void> {
  return page.evaluate((choice) => {
    const fake = (
      window as unknown as { fakeMicrophone: Record<string, () => void> }
    ).fakeMicrophone;
    fake[choice]!();
  }, answer);
}
