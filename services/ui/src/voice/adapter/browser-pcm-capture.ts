import captureWorklet from "../worklet/pcm-capture.worklet.ts?worker&url";
import type { MediaStreamLike } from "../interface/media-environment.js";
import type {
  CaptureGraph,
  CapturePort,
  PcmCaptureEnvironment,
} from "../interface/pcm-capture.js";
import { voiceStreamAudio } from "@everything/conversation-contracts/voice-stream";

/**
 * Standard browser capture: an AudioContext asked to run at 16 kHz, whose graph resamples the
 * microphone and mixes it down to mono, feeding an audio worklet served from this origin.
 */
export function browserPcmCapture(): PcmCaptureEnvironment {
  const blocker = !window.isSecureContext
    ? "insecure"
    : !navigator.mediaDevices?.getUserMedia ||
        typeof AudioContext === "undefined" ||
        typeof AudioWorkletNode === "undefined"
      ? "unsupported"
      : null;
  return {
    blocker,
    getUserMedia: () =>
      navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      }),
    createGraph: () => audioGraph(),
  };
}

/** A 16 kHz audio context running the capture worklet. */
function audioGraph(): CaptureGraph {
  const context = new AudioContext({
    sampleRate: voiceStreamAudio.sampleRate,
    latencyHint: "interactive",
  });
  let source: MediaStreamAudioSourceNode | null = null;
  let node: AudioWorkletNode | null = null;
  return {
    sampleRate: context.sampleRate,
    async start(stream: MediaStreamLike): Promise<CapturePort> {
      await context.audioWorklet.addModule(captureWorklet);
      source = context.createMediaStreamSource(stream as MediaStream);
      node = new AudioWorkletNode(context, "pcm-capture", {
        numberOfInputs: 1,
        numberOfOutputs: 0,
        channelCount: 1,
        channelCountMode: "explicit",
        channelInterpretation: "speakers",
      });
      source.connect(node);
      await context.resume();
      if (context.state !== "running")
        throw new Error("The audio context didn't start");
      return capturePort(node.port);
    },
    close() {
      source?.disconnect();
      node?.disconnect();
      void context.close().catch(() => undefined);
    },
  };
}

/** The worklet node's port, as the narrow interface capture uses. */
function capturePort(port: MessagePort): CapturePort {
  let handler: CapturePort["onmessage"] = null;
  return {
    postMessage: (message) => port.postMessage(message),
    get onmessage() {
      return handler;
    },
    set onmessage(next) {
      handler = next;
      port.onmessage = next ? (event) => next(event) : null;
    },
  };
}
