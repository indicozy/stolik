# Remind addon: design (approved by the owner 2026-11-19, via Telegram)

## Intent

The owner wants reminders for everyday tasks, and AI tasks that start at a given time. Both can be one-time, daily, or
on any repeating schedule. The bot runs on the PC, so nothing fires while the PC is off. Anything missed fires once when
the bot starts again.

## Goals

- `/remind <words>`: a reminder for the owner. It is sent to General with the buttons [Done] and [Snooze 1h].
- `/task <words>`: an AI task. At the due time it starts a full agent session in a project folder with the task as the
  first prompt, the same way `/to` does (the owner picked option A: a full session they can follow and approve in
  Telegram). It posts "Task started: …" in General. If the words name no known project, the owner picks a folder with
  buttons before saving.
- Plain words are parsed by one Haiku call (`claude -p`, no tools). The bot replies with what it understood, for example
  "Daily Mon–Fri 09:00, next: Thu 20 Nov 09:00", and the buttons [Save] [Cancel]. Nothing is saved without Save.
- `/reminders`: lists every saved item with its next run, and a [Delete] button for each.
- Missed runs: each missed item fires once at startup, marked "late (was due Tue 18 Nov 09:00)". A repeating item that
  missed several runs fires once, then waits for its next future run.

## Non-goals

- Editing: delete it and create it again.
- Time zones other than the PC's local time.
- Firing while the PC is off (a cloud scheduler is out of scope).

## Anti-goals

- A wrong parse that gets saved silently. Every save goes through the confirm buttons.
- A daily AI task that catches up by starting many sessions at boot.
- An AI task that ignores the quota pace: it checks the quota gate first (the `quota` request). If the gate refuses, it
  posts the reason in General and skips this run.

## Approaches

| Choice | Options | Picked |
|---|---|---|
| How AI tasks run | A) full session via `sessions.spawn`; B) headless `claude -p` that only posts a result | A (owner) |
| How items are created | A) plain words parsed by Haiku with confirm buttons; B) fixed cron syntax | A (owner) |
| Where it lives | v3 addon (separate program, manifest, NDJSON); or code in the v2 router | v3 addon. The live bot runs v3 (`stolik-wt/v3`, branch `v3/split`), and the host already has the command point, the schedule tick, buttons and `sessions.spawn` |

## Decided details

- Addon `remind` in `src/addons/remind/`. Manifest provides `command remind`, `command task`, `command reminders` and
  `schedule everyMinutes: 1`. Access: `message.text`, `messages.send`, `sessions.spawn`, `usage.record` (for the
  `quota` request). The owner enables it like the other built-ins.
- Schedule model: `{ kind: 'once', at: <epoch ms> }` or `{ kind: 'cron', expr: '<5-field cron>' }`, in local time. The
  next run is computed from local calendar parts, so 09:00 stays 09:00 across DST (the same method as
  `src/brain/schedule.ts`). The cron fields are minute, hour, day of month, month and day of week, with `*`, lists,
  ranges and steps. A small parser is written in the addon (no new dependency).
- Store: a JSON file in the addon's state folder (`STATE_DIR/remind/items.json`), written atomically (temp file plus
  rename). Each item has `id`, `kind` ('remind' | 'task'), `text`, `schedule`, `nextRun`, `createdAt`, and for a task
  the folder `dir`.
- Tick (every minute): every item with `nextRun <= now` fires. If it is more than 2 minutes past due, the message says
  "late (was due …)". Afterwards a `once` item is removed, and a `cron` item gets `nextRun` = the first run after now.
- Firing a task: send "Task started: <text> (in <folder>)" to get a message id, then the `spawn` request with
  `{ dir, prompt, messageId }`. If spawn fails (folder not trusted, spawn cap reached), send the error to General.
- Snooze 1h: a one-time copy of the reminder, due in one hour. Done: a toast, and nothing else changes.
- Parse prompt output (JSON only): `{ kind, text, schedule: {once: ISO local time} | {cron: expr}, project?: string }`.
  The addon checks the result: valid cron, a `once` time in the future, non-empty text. A failed check replies
  "Couldn't read a time from that. Try e.g. /remind tomorrow 9:00 call mom".
- Pending confirmations are kept in memory for 15 minutes, keyed by a short id in the button data (64-byte limit).

## Left to the builder

- The exact wording of the messages, and the list layout.
- The Haiku call details (model flag, timeout, JSON extraction), reusing the router's `claude -p` patterns.
- How a folder name in the task text is matched to `folders` (case-insensitive basename match is enough).
