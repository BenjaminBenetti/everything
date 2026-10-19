import { VoiceStreamConnection } from "../adapter/voice-stream-connection.js";
import type { Dictation, DictationEvents } from "../interface/dictation.js";
import type { PcmCaptureEnvironment } from "../interface/pcm-capture.js";
import { PcmMicrophone } from "./pcm-microphone.js";

/** Extra time the browser waits for a final beyond the server's own deadline. */
const networkMarginMs = 15_000;

/**
 * The streaming lane: audio leaves the browser while the microphone is held, and partial
 * transcripts come back while it does, when the speech service provides them. On release the
 * worklet's last frame is flushed, every queued frame is sent, end follows, and the final transcript
 * is the result. Capture and transport fail together: either failing stops both.
 */
export class LiveDictation implements Dictation {
  private readonly connection: VoiceStreamConnection;
  private readonly microphone: PcmMicrophone;

  /** Stream to the gateway URL for a teammate. */
  constructor(
    capture: PcmCaptureEnvironment,
    url: string,
    finalTimeoutMs: number,
    events: DictationEvents & { readonly maxDurationMs: number },
  ) {
    this.connection = new VoiceStreamConnection(url, {
      finalTimeoutMs: finalTimeoutMs + networkMarginMs,
      onFailure: (error) => {
        this.microphone.cancel();
        events.onFailure(error);
      },
      onPartial: (text, revision) => events.onPartial?.(text, revision),
    });
    this.microphone = new PcmMicrophone(capture, this.connection, {
      maxDurationMs: events.maxDurationMs,
      onLimit: () => events.onLimit(),
      onFailure: (error) => {
        this.connection.cancel();
        events.onFailure(error);
      },
    });
  }

  /** Connect and start capturing at once; audio captured while connecting waits in a bounded queue. */
  async start(): Promise<boolean> {
    this.connection.open();
    try {
      const capturing = await this.microphone.start();
      if (!capturing) this.connection.cancel();
      return capturing;
    } catch (error) {
      this.connection.cancel();
      throw error;
    }
  }

  /** Flush the capture, send what remains and end, and resolve the final transcript. */
  async finish(): Promise<string | null> {
    try {
      const end = await this.microphone.finish();
      if (!end) {
        this.connection.cancel();
        return null;
      }
      return await this.connection.finish(end.samples);
    } catch (error) {
      this.connection.cancel();
      throw error;
    }
  }

  /** Stop capturing and cancel the stream. */
  cancel(): void {
    this.microphone.cancel();
    this.connection.cancel();
  }
}
