"""usage-watch checker (src/addons/usage-watch/check.py): window filter, gaps across midnight, thresholds, CLI shape.

Timestamps are built from local calendar times, so the tests hold in any timezone. Scratch files (the CLI test) go under
the repo's .scratch/ and are removed afterwards.
"""

import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import unittest
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
CHECK = os.path.join(REPO, "src", "addons", "usage-watch", "check.py")

spec = importlib.util.spec_from_file_location("usage_check", CHECK)
check = importlib.util.module_from_spec(spec)
spec.loader.exec_module(check)

DAY = "2026-11-16"
MAIN = "claude-opus-5-5"
HAIKU = "claude-haiku-5-5"


def utc(day, hh, mm=0):
    """A local wall-clock time on `day` as a UTC ISO timestamp with Z."""
    t = datetime.strptime(day, "%Y-%m-%d").replace(hour=hh, minute=mm).astimezone(timezone.utc)
    return t.strftime("%Y-%m-%dT%H:%M:%S.000Z")


def row(role, model, stream, ts, prompt=20_000, out=300):
    return {
        "role": role,
        "model": model,
        "stream_id": stream,
        "timestamp": ts,
        "tokens": {
            "input_tokens": 2,
            "output_tokens": out,
            "prompt_tokens": prompt,
            "cache_creation_5m_tokens": 1000,
            "cache_creation_1h_tokens": 0,
            "cache_read_input_tokens": 0,
        },
    }


def local(day, hh, mm=0):
    """A naive local datetime on `day` (the wall clock the tests mean)."""
    return datetime.strptime(day, "%Y-%m-%d").replace(hour=hh, minute=mm)


def ts_local(dt):
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")


class WindowTests(unittest.TestCase):
    def test_only_calls_inside_the_local_day_are_counted(self):
        rows = [
            row("main", MAIN, "a", ts_local(local("2026-11-15", 23, 30))),
            row("main", MAIN, "b", ts_local(local(DAY, 0, 0))),
            row("main", MAIN, "c", ts_local(local(DAY, 12, 0))),
            row("main", MAIN, "d", ts_local(local("2026-11-17", 0, 0))),
        ]
        s = check.summarize(rows, DAY, 1)
        self.assertEqual(s["calls"], 2)

    def test_days_span_is_half_open_and_multi_day(self):
        rows = [
            row("main", MAIN, "a", ts_local(local(DAY, 9))),
            row("main", MAIN, "b", ts_local(local("2026-11-17", 23, 59))),
            row("main", MAIN, "c", ts_local(local("2026-11-18", 0, 0))),
        ]
        self.assertEqual(check.summarize(rows, DAY, 2)["calls"], 2)

    def test_window_label_is_inclusive_of_the_last_day(self):
        out = check.check([], DAY, 2)
        self.assertEqual(out["window"], "2026-11-16..2026-11-17")
        self.assertEqual(out["calls"], 0)
        self.assertEqual(out["miss_share"], 0.0)
        self.assertEqual(out["haiku_long_share"], 0.0)


class GapTests(unittest.TestCase):
    def test_a_gap_is_computed_across_midnight_from_the_previous_day(self):
        # The subagent's previous call is 23:57 the day before (outside the window). Its gap is 7 minutes, so it is a miss.
        rows = [
            row("subagent", HAIKU, "s", ts_local(local("2026-11-15", 23, 57)), prompt=20_000),
            row("subagent", HAIKU, "s", ts_local(local(DAY, 0, 4)), prompt=20_000),
            row("subagent", HAIKU, "s", ts_local(local(DAY, 0, 6)), prompt=20_000),  # gap 2 min: not a miss
        ]
        s = check.summarize(rows, DAY, 1)
        self.assertEqual(s["calls"], 2)
        self.assertAlmostEqual(s["miss_share"], 0.5)

    def test_first_call_of_a_stream_has_no_gap_and_is_not_a_miss(self):
        rows = [row("main", MAIN, "solo", ts_local(local(DAY, 10)))]
        self.assertEqual(check.summarize(rows, DAY, 1)["miss_share"], 0.0)

    def test_main_calls_miss_only_after_sixty_minutes(self):
        rows = [
            row("main", MAIN, "m", ts_local(local(DAY, 10, 0))),
            row("main", MAIN, "m", ts_local(local(DAY, 11, 30))),  # gap 90 min: miss
            row("main", MAIN, "m", ts_local(local(DAY, 11, 50))),  # gap 20 min: not
        ]
        self.assertAlmostEqual(check.summarize(rows, DAY, 1)["miss_share"], 1 / 3)

    def test_rows_are_ordered_by_time_not_file_order(self):
        rows = [
            row("main", MAIN, "m", ts_local(local(DAY, 11, 30))),
            row("main", MAIN, "m", ts_local(local(DAY, 10, 0))),
        ]
        self.assertAlmostEqual(check.summarize(rows, DAY, 1)["miss_share"], 0.5)

    def test_the_gap_of_a_call_counts_the_previous_call_even_when_unpriced(self):
        rows = [
            row("main", "claude-unknown-9", "m", ts_local(local(DAY, 9, 0))),
            row("main", MAIN, "m", ts_local(local(DAY, 10, 30))),  # gap 90 min from the unpriced call
        ]
        s = check.summarize(rows, DAY, 1)
        self.assertEqual(s["calls"], 2)
        self.assertAlmostEqual(s["miss_share"], 1.0)  # the priced call is the whole priced cost


class ThresholdTests(unittest.TestCase):
    def test_cache_miss_alert_above_five_percent(self):
        # 10 identical calls, 1 of them after a 6 h gap: 10%.
        rows = [row("main", MAIN, f"m{i}", ts_local(local(DAY, 9, i))) for i in range(9)]
        rows.append(row("main", MAIN, "m0", ts_local(local(DAY, 15, 0))))  # gap from 09:00 is 6 h: miss
        out = check.check(rows, DAY, 1)
        self.assertEqual(len(out["alerts"]), 1)
        self.assertTrue(out["alerts"][0].startswith("Cache misses after idle gaps: 10.0% of yesterday's usage (limit 5%)."))
        self.assertEqual(out["alerts"][0].count("/compact"), 1)

    def test_no_cache_alert_at_or_below_five_percent(self):
        # 1 miss out of 25 identical calls: 4%, under the limit.
        rows = [row("main", MAIN, f"m{i}", ts_local(local(DAY, 8, i))) for i in range(24)]
        rows.append(row("main", MAIN, "m0", ts_local(local(DAY, 16, 0))))
        out = check.check(rows, DAY, 1)
        self.assertAlmostEqual(out["miss_share"], 1 / 25, places=3)
        self.assertEqual(out["alerts"], [])

    def test_haiku_alert_needs_over_half_long_and_twenty_calls(self):
        rows = [
            row("subagent", HAIKU, f"h{i}", ts_local(local(DAY, 9)), prompt=150_000 if i < 15 else 5_000)
            for i in range(20)
        ]
        out = check.check(rows, DAY, 1)
        self.assertEqual(out["haiku_calls"], 20)
        self.assertEqual(out["haiku_long_share"], 0.75)
        self.assertEqual(len(out["alerts"]), 1)
        self.assertTrue(out["alerts"][0].startswith("Haiku subagents: 75.0% of calls over 100k context (5x tier)."))

    def test_haiku_alert_not_for_fewer_than_twenty_calls(self):
        rows = [row("subagent", HAIKU, f"h{i}", ts_local(local(DAY, 9)), prompt=150_000) for i in range(19)]
        out = check.check(rows, DAY, 1)
        self.assertEqual(out["haiku_long_share"], 1.0)
        self.assertEqual(out["alerts"], [])

    def test_exactly_one_hundred_thousand_prompt_tokens_is_not_long(self):
        rows = [row("subagent", HAIKU, f"h{i}", ts_local(local(DAY, 9)), prompt=100_000) for i in range(20)]
        self.assertEqual(check.summarize(rows, DAY, 1)["haiku_long_share"], 0.0)

    def test_no_money_in_the_output(self):
        rows = [row("main", MAIN, "m", ts_local(local(DAY, 9)))]
        out = check.check(rows, DAY, 1)
        self.assertEqual(sorted(out), ["alerts", "calls", "haiku_calls", "haiku_long_share", "miss_share", "window"])


class CliTests(unittest.TestCase):
    def test_prints_one_json_object_with_the_window_and_the_counts(self):
        scratch = os.path.join(REPO, ".scratch")
        os.makedirs(scratch, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=scratch) as d:
            path = os.path.join(d, "report.json")
            with open(path, "w", encoding="utf-8") as f:
                json.dump({"call_rows": [row("main", MAIN, "m", ts_local(local(DAY, 9)))]}, f)
            proc = subprocess.run(
                [sys.executable, "-I", CHECK, "--report", path, "--from", DAY, "--days", "1"],
                capture_output=True,
                text=True,
                check=True,
            )
        out = json.loads(proc.stdout)
        self.assertEqual(out["window"], f"{DAY}..{DAY}")
        self.assertEqual(out["calls"], 1)
        self.assertEqual(out["alerts"], [])
        self.assertEqual(proc.stdout.count("\n"), 1)

    def test_bad_days_are_refused(self):
        proc = subprocess.run(
            [sys.executable, "-I", CHECK, "--report", "/nonexistent", "--from", DAY, "--days", "0"],
            capture_output=True,
            text=True,
        )
        self.assertNotEqual(proc.returncode, 0)


if __name__ == "__main__":
    unittest.main()
