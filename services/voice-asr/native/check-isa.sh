#!/usr/bin/env bash
# Fail when an ELF object contains AVX-512 code (zmm registers or opmask k1-k7) or links a GPU library.
# The full disassembly is written to a file first, so an early grep match can never SIGPIPE the producer.
set -euo pipefail
status=0
scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT
for object in "$@"; do
    objdump -d --no-show-raw-insn "$object" > "$scratch/disassembly"
    if grep -E '%zmm[0-9]|%k[1-7]' "$scratch/disassembly" > /dev/null; then
        echo "AVX-512 instructions found in $(basename "$object")" >&2
        status=1
    fi
    readelf -d "$object" > "$scratch/dynamic"
    if grep -iE 'NEEDED.*(cuda|cublas|vulkan|nvidia|opencl)' "$scratch/dynamic" > /dev/null; then
        echo "GPU library linked by $(basename "$object")" >&2
        status=1
    fi
done
exit "$status"
