"""Operator helper: download the ONE pinned Nemotron GGUF and write its NVIDIA notice. Never run by the service.

usage: python3 fetch_model.py --dest /models/nemotron-speech-streaming-en-0.6b.q8_0.gguf --accept-nvidia-open-model-license

The weights are licensed under the NVIDIA Open Model License Agreement (not Apache-2.0); read
https://www.nvidia.com/en-us/agreements/enterprise-software/nvidia-open-model-license/ before accepting.
"""
import argparse
import hashlib
import os
import sys
import urllib.request

REVISION = "ebe59e5a817142986528bbbee5dba8db7b38ed50"
FILENAME = "nemotron-speech-streaming-en-0.6b.q8_0.gguf"
URL = f"https://huggingface.co/nvidia/nemotron-speech-streaming-en-0.6b/resolve/{REVISION}/{FILENAME}"
SIZE = 699_872_960
SHA256 = "d9a01898d2a611c8764e23a1c2f45e70bbd5a425dc4de93692ac951dd603812d"
LICENSE_URL = "https://www.nvidia.com/en-us/agreements/enterprise-software/nvidia-open-model-license/"
NOTICE = (
    "Licensed by NVIDIA Corporation under the NVIDIA Open Model License\n"
    f"Model: nvidia/nemotron-speech-streaming-en-0.6b @ {REVISION}, file {FILENAME}\n"
    f"Agreement: {LICENSE_URL}\n"
)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--dest", required=True, help="destination path for the GGUF file")
    parser.add_argument("--accept-nvidia-open-model-license", action="store_true", required=True)
    parser.add_argument("--timeout", type=float, default=30.0, help="per-read network timeout in seconds")
    args = parser.parse_args()

    partial = args.dest + ".partial"
    digest, received = hashlib.sha256(), 0
    with urllib.request.urlopen(URL, timeout=args.timeout) as response, open(partial, "wb") as out:
        for block in iter(lambda: response.read(1 << 20), b""):
            received += len(block)
            if received > SIZE:
                break
            digest.update(block)
            out.write(block)
    if received != SIZE or digest.hexdigest() != SHA256:
        os.unlink(partial)
        print("download does not match the pinned size/SHA-256; nothing was installed", file=sys.stderr)
        return 1
    os.chmod(partial, 0o444)
    os.replace(partial, args.dest)
    with open(os.path.join(os.path.dirname(os.path.abspath(args.dest)), "NOTICE"), "w") as f:
        f.write(NOTICE)
    print(f"installed {args.dest} ({SIZE} bytes, sha256 {SHA256})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
