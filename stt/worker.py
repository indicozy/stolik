#!/usr/bin/env python3
"""Long-lived speech-to-text worker for stolik.

stdin : one JSON object per line  {"id": <any>, "path": "<audio file>"}
stdout: one JSON object per line  {"id": <same>, "text": "..."}  or  {"id": <same>, "error": "..."}
stderr: human-readable log lines (device choice, timings).

Run as: python -I stt/worker.py   (env: CUDA_DEVICE_ORDER=PCI_BUS_ID CUDA_VISIBLE_DEVICES=1, HF_HOME=...)
"""

import ctypes
import glob
import json
import os
import site
import sys
import time

MODEL = "large-v3-turbo"


def log(msg: str) -> None:
    sys.stderr.write(f"[stt] {msg}\n")
    sys.stderr.flush()


def preload_nvidia_libs() -> None:
    """Load the pip-installed cuBLAS/cuDNN libs with RTLD_GLOBAL so CTranslate2 finds them
    without LD_LIBRARY_PATH. Failures are ignored: the CPU fallback does not need them."""
    dirs = []
    for root in list(site.getsitepackages()) + [p for p in sys.path if p.endswith("site-packages")]:
        dirs.extend(glob.glob(os.path.join(root, "nvidia", "*", "lib")))
    libs = []
    for d in dirs:
        for pattern in ("libcublas*.so*", "libcudnn*.so*"):
            libs.extend(sorted(glob.glob(os.path.join(d, pattern))))
    # Several passes: cuDNN sub-libraries may depend on each other in any order.
    pending = list(dict.fromkeys(libs))
    for _ in range(3):
        still = []
        for lib in pending:
            try:
                ctypes.CDLL(lib, mode=ctypes.RTLD_GLOBAL)
            except OSError:
                still.append(lib)
        pending = still
        if not pending:
            break
    log(f"preloaded {len(libs) - len(pending)}/{len(libs)} nvidia libs")


def load_model(device: str):
    from faster_whisper import WhisperModel

    # download_root is left unset: faster-whisper then uses the standard HF cache, which is
    # $HF_HOME/hub (HF_HOME=/mnt/ai_models/hf in the router environment).
    if device == "cuda":
        model = WhisperModel(MODEL, device="cuda", compute_type="int8_float16")
        # Warm-up on a short silence so missing cuDNN/cuBLAS fails here, not on the first real clip.
        import numpy as np

        segments, _ = model.transcribe(np.zeros(16000, dtype=np.float32), vad_filter=False)
        list(segments)
        return model
    return WhisperModel(MODEL, device="cpu", compute_type="int8", cpu_threads=8)


DEVICE_ERROR_MARKERS = ("cuda", "cudnn", "cublas", "out of memory", "nvrtc")


def _is_device_error(e: BaseException) -> bool:
    text = f"{type(e).__name__} {e}".lower()
    return any(m in text for m in DEVICE_ERROR_MARKERS)


class Engine:
    def __init__(self) -> None:
        self.device = None
        self.model = None
        preload_nvidia_libs()
        t0 = time.time()
        try:
            self.model = load_model("cuda")
            self.device = "cuda"
        except Exception as e:  # CUDA missing, out of memory, cuDNN load errors, ...
            log(f"cuda unavailable ({type(e).__name__}: {str(e)[:200]}); falling back to cpu")
            self.model = load_model("cpu")
            self.device = "cpu"
        log(f"device={self.device} model={MODEL} load_s={time.time() - t0:.2f}")

    def _fallback_to_cpu(self, reason: str) -> None:
        log(f"switching to cpu after error: {reason[:200]}")
        self.model = None
        self.model = load_model("cpu")
        self.device = "cpu"

    def transcribe(self, path: str) -> str:
        def run() -> str:
            segments, _info = self.model.transcribe(path, vad_filter=True, beam_size=5)
            return " ".join(s.text.strip() for s in segments).strip()

        try:
            return run()
        except Exception as e:
            # Only device errors justify switching to CPU; a bad audio file must just fail its request.
            if self.device != "cuda" or not _is_device_error(e):
                raise
            self._fallback_to_cpu(f"{type(e).__name__}: {e}")
            return run()


def main() -> int:
    engine = Engine()
    out = sys.stdout
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        req_id = None
        try:
            req = json.loads(line)
            req_id = req.get("id")
            path = req["path"]
            t0 = time.time()
            text = engine.transcribe(path)
            log(f"transcribed id={req_id} device={engine.device} secs={time.time() - t0:.2f} chars={len(text)}")
            resp = {"id": req_id, "text": text}
        except Exception as e:
            log(f"error id={req_id}: {type(e).__name__}: {str(e)[:300]}")
            resp = {"id": req_id, "error": f"{type(e).__name__}: {str(e)[:300]}"}
        out.write(json.dumps(resp, ensure_ascii=False) + "\n")
        out.flush()
    return 0


if __name__ == "__main__":
    sys.exit(main())
