"""Lightweight stderr tracing for the PDF translation pipeline.

Everything written here goes to stderr, which the desktop app's Rust layer
captures line-by-line into the global log store (Settings → Logs). The goal is a
timestamped, per-page / per-paragraph trace detailed enough to pinpoint where a
translation stalls (the classic "stuck at 50%"). Keep it dependency-free so it
can be imported from anywhere without circular-import risk.
"""

from __future__ import annotations

import sys
import time


def trace(msg: str) -> None:
    """Emit a single trace line to stderr, flushed so it streams live."""
    try:
        print(f"[PDF] {msg}", file=sys.stderr, flush=True)
    except Exception:
        # Tracing must never break a translation.
        pass


def now() -> float:
    return time.time()
