import { voiceLimits } from "@everything/conversation-contracts/voice";

/** The decoder's output: 16 kHz, mono, signed 16-bit little-endian PCM. */
export const pcmFormat = {
  sampleRate: 16_000,
  channels: 1,
  bytesPerSample: 2,
} as const;

/** Most PCM bytes a recording within the duration limit can decode to. */
export const maxPcmBytes =
  (voiceLimits.maxDurationMs / 1000) *
  pcmFormat.sampleRate *
  pcmFormat.channels *
  pcmFormat.bytesPerSample;

/** Peak sample magnitude at or below which a recording counts as silence (about -60 dBFS). */
const silencePeak = 32;

/** Length of a canonical RIFF/WAVE header for PCM. */
const waveHeaderLength = 44;

/** Wrap decoded PCM in a WAVE header so any speech service can read it without guessing. */
export function waveFile(pcm: Buffer): Buffer<ArrayBuffer> {
  const { sampleRate, channels, bytesPerSample } = pcmFormat;
  const header = Buffer.alloc(waveHeaderLength);
  header.write("RIFF", 0, "latin1");
  header.writeUInt32LE(waveHeaderLength - 8 + pcm.length, 4);
  header.write("WAVE", 8, "latin1");
  header.write("fmt ", 12, "latin1");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * channels * bytesPerSample, 28);
  header.writeUInt16LE(channels * bytesPerSample, 32);
  header.writeUInt16LE(bytesPerSample * 8, 34);
  header.write("data", 36, "latin1");
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/** True when no sample rises above the silence threshold, so there is nothing to transcribe. */
export function isSilent(pcm: Buffer): boolean {
  for (let offset = 0; offset + 1 < pcm.length; offset += 2)
    if (Math.abs(pcm.readInt16LE(offset)) > silencePeak) return false;
  return true;
}
