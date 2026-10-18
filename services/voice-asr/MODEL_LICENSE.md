# Model weights: NVIDIA Open Model License (not Apache-2.0)

voice-asr runs exactly one model, which is **not included** in this repository or the container image:

| | |
|---|---|
| Repository | `nvidia/nemotron-speech-streaming-en-0.6b` |
| Revision | `ebe59e5a817142986528bbbee5dba8db7b38ed50` |
| File | `nemotron-speech-streaming-en-0.6b.q8_0.gguf` |
| Size | 699,872,960 bytes |
| SHA-256 | `d9a01898d2a611c8764e23a1c2f45e70bbd5a425dc4de93692ac951dd603812d` |

The service refuses to become ready unless the file at `VOICE_ASR_MODEL_PATH` matches that size and hash. The pin cannot be overridden at runtime.

## License

The weights are governed by the **NVIDIA Open Model License Agreement**, last modified October 24, 2025: <https://www.nvidia.com/en-us/agreements/enterprise-software/nvidia-open-model-license/>. Operators must read and accept it before downloading or deploying the model.

A summary of terms relevant to deployment follows. It is not legal advice and not a substitute for the Agreement.
- The models are commercially usable, and derivative models may be created and distributed. NVIDIA claims no ownership of outputs.
- **Redistribution** of the model (for example, shipping the GGUF in an image or volume to others) requires giving recipients a copy of the Agreement. It also requires a "Notice" text file containing: `Licensed by NVIDIA Corporation under the NVIDIA Open Model License`.
- Rights terminate if you bypass, disable or circumvent technical limitations or safety guardrails, or if you bring patent or copyright litigation over the model.

## Provisioning

1. Download explicitly; the service never downloads anything itself:
   `python3 scripts/fetch_model.py --dest /models/nemotron-speech-streaming-en-0.6b.q8_0.gguf --accept-nvidia-open-model-license`
   The helper fetches only the pinned file. It verifies size and SHA-256 before installing it read-only, and writes the NOTICE file next to it.
2. Mount the directory read-only into the container and set `VOICE_ASR_MODEL_PATH` to the file.
