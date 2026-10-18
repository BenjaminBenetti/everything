# syntax=docker/dockerfile:1
# voice-asr: internal Nemotron streaming ASR sidecar (CPU only). Build from the repository root:
#   docker build -f services/voice-asr/container/Dockerfile -t voice-asr .
# The model is NOT in the image; mount the pinned GGUF read-only and set VOICE_ASR_MODEL_PATH.

# Native worker: pinned NeMo-Speech.cpp + llama.cpp/ggml + SentencePiece, portable x86-64 AVX2 baseline.
# native/build.sh sets GGML_NATIVE=OFF and explicit ISA flags (never -march=native) and rejects AVX-512 code.
FROM debian:trixie-slim AS native
RUN apt-get update && apt-get install -y --no-install-recommends \
      binutils ca-certificates cmake g++ gcc git libc6-dev make ninja-build \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /build
COPY services/voice-asr/native/ ./native/
RUN JOBS=4 bash native/build.sh /build/work /opt/voice-asr && rm -rf /build/work

# Python dependencies, hash-locked.
FROM python:3.14.8-slim-trixie AS python-deps
COPY services/voice-asr/requirements.lock /tmp/requirements.lock
RUN pip install --no-cache-dir --no-deps --require-hashes --target /opt/voice-asr/python -r /tmp/requirements.lock

# Runtime: no compilers, nonroot.
FROM python:3.14.8-slim-trixie
RUN apt-get update && apt-get install -y --no-install-recommends libgomp1 libstdc++6 tini \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --system --uid 10001 --no-create-home --shell /usr/sbin/nologin voice-asr
COPY --from=native /opt/voice-asr /opt/voice-asr
COPY --from=python-deps /opt/voice-asr/python /opt/voice-asr/python
COPY services/voice-asr/src/voice_asr /opt/voice-asr/python/voice_asr
COPY services/voice-asr/README.md services/voice-asr/THIRD_PARTY_NOTICES.md services/voice-asr/MODEL_LICENSE.md /opt/voice-asr/share/doc/
ENV PYTHONPATH=/opt/voice-asr/python \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PORT=8080 \
    VOICE_ASR_WORKER_PATH=/opt/voice-asr/bin/voice-asr-worker
USER 10001:10001
EXPOSE 8080
ENTRYPOINT ["tini", "--", "python", "-m", "voice_asr"]
