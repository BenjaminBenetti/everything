"""Operator helper: download the ONE pinned Nemotron GGUF and write its NVIDIA notice, outside a cluster.

usage: python3 fetch_model.py --dest /models/nemotron-speech-streaming-en-0.6b.q8_0.gguf --accept-nvidia-open-model-license

The chart does this itself with an init container (python -m voice_asr.provision); both use the same pins.
The weights are licensed under the NVIDIA Open Model License Agreement (not Apache-2.0); read
https://www.nvidia.com/en-us/agreements/enterprise-software/nvidia-open-model-license/ before accepting.
"""
import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from voice_asr.provision import NEMOTRON_EN_Q8_0_SOURCE, ProvisionError, provision  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--dest", required=True, help="destination path for the GGUF file")
    parser.add_argument("--accept-nvidia-open-model-license", action="store_true", required=True)
    parser.add_argument("--timeout", type=float, default=30.0, help="per-read network timeout in seconds")
    parser.add_argument("--deadline", type=float, default=1800.0, help="whole-download deadline in seconds")
    args = parser.parse_args()
    source = NEMOTRON_EN_Q8_0_SOURCE
    try:
        outcome = provision(args.dest, source, deadline_s=args.deadline, read_timeout_s=args.timeout)
    except (ProvisionError, OSError) as error:
        print(f"nothing was installed: {error}", file=sys.stderr)
        return 1
    print(f"{outcome} {args.dest} ({source.pin.size} bytes, sha256 {source.pin.sha256})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
