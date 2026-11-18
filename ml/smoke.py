#!/usr/bin/env python3
"""ML worker smoke test (v3 plan 3.1). Runs ml/worker.py as a child, the way the ml-worker addon does, and prints the
device and the seconds of each op.

  python3 ml/smoke.py          GPU run (RTX 4060 only): transcribe one voice file, clean two messy sentences, generate.
  python3 ml/smoke.py --cpu    CPU run (ML_FORCE_CPU=1): clean the two sentences only, to record CPU cleanup latency.

Both runs go through `nice -n 19 taskset -c 8-19` (the desktop keeps CPUs 0-7). The GPU run sets
CUDA_DEVICE_ORDER=PCI_BUS_ID CUDA_VISIBLE_DEVICES=1 (nvidia-smi index 1, the 4060; never the 5060 Ti).

No real voice notes are read: the sample is synthesized with espeak-ng and ffmpeg into ml/.smoke/ (git-ignored).
Override the cleanup model for a second try with ML_CLEAN_REPO and ML_CLEAN_FILE (for example a Qwen3-1.7B GGUF).
"""

import json
import os
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
PY = os.path.join(HERE, ".venv", "bin", "python")
WORKER = os.path.join(HERE, "worker.py")
SMOKE = os.path.join(HERE, ".smoke")
PIN = ["nice", "-n", "19", "taskset", "-c", "8-19"]

EN_TEXT = "so um yeah I I think the the meeting is uh is at, like, three tomorrow, no wait, four"
RU_TEXT = "ну короче я эм думаю что встреча эм в четыре нет в пять"
EN_SPEECH = "um yeah I I think the the meeting is uh at like three tomorrow no wait four"


def ensure_sample() -> str:
    """ml/.smoke/sample-en.oga: synthesized speech, made once."""
    os.makedirs(SMOKE, exist_ok=True)
    oga = os.path.join(SMOKE, "sample-en.oga")
    if os.path.exists(oga):
        return oga
    wav = os.path.join(SMOKE, "sample-en.wav")
    subprocess.run(["espeak-ng", "-v", "en-us", "-s", "150", "-w", wav, EN_SPEECH], check=True)
    subprocess.run(
        ["ffmpeg", "-y", "-loglevel", "error", "-i", wav, "-c:a", "libopus", "-b:a", "32k", oga],
        check=True,
    )
    os.remove(wav)
    return oga


class Child:
    def __init__(self, env: dict) -> None:
        cmd = PIN + [PY, "-I", WORKER]
        self.p = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=sys.stderr, env=env, text=True)
        self.seq = 0

    def call(self, op: str, payload: dict) -> dict:
        self.seq += 1
        t0 = time.time()
        self.p.stdin.write(json.dumps({"id": self.seq, "op": op, "payload": payload}) + "\n")
        self.p.stdin.flush()
        line = self.p.stdout.readline()
        wall = time.time() - t0
        if not line:
            raise RuntimeError("worker exited")
        reply = json.loads(line)
        if "error" in reply:
            raise RuntimeError(f"{op}: {reply['error']}")
        r = reply["result"]
        r["wall_s"] = round(wall, 2)
        return r

    def close(self) -> None:
        if self.p.stdin:
            self.p.stdin.close()
        self.p.wait(timeout=60)


def env_for(cpu: bool) -> dict:
    env = dict(os.environ)
    env.setdefault("HF_HOME", "/mnt/ai_models/hf")
    if cpu:
        env["ML_FORCE_CPU"] = "1"
        env["CUDA_VISIBLE_DEVICES"] = ""
    else:
        env["ML_FORCE_CPU"] = "0"
        env["CUDA_DEVICE_ORDER"] = "PCI_BUS_ID"
        env["CUDA_VISIBLE_DEVICES"] = "1"
    return env


def show(label: str, r: dict) -> None:
    text = r.get("text", "")
    print(f"{label:<22} device={r.get('device')} secs={r.get('secs')} wall_s={r.get('wall_s')}")
    if text:
        print(f"{'':<22} -> {text}")


def main() -> int:
    cpu = "--cpu" in sys.argv[1:]
    if not os.path.exists(PY):
        print(f"missing venv: {PY}", file=sys.stderr)
        return 2
    print(f"mode: {'cpu (ML_FORCE_CPU=1)' if cpu else 'gpu (CUDA_VISIBLE_DEVICES=1, PCI_BUS_ID)'}")
    print(f"clean model: {os.environ.get('ML_CLEAN_REPO', 'unsloth/Qwen3-4B-Instruct-2507-GGUF')} / "
          f"{os.environ.get('ML_CLEAN_FILE', 'Qwen3-4B-Instruct-2507-Q4_K_M.gguf')}")
    child = Child(env_for(cpu))
    try:
        vocab = ["Alpha", "Tarasov"]
        if not cpu:
            show("transcribe sample-en", child.call("transcribe", {"audioPath": ensure_sample()}))
        show("clean en (messy)", child.call("clean", {"text": EN_TEXT, "vocab": vocab}))
        show("clean ru (messy)", child.call("clean", {"text": RU_TEXT, "vocab": vocab}))
        if not cpu:
            show("generate", child.call("generate", {"text": "Say hello in five words.", "maxTokens": 40}))
    finally:
        child.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
