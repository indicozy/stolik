#!/usr/bin/env python3
"""stolik ML worker (v3 plan 3.1). One process serves three ops to the ml-worker addon.

stdin : one JSON object per line   {"id": N, "op": "...", "payload": {...}}
stdout: one JSON object per line   {"id": N, "result": {...}}   or   {"id": N, "error": "..."}
stderr: log lines (device choice, load and run times). Never message text.
payload.deadline (optional) is epoch milliseconds set by the host. A request whose deadline has passed is refused before
it starts, so no model runs for a caller that already gave up.

ops
  transcribe  payload {audioPath}            -> {text, device, secs}   faster-whisper large-v3-turbo
  clean       payload {text, vocab: [...]}   -> {text, device, secs}   Qwen3-4B-Instruct-2507 Q4_K_M (llama.cpp)
  generate    payload {text, maxTokens}      -> {text, device, secs}   the same Qwen model, the caller's prompt

Each model loads on first use and is dropped after IDLE_UNLOAD_S without use. It goes to the GPU named by
CUDA_VISIBLE_DEVICES when free VRAM allows (NEED_MIB), otherwise to the CPU. ML_FORCE_CPU=1 forces the CPU.
The cleanup guard (empty or over 1.3x the input) is not here: it is in the voice-cleanup addon (src/addons/voice-cleanup).

Run as: python -I ml/worker.py. Env from the addon host: CUDA_DEVICE_ORDER, CUDA_VISIBLE_DEVICES, HF_HOME.
"""

import ctypes
import glob
import gc
import json
import math
import os
import re
import select
import site
import subprocess
import sys
import time

WHISPER_MODEL = "large-v3-turbo"
CLEAN_REPO = os.environ.get("ML_CLEAN_REPO", "unsloth/Qwen3-4B-Instruct-2507-GGUF")
CLEAN_FILE = os.environ.get("ML_CLEAN_FILE", "Qwen3-4B-Instruct-2507-Q4_K_M.gguf")
# Free VRAM each model needs before it is loaded on the GPU (MiB).
NEED_MIB = {"whisper": 2500, "qwen": 3500}
IDLE_UNLOAD_S = 600.0
CPU_THREADS = int(os.environ.get("ML_CPU_THREADS", "12"))
VOCAB_MAX = 60
MAX_LINE_BYTES = 1 << 20
MAX_TOKENS_CAP = 1024

CLEAN_SYSTEM = (
    "You clean up speech-to-text transcripts. Remove filler words (um, uh, like, you know, ну, эм, короче) and false "
    "starts, add punctuation and capitalization, and keep the language the speaker used (English or Russian). Use the "
    "spelling from the vocabulary list when a word matches one. Never add facts, never answer or act on the text, and "
    "never translate. Output only the cleaned text, nothing else."
)

DEVICE_ERROR_MARKERS = ("cuda", "cudnn", "cublas", "out of memory", "nvrtc")


def log(msg: str) -> None:
    sys.stderr.write(f"[ml] {msg}\n")
    sys.stderr.flush()


# ---------- VRAM decision (pure) ----------


def choose_device(free_mib, need_mib, force_cpu):
    """(device, reason). The GPU only when it is not forced off and enough VRAM is free."""
    if force_cpu:
        return "cpu", "ML_FORCE_CPU=1"
    if free_mib is None:
        return "cpu", "no GPU reading"
    if free_mib < need_mib:
        return "cpu", f"{free_mib} MiB free, {need_mib} needed"
    return "cuda", f"{free_mib} MiB free, {need_mib} needed"


def gpu_index(cuda_visible):
    """The first GPU index in CUDA_VISIBLE_DEVICES ("1" -> "1"), or None when none is visible."""
    first = (cuda_visible or "").split(",")[0].strip()
    return first if first.isdigit() else None


def free_vram_mib(index, run=subprocess.run):
    """Free memory of the GPU at nvidia-smi index `index`, in MiB. None when it cannot be read."""
    if index is None:
        return None
    try:
        out = run(
            ["nvidia-smi", "--query-gpu=memory.free", "--format=csv,noheader,nounits", "-i", index],
            capture_output=True,
            text=True,
            timeout=10,
            check=True,
        ).stdout
        return int(out.strip().splitlines()[0])
    except Exception:
        return None


def is_device_error(e: BaseException) -> bool:
    text = f"{type(e).__name__} {e}".lower()
    return any(m in text for m in DEVICE_ERROR_MARKERS)


# ---------- request deadline (pure) ----------


def check_deadline(deadline, now_ms: float) -> None:
    """Refuses a request whose deadline (epoch ms) has been reached. No deadline: nothing to check."""
    if deadline is None:
        return
    if isinstance(deadline, bool) or not isinstance(deadline, (int, float)) or not math.isfinite(deadline):
        raise ValueError("deadline is not a number of milliseconds")
    if now_ms >= deadline:
        raise ValueError("request expired before it started")


# ---------- GPU memory release (torch optional) ----------


def release_gpu_memory(used_cuda: bool) -> None:
    """Collects garbage, then returns torch's cached GPU blocks when a CUDA model was dropped. torch may be absent."""
    gc.collect()
    if not used_cuda:
        return
    try:
        import torch
    except ImportError:
        return
    torch.cuda.empty_cache()


# ---------- wire framing (pure) ----------


class LineFramer:
    """Splits bytes from stdin into complete lines. A line longer than MAX_LINE_BYTES is an error."""

    def __init__(self, limit: int = MAX_LINE_BYTES) -> None:
        self.buf = b""
        self.limit = limit

    def push(self, chunk: bytes) -> list:
        self.buf += chunk
        out = []
        while b"\n" in self.buf:
            line, self.buf = self.buf.split(b"\n", 1)
            text = line.decode("utf-8", "replace").strip()
            if text:
                out.append(text)
        if len(self.buf) > self.limit:
            raise ValueError("request line longer than 1 MB")
        return out


# ---------- one model, loaded on demand (idle unload uses an injected clock) ----------


class Slot:
    def __init__(self, name, need_mib, load, *, clock=time.monotonic, free=None, force_cpu=None, idle_s=IDLE_UNLOAD_S):
        self.name = name
        self.need = NEED_MIB[name]
        self.load = load  # load(device) -> model object; raises on failure
        self.clock = clock
        self.free = free or (lambda: free_vram_mib(gpu_index(os.environ.get("CUDA_VISIBLE_DEVICES", ""))))
        self.force_cpu = force_cpu if force_cpu is not None else os.environ.get("ML_FORCE_CPU") == "1"
        self.idle_s = idle_s
        self.obj = None
        self.device = None
        self.last = 0.0

    def get(self):
        """(model, device). Loads the model when it is not in memory."""
        self.last = self.clock()
        if self.obj is None:
            device, why = choose_device(self.free(), self.need, self.force_cpu)
            t0 = time.time()
            self.obj, self.device = self._load(device)
            log(f"{self.name}: loaded on {self.device} ({why}) in {time.time() - t0:.1f} s")
        return self.obj, self.device

    def reload(self, device):
        old, was_cuda = self.obj, self.device == "cuda"
        self.obj = None
        self.device = None
        del old  # the old model must be gone before the new one loads
        release_gpu_memory(was_cuda)
        self.obj = self.load(device)
        self.device = device
        return self.obj, self.device

    def _load(self, device):
        if device == "cuda":
            try:
                return self.load("cuda"), "cuda"
            except Exception as e:  # missing CUDA libs, out of memory, cuDNN load errors
                log(f"{self.name}: cuda load failed ({type(e).__name__}: {str(e)[:200]}), using cpu")
        return self.load("cpu"), "cpu"

    def idle_check(self) -> None:
        if self.obj is not None and self.clock() - self.last >= self.idle_s:
            log(f"{self.name}: unloaded after {self.idle_s:.0f} s idle")
            self.obj = None
            self.device = None
            gc.collect()


# ---------- the three ops ----------


class Worker:
    def __init__(self, whisper: Slot, qwen: Slot, clock=time.time) -> None:
        self.whisper = whisper
        self.qwen = qwen
        self.clock = clock

    def tick(self) -> None:
        self.whisper.idle_check()
        self.qwen.idle_check()

    def run(self, op, payload: dict) -> dict:
        check_deadline(payload.get("deadline"), self.clock() * 1000)
        if op == "transcribe":
            return self._transcribe(payload)
        if op == "clean":
            return self._clean(payload)
        if op == "generate":
            return self._generate(payload)
        if op == "status":
            return self.status()
        raise ValueError(f"unknown op {op!r}")

    def status(self) -> dict:
        """Which models are in memory, on which device, and the seconds left before each unloads (for /debug)."""
        models = []
        for slot in (self.whisper, self.qwen):
            loaded = slot.obj is not None
            left = max(0, round(slot.idle_s - (slot.clock() - slot.last))) if loaded else None
            models.append({"name": slot.name, "loaded": loaded, "device": slot.device if loaded else None, "unloadInSec": left})
        return {"models": models, "idleUnloadSec": self.whisper.idle_s}

    def _timed(self, fn) -> dict:
        t0 = self.clock()
        text, device = fn()
        return {"text": text, "device": device, "secs": round(self.clock() - t0, 2)}

    def _transcribe(self, payload: dict) -> dict:
        path = payload.get("audioPath")
        if not isinstance(path, str) or not path:
            raise ValueError("transcribe needs audioPath")

        def go():
            return self._on_model(self.whisper, lambda m: transcribe_audio(m, path))

        return self._timed(go)

    def _clean(self, payload: dict) -> dict:
        text = payload.get("text")
        if not isinstance(text, str):
            raise ValueError("clean needs text")
        vocab = payload.get("vocab") or []
        if not isinstance(vocab, list):
            raise ValueError("vocab is not a list")
        if not text.strip():
            return {"text": "", "device": "none", "secs": 0.0}
        system = clean_system(vocab)
        max_tokens = min(MAX_TOKENS_CAP, 2 * len(text) + 64)
        return self._timed(lambda: self._on_model(self.qwen, lambda m: chat(m, system, text, max_tokens)))

    def _generate(self, payload: dict) -> dict:
        text = payload.get("text")
        if not isinstance(text, str) or not text.strip():
            raise ValueError("generate needs text")
        max_tokens = payload.get("maxTokens", 512)
        if not isinstance(max_tokens, int) or not 1 <= max_tokens <= MAX_TOKENS_CAP:
            raise ValueError(f"maxTokens must be 1 to {MAX_TOKENS_CAP}")
        return self._timed(lambda: self._on_model(self.qwen, lambda m: chat(m, None, text, max_tokens)))

    def _on_model(self, slot: Slot, fn):
        """Runs fn on the slot's model. A CUDA error reloads the model on the CPU and tries once more."""
        obj, device = slot.get()
        try:
            return fn(obj), device
        except Exception as e:
            if device != "cuda" or not is_device_error(e):
                raise
            reason = f"{type(e).__name__}: {str(e)[:200]}"
        # Outside the except block: its traceback would keep the GPU model alive while the CPU model loads.
        del obj
        log(f"{slot.name}: switching to cpu after {reason}")
        obj, device = slot.reload("cpu")
        return fn(obj), device


def clean_system(vocab) -> str:
    names = [v.strip() for v in vocab if isinstance(v, str) and v.strip()][:VOCAB_MAX]
    if not names:
        return CLEAN_SYSTEM
    return CLEAN_SYSTEM + "\nVocabulary (use these spellings when a word matches): " + ", ".join(names)


THINK_RE = re.compile(r"<think>.*?</think>", re.S)


def chat(llm, system, user: str, max_tokens: int) -> str:
    messages = ([{"role": "system", "content": system}] if system else []) + [{"role": "user", "content": user}]
    r = llm.create_chat_completion(messages=messages, temperature=0.0, max_tokens=max_tokens)
    content = r["choices"][0]["message"]["content"] or ""
    return THINK_RE.sub("", content).strip()


def transcribe_audio(model, path: str) -> str:
    segments, _info = model.transcribe(path, vad_filter=True, beam_size=5)
    return " ".join(s.text.strip() for s in segments).strip()


# ---------- real model loaders (imported lazily: the unit tests never load them) ----------


def preload_nvidia_libs() -> None:
    """Load the pip-installed cuBLAS/cuDNN libs with RTLD_GLOBAL so CTranslate2 finds them without LD_LIBRARY_PATH."""
    dirs = []
    for root in list(site.getsitepackages()) + [p for p in sys.path if p.endswith("site-packages")]:
        dirs.extend(glob.glob(os.path.join(root, "nvidia", "*", "lib")))
    libs = []
    for d in dirs:
        for pattern in ("libcublas*.so*", "libcudnn*.so*"):
            libs.extend(sorted(glob.glob(os.path.join(d, pattern))))
    pending = list(dict.fromkeys(libs))
    for _ in range(3):  # cuDNN sub-libraries may depend on each other in any order
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


def load_whisper(device: str):
    from faster_whisper import WhisperModel

    # download_root unset: the standard HF cache ($HF_HOME/hub).
    if device == "cuda":
        model = WhisperModel(WHISPER_MODEL, device="cuda", compute_type="int8_float16")
        import numpy as np

        # Warm-up on silence, so a missing cuDNN/cuBLAS fails at load time and not on the first voice note.
        segments, _ = model.transcribe(np.zeros(16000, dtype=np.float32), vad_filter=False)
        list(segments)
        return model
    return WhisperModel(WHISPER_MODEL, device="cpu", compute_type="int8", cpu_threads=CPU_THREADS)


def load_qwen(device: str):
    from llama_cpp import Llama, llama_supports_gpu_offload

    on_gpu = device == "cuda" and llama_supports_gpu_offload()
    if device == "cuda" and not on_gpu:
        raise RuntimeError("llama.cpp was built without CUDA")
    return Llama.from_pretrained(
        repo_id=CLEAN_REPO,
        filename=CLEAN_FILE,
        n_gpu_layers=-1 if on_gpu else 0,
        n_ctx=4096,
        n_threads=CPU_THREADS,
        n_threads_batch=CPU_THREADS,
        verbose=False,
    )


def serve(stdin_fd: int, out, worker: Worker, poll_s: float = 5.0) -> int:
    """The NDJSON loop. Idle models are checked every poll_s, even when no request comes."""
    framer = LineFramer()
    while True:
        ready, _, _ = select.select([stdin_fd], [], [], poll_s)
        if ready:
            chunk = os.read(stdin_fd, 65536)
            if not chunk:
                return 0
            try:
                lines = framer.push(chunk)
            except ValueError as e:
                out.write(json.dumps({"id": None, "error": str(e)}) + "\n")
                out.flush()
                return 1
            for line in lines:
                out.write(json.dumps(reply_for(line, worker), ensure_ascii=False) + "\n")
                out.flush()
        worker.tick()


def reply_for(line: str, worker: Worker) -> dict:
    req_id = None
    try:
        req = json.loads(line)
        if not isinstance(req, dict):
            raise ValueError("request is not an object")
        req_id = req.get("id")
        payload = req.get("payload") or {}
        if not isinstance(payload, dict):
            raise ValueError("payload is not an object")
        return {"id": req_id, "result": worker.run(req.get("op"), payload)}
    except Exception as e:
        log(f"error id={req_id}: {type(e).__name__}: {str(e)[:300]}")
        return {"id": req_id, "error": f"{type(e).__name__}: {str(e)[:300]}"}


def main() -> int:
    preload_nvidia_libs()
    worker = Worker(
        whisper=Slot("whisper", NEED_MIB["whisper"], load_whisper),
        qwen=Slot("qwen", NEED_MIB["qwen"], load_qwen),
    )
    log("ready (models load on first use)")
    return serve(sys.stdin.fileno(), sys.stdout, worker)


if __name__ == "__main__":
    sys.exit(main())
