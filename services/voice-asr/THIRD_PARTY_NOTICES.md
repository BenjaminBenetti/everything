# Third-party notices

The container image ships these components. License texts are installed under `/opt/voice-asr/share/licenses/` by `native/build.sh`.

| Component | Version / pin | License | Where |
|---|---|---|---|
| NVIDIA NeMo-Speech.cpp (ASR runtime, public C ABI) | `caa3f47c7c75fa2e9e6340272ebad57c1647dd44` | Apache-2.0, plus its NOTICE and THIRD_PARTY_NOTICES.md | `share/licenses/nemo-speech/` |
| llama.cpp / ggml (with NeMo-Speech's in-repo patch series) | `bd4f514db14d87fded667787a7a963bfbaa98e89` | MIT | `share/licenses/llama.cpp/` |
| SentencePiece (static) | `31646a467d2051eb904e0b45de3a73e91fe1c1e3` | Apache-2.0; bundled Abseil Apache-2.0, darts-clone BSD-2-Clause, protobuf-lite BSD-3-Clause | `share/licenses/sentencepiece/` |
| websockets (Python) | 17.2, hash-locked in `requirements.lock` | BSD-3-Clause | the package's `dist-info/licenses` |
| CPython base image `python:3.14.8-slim-trixie` | 3.14.8 | PSF-2.0, Debian package licenses | the base image |
| tini, libgomp1, libstdc++6 (Debian trixie packages) | distribution versions | MIT; GPL-3.0 with the GCC Runtime Library Exception | `/usr/share/doc/*/copyright` |

The model weights are separate and are **not** part of the image: NVIDIA Open Model License, see [MODEL_LICENSE.md](MODEL_LICENSE.md).
