/**
 * Audio worklet that turns microphone audio into 16-bit PCM frames for streaming. The audio graph
 * runs at 16 kHz and mixes the microphone down to mono before this processor sees it, so it only
 * converts samples and cuts them into frames. Frames go to the main thread, which returns a credit
 * for each one it takes; with too many frames outstanding the capture fails instead of queueing.
 * Self-contained: audio worklets run in their own global scope.
 */

/** The audio worklet global scope's processor base class. */
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}

/** Registers a processor class under a name. */
declare function registerProcessor(
  name: string,
  processor: new () => AudioWorkletProcessor,
): void;

/** Samples per frame sent to the main thread: 20 ms at 16 kHz. */
const frameSamples = 320;

/** Frames the main thread may leave unclaimed: one second of audio. */
const maxOutstandingFrames = 50;

/** Messages from the main thread. */
type Command =
  { type: "credit"; frames: number } | { type: "flush" } | { type: "stop" };

/** Captures mono input into PCM16 frames. */
class PcmCaptureProcessor extends AudioWorkletProcessor {
  private frame = new Int16Array(frameSamples);
  private filled = 0;
  private outstanding = 0;
  private samples = 0;
  private stopped = false;

  constructor() {
    super();
    this.port.onmessage = (event: MessageEvent<Command>) => {
      const command = event.data;
      if (command.type === "credit")
        this.outstanding = Math.max(0, this.outstanding - command.frames);
      else if (command.type === "flush") {
        // The last, possibly short, frame is sent before reporting the total.
        if (!this.stopped && this.filled) this.emit(this.filled);
        this.stopped = true;
        this.port.postMessage({ type: "flushed", samples: this.samples });
      } else this.stopped = true;
    };
  }

  /** Convert one render quantum; returns true to keep running until stopped. */
  process(inputs: Float32Array[][]): boolean {
    if (this.stopped) return false;
    const channel = inputs[0]?.[0];
    if (!channel) return true;
    for (let index = 0; index < channel.length; index++) {
      const sample = Math.max(-1, Math.min(1, channel[index]!));
      this.frame[this.filled++] =
        sample < 0 ? sample * 0x8000 : sample * 0x7fff;
      if (this.filled === frameSamples) {
        this.emit(frameSamples);
        if (this.stopped) return false;
      }
    }
    return true;
  }

  /** Hand a frame to the main thread, or stop the capture if too many are unclaimed. */
  private emit(length: number): void {
    if (this.outstanding >= maxOutstandingFrames) {
      this.stopped = true;
      this.port.postMessage({ type: "overflow" });
      return;
    }
    const frame =
      length === frameSamples ? this.frame : this.frame.slice(0, length);
    this.outstanding++;
    this.samples += length;
    this.port.postMessage({ type: "frame", samples: frame }, [frame.buffer]);
    this.frame = new Int16Array(frameSamples);
    this.filled = 0;
  }
}

registerProcessor("pcm-capture", PcmCaptureProcessor);
