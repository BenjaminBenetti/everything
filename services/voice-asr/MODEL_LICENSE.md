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

The service itself never downloads anything. Provisioning is a separate step that fetches only the pinned file:
- it verifies the size and SHA-256 before installing the file read-only;
- it writes the NOTICE file next to it.

- **With the Helm chart (default).** `services.voice-asr` runs `python -m voice_asr.provision` as an init container into the `voice-asr-models` volume. The chart sets `VOICE_ASR_MODEL_LICENSE=NVIDIA-Open-Model-License`, so deploying the chart with this service enabled downloads and uses the model under this Agreement; read it first, or turn the service off.
- **Elsewhere.** Run the operator helper, then mount the directory read-only into the container and set `VOICE_ASR_MODEL_PATH` to the file:
  `python3 scripts/fetch_model.py --dest /models/nemotron-speech-streaming-en-0.6b.q8_0.gguf --accept-nvidia-open-model-license`

Neither copies the Agreement itself. Anyone who redistributes the weights (for example, shipping the GGUF in an image, volume or archive to others) must also supply recipients with a full copy of the NVIDIA Open Model License Agreement from the link above, alongside that NOTICE.
