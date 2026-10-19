#!/usr/bin/env bash
# Build the voice-asr native worker against pinned NeMo-Speech.cpp with a portable x86-64 AVX2 baseline.
#
# usage: build.sh WORK_DIR PREFIX
#   NEMO_SPEECH_SRC       optional existing checkout at the pinned commits (verified, never modified)
#   SENTENCEPIECE_PREFIX  optional existing static SentencePiece install built at the pinned commit
#   JOBS                  build parallelism, capped at 4
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=pins.env
source "$here/pins.env"
work=$(mkdir -p "${1:?work dir}" && cd "$1" && pwd)
prefix=$(mkdir -p "${2:?install prefix}" && cd "$2" && pwd)
jobs=${JOBS:-4}
(( jobs > 4 )) && jobs=4

# ---------------------------------------------------------------------------
# Pinned sources
# ---------------------------------------------------------------------------
src=${NEMO_SPEECH_SRC:-$work/NeMo-Speech.cpp}
if [ ! -d "$src/.git" ]; then
    git init -q "$src"
    git -C "$src" fetch -q --depth 1 "$NEMO_SPEECH_URL" "$NEMO_SPEECH_COMMIT"
    git -C "$src" checkout -q FETCH_HEAD
    git -C "$src" submodule update -q --init --depth 1 llama.cpp
fi
[ "$(git -C "$src" rev-parse HEAD)" = "$NEMO_SPEECH_COMMIT" ] || { echo "NeMo-Speech.cpp is not at $NEMO_SPEECH_COMMIT" >&2; exit 1; }
[ "$(git -C "$src/llama.cpp" rev-parse HEAD)" = "$LLAMA_CPP_COMMIT" ] || { echo "llama.cpp is not at $LLAMA_CPP_COMMIT" >&2; exit 1; }
grep -qx "COMMIT=$SENTENCEPIECE_COMMIT" "$src/scripts/build_sentencepiece_static.sh" || { echo "SentencePiece pin mismatch" >&2; exit 1; }

sp=${SENTENCEPIECE_PREFIX:-$work/sentencepiece}
if [ ! -f "$sp/lib/libsentencepiece.a" ]; then
    JOBS=$jobs PREFIX=$sp bash "$src/scripts/build_sentencepiece_static.sh" "$work/sentencepiece-build"
fi

# ---------------------------------------------------------------------------
# Portable CPU build: explicit AVX2/FMA/F16C/BMI2, never -march=native, no AVX-512/VNNI/AMX/GPU
# ---------------------------------------------------------------------------
cmake -S "$src" -B "$work/build" -G Ninja -DCMAKE_BUILD_TYPE=Release \
    -DGGML_NATIVE=OFF -DGGML_CPU_ALL_VARIANTS=OFF -DGGML_BACKEND_DL=OFF \
    -DGGML_SSE42=ON -DGGML_AVX=ON -DGGML_AVX2=ON -DGGML_FMA=ON -DGGML_F16C=ON -DGGML_BMI2=ON \
    -DGGML_AVX_VNNI=OFF -DGGML_AVX512=OFF -DGGML_AVX512_VBMI=OFF -DGGML_AVX512_VNNI=OFF -DGGML_AVX512_BF16=OFF \
    -DGGML_AMX_TILE=OFF -DGGML_AMX_INT8=OFF -DGGML_AMX_BF16=OFF \
    -DGGML_CUDA=OFF -DGGML_HIP=OFF -DGGML_VULKAN=OFF -DGGML_METAL=OFF -DGGML_SYCL=OFF -DGGML_OPENCL=OFF -DGGML_RPC=OFF \
    -DGGML_BLAS=OFF -DGGML_ZENDNN=OFF -DGGML_LLAMAFILE=ON -DGGML_OPENMP=ON \
    -DNEMO_SPEECH_GGML_PATCHED=ON -DNEMO_SPEECH_BUILD_ASR=ON -DNEMO_SPEECH_BUILD_DIAR=ON \
    -DNEMO_SPEECH_BUILD_TTS=OFF -DNEMO_SPEECH_BUILD_NMT=OFF -DNEMO_SPEECH_BUILD_S2S=OFF -DNEMO_SPEECH_BUILD_CLI=OFF \
    -DNEMO_SPEECH_BUILD_MIC_CAPTURE=OFF -DNEMO_SPEECH_BUILD_HTTP=OFF -DNEMO_SPEECH_BUILD_GRPC=OFF \
    -DNEMO_SPEECH_BUILD_TESTS=OFF -DNEMO_SPEECH_BUILD_EXAMPLES=OFF -DNEMO_SPEECH_BUILD_TOOLS=OFF \
    -DSENTENCEPIECE_LIB="$sp/lib/libsentencepiece.a" -DSENTENCEPIECE_INCLUDE_DIR="$sp/include"
cmake --build "$work/build" --target nemo_speech_asr_c -j "$jobs"

# ---------------------------------------------------------------------------
# Install: worker + the shared libraries it needs, rpath $ORIGIN/../lib
# ---------------------------------------------------------------------------
mkdir -p "$prefix/bin" "$prefix/lib" "$prefix/share/licenses"
cp -a "$work/build/bin/"libnemo_speech_asr_c.so* "$work/build/bin/libnemo_speech_asr.so" "$work/build/bin/"libggml*.so* "$prefix/lib/"
cc -O2 -std=c11 -Wall -Wextra -Werror -D_GNU_SOURCE -I "$src/include" "$here/worker.c" \
    -L "$prefix/lib" -lnemo_speech_asr_c -Wl,-rpath,'$ORIGIN/../lib' -o "$prefix/bin/voice-asr-worker"

# No AVX-512 code and no GPU libraries in anything we ship (checked on the full disassembly).
"$here/check-isa.sh" "$prefix/lib/"*.so* "$prefix/bin/voice-asr-worker"

lic=$prefix/share/licenses
mkdir -p "$lic/nemo-speech" "$lic/llama.cpp" "$lic/sentencepiece"
cp "$src/LICENSE" "$src/NOTICE" "$src/THIRD_PARTY_NOTICES.md" "$lic/nemo-speech/"
cp "$src/llama.cpp/LICENSE" "$lic/llama.cpp/"
cp -r "$sp/share/licenses/nemo-speech/third_party/sentencepiece/." "$lic/sentencepiece/"
(cd "$prefix" && find bin lib -type f | sort | xargs sha256sum) > "$prefix/share/native-manifest.sha256"
{
    echo "nemo_speech=$NEMO_SPEECH_COMMIT"
    echo "llama_cpp=$LLAMA_CPP_COMMIT"
    echo "sentencepiece=$SENTENCEPIECE_COMMIT"
    echo "isa=x86-64 sse4.2 avx avx2 fma f16c bmi2 (no avx512/vnni/amx)"
} > "$prefix/share/native-pins.txt"
