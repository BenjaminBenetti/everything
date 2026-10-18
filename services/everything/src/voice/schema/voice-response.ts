import { Type } from "typebox";
import { messageTextMaxLength } from "@everything/conversation-contracts";
import { voiceMediaTypes } from "@everything/conversation-contracts/voice";

/** Whether recordings can be transcribed, and the limits that apply to them. */
export const voiceCapabilitiesResponse = Type.Object({
  available: Type.Boolean({
    description:
      "False when no self-hosted speech recognition service is configured or its decoder is missing.",
  }),
  maxDurationMs: Type.Integer({ minimum: 1 }),
  maxBytes: Type.Integer({ minimum: 1 }),
  mediaTypes: Type.Array(
    Type.Union(voiceMediaTypes.map((type) => Type.Literal(type))),
  ),
  responseTimeoutMs: Type.Integer({
    minimum: 1,
    description:
      "Longest a transcription request may take, including waiting for capacity.",
  }),
  streaming: Type.Boolean({
    description:
      "Whether audio can stream to a self-hosted speech service while the microphone is held.",
  }),
  streamFinalTimeoutMs: Type.Integer({
    minimum: 0,
    description:
      "Longest the server waits for a stream's final transcript after its end.",
  }),
});

/** The final transcript of one recording. */
export const voiceTranscriptResponse = Type.Object({
  text: Type.String({
    maxLength: messageTextMaxLength,
    description: "Empty when the recording contained no recognizable speech.",
  }),
});
