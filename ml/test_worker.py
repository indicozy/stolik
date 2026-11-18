"""Unit tests for ml/worker.py: VRAM decision, wire framing, idle unload (fake clock), op dispatch. No models load.

Run: python3 -I -m unittest discover -s ml -p 'test_*.py'   (stdlib only; no venv needed)
"""

import json
import os
import sys
import types
import unittest

import worker


class FakeClock:
    def __init__(self) -> None:
        self.t = 1000.0

    def __call__(self) -> float:
        return self.t


class FakeModel:
    def __init__(self, device: str) -> None:
        self.device = device

    def create_chat_completion(self, messages, temperature, max_tokens):
        return {"choices": [{"message": {"content": f"cleaned on {self.device}"}}]}


def fake_slot(name: str, clock: FakeClock, *, free=None, force_cpu=False, fail_cuda=False, idle_s=600.0):
    loads = []

    def load(device: str):
        if device == "cuda" and fail_cuda:
            raise RuntimeError("cublas load failed")
        loads.append(device)
        return FakeModel(device)

    slot = worker.Slot(name, worker.NEED_MIB[name], load, clock=clock, free=lambda: free, force_cpu=force_cpu, idle_s=idle_s)
    slot.loads = loads
    return slot


class VramDecision(unittest.TestCase):
    def test_enough_free_vram_uses_gpu(self) -> None:
        self.assertEqual(worker.choose_device(7874, 2500, False)[0], "cuda")
        self.assertEqual(worker.choose_device(3500, 3500, False)[0], "cuda")

    def test_too_little_free_vram_uses_cpu(self) -> None:
        self.assertEqual(worker.choose_device(3499, 3500, False)[0], "cpu")
        self.assertEqual(worker.choose_device(2000, 2500, False)[0], "cpu")

    def test_no_reading_uses_cpu(self) -> None:
        device, why = worker.choose_device(None, 2500, False)
        self.assertEqual(device, "cpu")
        self.assertIn("no GPU reading", why)

    def test_force_cpu_wins_over_free_vram(self) -> None:
        device, why = worker.choose_device(7874, 2500, True)
        self.assertEqual(device, "cpu")
        self.assertEqual(why, "ML_FORCE_CPU=1")

    def test_gpu_index_is_the_first_visible_device(self) -> None:
        self.assertEqual(worker.gpu_index("1"), "1")
        self.assertEqual(worker.gpu_index("1,0"), "1")
        self.assertIsNone(worker.gpu_index(""))
        self.assertIsNone(worker.gpu_index(None))
        self.assertIsNone(worker.gpu_index("GPU-abc"))

    def test_free_vram_reads_the_named_index_only(self) -> None:
        seen = []

        class Done:
            stdout = "7874\n"

        def run(argv, **kw):
            seen.append(argv)
            return Done()

        self.assertEqual(worker.free_vram_mib("1", run=run), 7874)
        self.assertIn("-i", seen[0])
        self.assertEqual(seen[0][seen[0].index("-i") + 1], "1")

    def test_free_vram_failure_is_none(self) -> None:
        def run(argv, **kw):
            raise FileNotFoundError("nvidia-smi")

        self.assertIsNone(worker.free_vram_mib("1", run=run))
        self.assertIsNone(worker.free_vram_mib(None, run=run))


class Framing(unittest.TestCase):
    def test_partial_line_waits_for_its_newline(self) -> None:
        f = worker.LineFramer()
        self.assertEqual(f.push(b'{"id":1,'), [])
        self.assertEqual(f.push(b'"op":"clean"}\n'), ['{"id":1,"op":"clean"}'])

    def test_several_lines_in_one_chunk_and_blank_lines_skipped(self) -> None:
        f = worker.LineFramer()
        self.assertEqual(f.push(b'{"id":1}\n\n  \n{"id":2}\n'), ['{"id":1}', '{"id":2}'])

    def test_multibyte_text_split_across_chunks(self) -> None:
        f = worker.LineFramer()
        raw = '{"text":"привет"}\n'.encode("utf-8")
        self.assertEqual(f.push(raw[:9]), [])
        self.assertEqual(f.push(raw[9:]), ['{"text":"привет"}'])

    def test_over_limit_line_is_an_error(self) -> None:
        f = worker.LineFramer(limit=10)
        with self.assertRaises(ValueError):
            f.push(b"x" * 11)


class IdleUnload(unittest.TestCase):
    def test_unloads_after_idle_and_reloads_on_next_use(self) -> None:
        clock = FakeClock()
        slot = fake_slot("qwen", clock, free=7000)
        slot.get()
        self.assertEqual(slot.loads, ["cuda"])
        clock.t += 599
        slot.idle_check()
        self.assertIsNotNone(slot.obj)
        clock.t += 1
        slot.idle_check()
        self.assertIsNone(slot.obj)
        slot.get()
        self.assertEqual(slot.loads, ["cuda", "cuda"])

    def test_use_resets_the_idle_timer(self) -> None:
        clock = FakeClock()
        slot = fake_slot("whisper", clock, free=7000)
        slot.get()
        clock.t += 500
        slot.get()
        clock.t += 500
        slot.idle_check()
        self.assertIsNotNone(slot.obj)

    def test_each_model_unloads_on_its_own(self) -> None:
        clock = FakeClock()
        whisper = fake_slot("whisper", clock, free=7000)
        qwen = fake_slot("qwen", clock, free=7000)
        whisper.get()
        clock.t += 300
        qwen.get()
        clock.t += 301
        whisper.idle_check()
        qwen.idle_check()
        self.assertIsNone(whisper.obj)
        self.assertIsNotNone(qwen.obj)

    def test_cuda_load_failure_falls_back_to_cpu(self) -> None:
        clock = FakeClock()
        slot = fake_slot("whisper", clock, free=7000, fail_cuda=True)
        _, device = slot.get()
        self.assertEqual(device, "cpu")
        self.assertEqual(slot.loads, ["cpu"])


class Dispatch(unittest.TestCase):
    def worker_with(self, clock: FakeClock, *, free: int) -> worker.Worker:
        return worker.Worker(
            whisper=fake_slot("whisper", clock, free=free),
            qwen=fake_slot("qwen", clock, free=free),
            clock=clock,
        )

    def test_transcribe_needs_audio_path(self) -> None:
        w = self.worker_with(FakeClock(), free=0)
        with self.assertRaises(ValueError):
            w.run("transcribe", {})

    def test_clean_empty_text_skips_the_model(self) -> None:
        clock = FakeClock()
        w = self.worker_with(clock, free=7000)
        r = w.run("clean", {"text": "   ", "vocab": []})
        self.assertEqual(r["text"], "")
        self.assertEqual(w.qwen.loads, [])

    def test_clean_vocab_must_be_a_list(self) -> None:
        w = self.worker_with(FakeClock(), free=7000)
        with self.assertRaises(ValueError):
            w.run("clean", {"text": "hi", "vocab": "Alpha"})

    def test_generate_checks_max_tokens(self) -> None:
        w = self.worker_with(FakeClock(), free=7000)
        with self.assertRaises(ValueError):
            w.run("generate", {"text": "hi", "maxTokens": 0})
        with self.assertRaises(ValueError):
            w.run("generate", {"text": "hi", "maxTokens": 99999})

    def test_status_reports_loaded_models_and_idle_countdown(self) -> None:
        clock = FakeClock()
        w = self.worker_with(clock, free=7000)
        st = w.run("status", {})
        self.assertEqual(st["idleUnloadSec"], 600.0)
        self.assertEqual([m["name"] for m in st["models"]], ["whisper", "qwen"])
        self.assertTrue(all(not m["loaded"] and m["device"] is None and m["unloadInSec"] is None for m in st["models"]))
        w.whisper.get()
        clock.t += 100
        st = w.run("status", {})
        whisper = st["models"][0]
        self.assertTrue(whisper["loaded"])
        self.assertEqual(whisper["device"], "cuda")
        self.assertEqual(whisper["unloadInSec"], 500)
        self.assertFalse(st["models"][1]["loaded"])

    def test_unknown_op(self) -> None:
        w = self.worker_with(FakeClock(), free=7000)
        with self.assertRaises(ValueError):
            w.run("rerank", {})

    def test_clean_system_prompt_lists_the_vocab(self) -> None:
        s = worker.clean_system(["Alpha", "  ", 3, "Тарас"])
        self.assertIn("Alpha, Тарас", s)
        self.assertEqual(worker.clean_system([]), worker.CLEAN_SYSTEM)

    def test_reply_for_ok_error_and_bad_json(self) -> None:
        clock = FakeClock()
        w = self.worker_with(clock, free=7000)
        ok = worker.reply_for(json.dumps({"id": 4, "op": "clean", "payload": {"text": ""}}), w)
        self.assertEqual(ok["id"], 4)
        self.assertEqual(ok["result"]["text"], "")
        bad = worker.reply_for(json.dumps({"id": 5, "op": "nope", "payload": {}}), w)
        self.assertEqual(bad["id"], 5)
        self.assertIn("error", bad)
        junk = worker.reply_for("not json", w)
        self.assertIsNone(junk["id"])
        self.assertIn("error", junk)

    def test_serve_answers_each_line_then_stops_at_eof(self) -> None:
        clock = FakeClock()
        w = self.worker_with(clock, free=7000)
        r, wfd = os.pipe()
        os.write(wfd, b'{"id":1,"op":"clean","payload":{"text":""}}\n{"id":2,"op":"x"}\n')
        os.close(wfd)

        class Out:
            def __init__(self) -> None:
                self.lines = []

            def write(self, s: str) -> None:
                self.lines.append(s)

            def flush(self) -> None:
                pass

        out = Out()
        try:
            self.assertEqual(worker.serve(r, out, w, poll_s=0.01), 0)
        finally:
            os.close(r)
        replies = [json.loads(s) for s in out.lines]
        self.assertEqual([x["id"] for x in replies], [1, 2])
        self.assertIn("result", replies[0])
        self.assertIn("error", replies[1])


class Deadline(unittest.TestCase):
    NOW_MS = 1000.0 * 1000  # FakeClock is in seconds

    def worker_with(self, clock: FakeClock) -> worker.Worker:
        return worker.Worker(
            whisper=fake_slot("whisper", clock, free=7000),
            qwen=fake_slot("qwen", clock, free=7000),
            clock=clock,
        )

    def test_expired_request_is_dropped_before_any_model_runs(self) -> None:
        clock = FakeClock()
        w = self.worker_with(clock)
        with self.assertRaises(ValueError) as cm:
            w.run("clean", {"text": "hi", "deadline": self.NOW_MS - 1})
        self.assertIn("expired before it started", str(cm.exception))
        self.assertEqual(w.qwen.loads, [])
        self.assertIsNone(w.qwen.obj)

    def test_deadline_reached_now_counts_as_expired(self) -> None:
        w = self.worker_with(FakeClock())
        with self.assertRaises(ValueError):
            w.run("generate", {"text": "hi", "deadline": self.NOW_MS})
        self.assertEqual(w.qwen.loads, [])

    def test_future_deadline_runs(self) -> None:
        clock = FakeClock()
        w = self.worker_with(clock)
        r = w.run("clean", {"text": "hi", "deadline": self.NOW_MS + 30_000})
        self.assertEqual(r["text"], "cleaned on cuda")
        self.assertEqual(w.qwen.loads, ["cuda"])

    def test_request_without_deadline_runs(self) -> None:
        clock = FakeClock()
        w = self.worker_with(clock)
        r = w.run("clean", {"text": "hi"})
        self.assertEqual(r["text"], "cleaned on cuda")
        self.assertEqual(w.qwen.loads, ["cuda"])

    def test_bad_deadline_is_refused(self) -> None:
        w = self.worker_with(FakeClock())
        for bad in ("soon", True, float("nan"), [1]):
            with self.assertRaises(ValueError):
                w.run("clean", {"text": "hi", "deadline": bad})
        self.assertEqual(w.qwen.loads, [])

    def test_expired_reply_keeps_the_id(self) -> None:
        w = self.worker_with(FakeClock())
        reply = worker.reply_for(
            json.dumps({"id": 9, "op": "clean", "payload": {"text": "hi", "deadline": self.NOW_MS - 5}}), w
        )
        self.assertEqual(reply["id"], 9)
        self.assertIn("expired before it started", reply["error"])


class ReleaseOrder(unittest.TestCase):
    def test_gpu_model_is_released_before_the_cpu_model_loads(self) -> None:
        events = []

        class GpuModel:
            def __init__(self, device):
                self.device = device

            def __del__(self):
                events.append(f"released {self.device}")

            def create_chat_completion(self, messages, temperature, max_tokens):
                if self.device == "cuda":
                    raise RuntimeError("CUDA error: out of memory")
                return {"choices": [{"message": {"content": "ok"}}]}

        def load(device):
            events.append(f"load {device}")
            return GpuModel(device)

        clock = FakeClock()
        slot = worker.Slot("qwen", worker.NEED_MIB["qwen"], load, clock=clock, free=lambda: 7000, force_cpu=False)
        w = worker.Worker(whisper=fake_slot("whisper", clock, free=0), qwen=slot, clock=clock)
        r = w.run("clean", {"text": "hi"})
        self.assertEqual(r["device"], "cpu")
        self.assertEqual(events, ["load cuda", "released cuda", "load cpu"])

    def test_release_empties_torch_cache_only_after_cuda(self) -> None:
        calls = []

        class Cuda:
            @staticmethod
            def empty_cache():
                calls.append("empty_cache")

        fake_torch = types.ModuleType("torch")
        fake_torch.cuda = Cuda
        old = sys.modules.get("torch")
        sys.modules["torch"] = fake_torch
        try:
            worker.release_gpu_memory(False)
            self.assertEqual(calls, [])
            worker.release_gpu_memory(True)
            self.assertEqual(calls, ["empty_cache"])
        finally:
            if old is None:
                sys.modules.pop("torch", None)
            else:
                sys.modules["torch"] = old

    def test_release_works_without_torch(self) -> None:
        old = sys.modules.get("torch", "missing")
        sys.modules["torch"] = None  # import torch raises ImportError
        try:
            worker.release_gpu_memory(True)
        finally:
            if old == "missing":
                sys.modules.pop("torch", None)
            else:
                sys.modules["torch"] = old


if __name__ == "__main__":
    unittest.main()
