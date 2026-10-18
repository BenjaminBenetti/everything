"""Per-process privacy hardening: no core dumps and no ptrace/procfs memory access to this process.

Applied before the bearer token, model or any audio is read. PR_SET_DUMPABLE=0 also covers piped system core
handlers that ignore RLIMIT_CORE. This changes only this process, never host or kernel settings.
"""
import ctypes
import resource

PR_GET_DUMPABLE = 3
PR_SET_DUMPABLE = 4


class HardeningError(Exception):
    """Core dumps could not be disabled; the service must not start."""


def _libc():
    libc = ctypes.CDLL(None, use_errno=True)
    libc.prctl.argtypes = [ctypes.c_int, ctypes.c_ulong, ctypes.c_ulong, ctypes.c_ulong, ctypes.c_ulong]
    libc.prctl.restype = ctypes.c_int
    return libc


def harden_process(libc=None) -> None:
    """Set RLIMIT_CORE to 0/0 and mark the process non-dumpable, verifying both, or raise HardeningError."""
    try:
        resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
        libc = libc or _libc()
        if libc.prctl(PR_SET_DUMPABLE, 0, 0, 0, 0) != 0:
            raise HardeningError("PR_SET_DUMPABLE failed")
        if libc.prctl(PR_GET_DUMPABLE, 0, 0, 0, 0) != 0 or resource.getrlimit(resource.RLIMIT_CORE) != (0, 0):
            raise HardeningError("hardening not in effect")
    except (OSError, ValueError, AttributeError) as error:
        raise HardeningError(type(error).__name__) from None
