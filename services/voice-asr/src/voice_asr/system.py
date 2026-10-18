"""Host checks performed before the native library is ever loaded: CPU features and the pinned model."""
import hashlib
import os
from dataclasses import dataclass

# The native build targets x86-64 with these extensions (services/voice-asr/native/build.sh).
REQUIRED_CPU_FLAGS = frozenset({"sse4_2", "avx", "avx2", "fma", "f16c", "bmi2"})


@dataclass(frozen=True)
class ModelPin:
    size: int
    sha256: str


# Official nvidia/nemotron-speech-streaming-en-0.6b @ ebe59e5a817142986528bbbee5dba8db7b38ed50,
# nemotron-speech-streaming-en-0.6b.q8_0.gguf. Not operator-overridable.
NEMOTRON_EN_Q8_0 = ModelPin(699_872_960, "d9a01898d2a611c8764e23a1c2f45e70bbd5a425dc4de93692ac951dd603812d")


def cpu_supported(cpuinfo_path: str = "/proc/cpuinfo") -> bool:
    """True when every listed CPU reports all required flags."""
    try:
        with open(cpuinfo_path, encoding="ascii", errors="replace") as f:
            flag_lines = [line.split(":", 1)[1].split() for line in f if line.startswith("flags")]
    except OSError:
        return False
    return bool(flag_lines) and all(REQUIRED_CPU_FLAGS <= set(flags) for flags in flag_lines)


def model_matches(path: str, pin: ModelPin) -> bool:
    """True when the file at path has exactly the pinned size and SHA-256 (reads the whole file)."""
    try:
        if os.stat(path).st_size != pin.size:
            return False
        digest = hashlib.sha256()
        with open(path, "rb") as f:
            for block in iter(lambda: f.read(1 << 20), b""):
                digest.update(block)
        return digest.hexdigest() == pin.sha256
    except OSError:
        return False
