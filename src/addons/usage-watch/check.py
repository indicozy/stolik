#!/usr/bin/env python3
"""usage-watch checker (plan 3.5). Reads the analyzer report of the usage-audit skill and prints one JSON object:
the window's call count, the cache-miss and Haiku long-prompt shares, and the alerts (percentages, never money).

Usage: python3 -I check.py --report PATH --from YYYY-MM-DD --days N

Stdlib only, plus the vendored pricing module of usage-audit. Message text is never read or printed: only the numeric
token fields, model, role, stream_id and timestamp are used.
"""

import argparse
import json
import os
import sys
from datetime import datetime, timedelta, timezone

VENDOR = os.path.join(os.path.expanduser("~"), ".claude", "skills", "usage-audit", "vendor")
sys.path.insert(0, VENDOR)
from cc_usage_study import pricing as P  # noqa: E402

HAIKU = "claude-haiku-5-5"
MAIN_GAP_MIN = 60.0  # a main call after this idle gap pays the cache write again
SUB_GAP_MIN = 5.0  # a subagent call after this idle gap does too
MISS_LIMIT = 0.05
HAIKU_LONG_PROMPT = 100_000  # Haiku 5.5's long-prompt tier applies above this many prompt tokens
HAIKU_LONG_LIMIT = 0.5
HAIKU_MIN_CALLS = 20


def parse_ts(value):
    """A UTC ISO timestamp (`...Z`) as an aware datetime."""
    t = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if t.tzinfo is None:
        t = t.replace(tzinfo=timezone.utc)
    return t


def local_window(day, days):
    """[start, end) of `days` local calendar days from `day` (YYYY-MM-DD), as aware datetimes."""
    start = datetime.strptime(day, "%Y-%m-%d")
    end = start + timedelta(days=days)
    return start.astimezone(), end.astimezone()


def call_cost(call):
    """List-price estimate of one call (the same per-request price rule as breakdown.py). 0.0 for an unknown model."""
    t = call["tokens"]
    price = P.price_row(call["model"], t["prompt_tokens"])
    if not price:
        return 0.0
    base, w5, w1, read, out = price
    return (
        t["input_tokens"] * base
        + t["cache_creation_5m_tokens"] * w5
        + t["cache_creation_1h_tokens"] * w1
        + t["cache_read_input_tokens"] * read
        + t["output_tokens"] * out
    )


def summarize(call_rows, day, days):
    """Shares over the window. Gaps come from ALL rows (sorted by stream and time), so a call right after midnight
    still sees the call before it. Shares are raw floats here; rounding happens only in the printed output."""
    start, end = local_window(day, days)
    timed = sorted(((c["stream_id"], parse_ts(c["timestamp"]), c) for c in call_rows), key=lambda x: (x[0], x[1]))
    calls = 0
    total = 0.0
    miss = 0.0
    haiku_calls = 0
    haiku_long = 0
    prev_stream = None
    prev_t = None
    for stream, t, c in timed:
        gap = (t - prev_t).total_seconds() / 60 if prev_t is not None and stream == prev_stream else None
        prev_stream, prev_t = stream, t
        if not (start <= t < end):
            continue
        calls += 1
        cost = call_cost(c)
        total += cost
        role = c["role"]
        if gap is not None and ((role == "main" and gap > MAIN_GAP_MIN) or (role == "subagent" and gap > SUB_GAP_MIN)):
            miss += cost
        if role == "subagent" and P.canonical_model_id(c["model"]) == HAIKU:
            haiku_calls += 1
            if c["tokens"]["prompt_tokens"] > HAIKU_LONG_PROMPT:
                haiku_long += 1
    return {
        "calls": calls,
        "total_cost": total,
        "miss_share": miss / total if total > 0 else 0.0,
        "haiku_calls": haiku_calls,
        "haiku_long_share": haiku_long / haiku_calls if haiku_calls else 0.0,
    }


def pct(share):
    return f"{share * 100:.1f}%"


def alerts_for(s):
    """Alert texts. Thresholds are compared on the raw shares, not on the rounded output."""
    out = []
    if s["miss_share"] > MISS_LIMIT:
        out.append(
            f"Cache misses after idle gaps: {pct(s['miss_share'])} of yesterday's usage (limit 5%). "
            "/compact or /clear with a handoff before leaving a big session; keep subagent waits under 4 min."
        )
    if s["haiku_long_share"] > HAIKU_LONG_LIMIT and s["haiku_calls"] >= HAIKU_MIN_CALLS:
        out.append(
            f"Haiku subagents: {pct(s['haiku_long_share'])} of calls over 100k context (5x tier). "
            "Split long jobs into fresh subagents; tail logs instead of reading them."
        )
    return out


def check(call_rows, day, days):
    """The printed object: window, counts, rounded shares and the alerts."""
    s = summarize(call_rows, day, days)
    last = (datetime.strptime(day, "%Y-%m-%d") + timedelta(days=days - 1)).strftime("%Y-%m-%d")
    return {
        "window": f"{day}..{last}",
        "calls": s["calls"],
        "miss_share": round(s["miss_share"], 4),
        "haiku_long_share": round(s["haiku_long_share"], 4),
        "haiku_calls": s["haiku_calls"],
        "alerts": alerts_for(s),
    }


def main(argv=None):
    ap = argparse.ArgumentParser(description="usage-watch threshold checker (prints one JSON object).")
    ap.add_argument("--report", required=True, help="analyzer report.json")
    ap.add_argument("--from", dest="day", required=True, help="first local day, YYYY-MM-DD")
    ap.add_argument("--days", type=int, required=True, help="number of local days, at least 1")
    a = ap.parse_args(argv)
    if a.days < 1:
        ap.error("--days must be at least 1")
    try:
        datetime.strptime(a.day, "%Y-%m-%d")
    except ValueError:
        ap.error("--from must be YYYY-MM-DD")
    with open(a.report, encoding="utf-8") as f:
        report = json.load(f)
    print(json.dumps(check(report["call_rows"], a.day, a.days)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
