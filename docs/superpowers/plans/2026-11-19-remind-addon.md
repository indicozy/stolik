# Remind addon Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A v3 addon `remind` with `/remind`, `/task` and `/reminders`: reminders and AI tasks, once or on a repeating schedule, with catch-up after the PC was off.

**Architecture:** Pure modules for the schedule maths (`cron.ts`), the item store and due logic (`store.ts`) and the Haiku parse check (`parse.ts`). An I/O layer (`service.ts`) answers the host's `command`, `callback` and `tick` ops through the addon SDK, and `main.ts` wires it up. Same layout and test style as `src/addons/workers/`.

**Tech Stack:** TypeScript on Node 24 (`--experimental-strip-types`), `node:test`, the addon SDK `src/addons/sdk.ts` (`AddonPeer`, `startAddon`). No new dependencies.

**Spec:** `docs/superpowers/specs/2026-11-19-remind-addon-design.md`

## Global Constraints

- Worktree `~/Documents/projects/stolik-wt/v3-remind`, branch `v3/remind`. Never push.
- Heavy commands pinned: `CARGO_BUILD_JOBS=12 $(ai-resources prefix) npm run build` / `$(ai-resources prefix) node --test --experimental-strip-types test/remind-*.test.ts`. Use `npm ci` once first if `node_modules` is missing (pinned too).
- Local time everywhere; next-run maths from local calendar parts (`new Date(y, m, d, h, min)`), as `src/brain/schedule.ts` does.
- Button `data` must pass `callbackDataFits('remind', data)` from `src/addons-host/protocol.ts` (64-byte Telegram limit).
- Late threshold: 2 minutes. Snooze: 1 hour. Pending confirmations expire after 15 minutes. Tick: every 1 minute.
- Logs go to stderr only; stdout is the protocol channel.
- Message texts (exact): parse failure `Couldn't read a time from that. Try e.g. /remind tomorrow 9:00 call mom`; late suffix ` (late, was due <when>)`; task start `Task started: <text> (in <folder name>)`.

## Review Focus

- A cron expression that never matches (e.g. `0 0 31 2 *`): `nextAfter` must return `null` within a bounded search (2 years), and the parse check rejects it.
- The PC was off for 3 days with a daily item: exactly one fire, then `nextRun` in the future (test in Task 2).
- DST: a daily 09:00 item stays at 09:00 local across a DST change (test in Task 1, run with `TZ=Europe/Berlin`).
- The tick runs while a previous tick is still firing (slow spawn): no double fire. A `busy` flag in the service skips the overlapping tick (test in Task 4).
- A corrupt or missing `items.json`: loads as an empty list and logs to stderr, never crashes the addon (test in Task 2).

---

### Task 1: Cron parser and next run (`cron.ts`)

**Files:**
- Create: `src/addons/remind/cron.ts`
- Test: `test/remind-cron.test.ts`

**Interfaces:**
- Produces:
  - `type Cron = { minute: Set<number>; hour: Set<number>; dom: Set<number>; month: Set<number>; dow: Set<number>; domStar: boolean; dowStar: boolean }`
  - `parseCron(expr: string): Cron | null`: 5 fields; `*`, `a,b`, `a-b`, `*/n`, `a-b/n`; dow 0–7 (7 = Sunday). Null on any bad field.
  - `nextAfter(cron: Cron, afterMs: number): number | null`: the first local minute strictly after `afterMs` that matches, or null if none within 2 years. Day rule as standard cron: when both dom and dow are restricted, either may match.
  - `type Schedule = { kind: 'once'; at: number } | { kind: 'cron'; expr: string }`
  - `nextRun(s: Schedule, afterMs: number): number | null`: once → `at` if `at > afterMs` else null; cron → `nextAfter`.
  - `describeSchedule(s: Schedule, now: number): string`: e.g. `Once, Thu 20 Nov 09:00`; `Daily 09:00`; `Mon–Fri 09:00`; otherwise `Cron <expr>`; always followed by `, next: <Ddd D Mon HH:MM>` for cron.

- [ ] **Step 1: Write failing tests** in `test/remind-cron.test.ts`: `parseCron('0 9 * * 1-5')` not null and `parseCron('61 * * * *')`, `parseCron('* * *')` null; `nextAfter(parseCron('0 9 * * *'), <Wed 19 Nov 2026 10:00 local>)` = Thu 20 Nov 09:00 local; weekday cron from Fri 10:00 gives Mon 09:00; `*/15` from 10:07 gives 10:15; `0 0 31 2 *` gives null; DST: with `process.env.TZ` set to `Europe/Berlin` before any Date use, daily `0 9 * * *` from 2026-03-28 10:00 gives 2026-03-29 09:00 with `getHours() === 9`; `nextRun({kind:'once', at: past}, now)` null; `describeSchedule({kind:'cron',expr:'0 9 * * 1-5'}, …)` starts with `Mon–Fri 09:00`.
- [ ] **Step 2: Run** `$(ai-resources prefix) node --test --experimental-strip-types test/remind-cron.test.ts`. Expected: FAIL (module missing).
- [ ] **Step 3: Implement** `cron.ts`. `nextAfter` steps minute by minute only within matching days: loop over days (from the day of `afterMs`, up to 732 days); skip a day unless its month and day rule match; then for hours in `cron.hour` and minutes in `cron.minute` in order, build `new Date(y, m, d, h, min)` and return the first whose time is `> afterMs` and whose `getHours()/getMinutes()` equal `h/min` (this drops times that DST skipped).
- [ ] **Step 4: Run tests.** Expected: PASS.
- [ ] **Step 5: Commit** `remind: cron parser and next run`.

### Task 2: Item store and due logic (`store.ts`)

**Files:**
- Create: `src/addons/remind/store.ts`
- Test: `test/remind-store.test.ts`

**Interfaces:**
- Consumes: `Schedule`, `nextRun` from Task 1.
- Produces:
  - `type Item = { id: string; kind: 'remind' | 'task'; text: string; schedule: Schedule; nextRun: number; createdAt: number; dir?: string }`
  - `loadItems(path: string): Item[]`: missing file → `[]`; bad JSON or wrong shape → `[]` plus a stderr line.
  - `saveItems(path: string, items: Item[]): void`: `mkdirSync(dirname, {recursive:true, mode:0o700})`, write `path + '.tmp'`, `renameSync`.
  - `LATE_MS = 120_000`
  - `takeDue(items: Item[], now: number): { fire: Array<{ item: Item; late: boolean }>; keep: Item[] }`: each item with `nextRun <= now` fires once; `late = now - nextRun > LATE_MS`. Fired `once` items are dropped from `keep`; fired cron items are kept with `nextRun = nextRun(schedule, now)` (dropped if null). Not-due items are kept unchanged.
  - `newId(): string`: 8 chars `[a-z0-9]` from `crypto.randomBytes`.

- [ ] **Step 1: Write failing tests:** save then load round-trips; load of a missing path is `[]`; load of a file containing `{oops` is `[]`; `takeDue` with a daily item whose `nextRun` is 3 days ago fires once with `late: true` and keeps it with `nextRun > now`; a `once` item due 30 s ago fires with `late: false` and is dropped; a not-due item is unchanged.
- [ ] **Step 2: Run** the test. Expected: FAIL.
- [ ] **Step 3: Implement** `store.ts`.
- [ ] **Step 4: Run** the test. Expected: PASS.
- [ ] **Step 5: Commit** `remind: item store and due logic`.

### Task 3: Haiku parse (`parse.ts`)

**Files:**
- Create: `src/addons/remind/parse.ts`
- Test: `test/remind-parse.test.ts`

**Interfaces:**
- Consumes: `parseCron`, `Schedule` from Task 1.
- Produces:
  - `type Parsed = { text: string; schedule: Schedule; project: string | null }`
  - `buildParsePrompt(words: string, kind: 'remind' | 'task', now: Date, projects: string[]): string`: tells the model the current local date, time and weekday, the project names (task only), and asks for JSON only: `{"text": string, "once": "YYYY-MM-DDTHH:MM" | null, "cron": "<5-field>" | null, "project": string | null}`. Exactly one of once/cron. The user's words are put inside `<request>` tags and marked as data.
  - `checkParse(raw: string, now: number, projects: string[]): Parsed | null`: extracts the first `{…}` block, JSON-parses it; `text` non-empty after trim; `once` parsed as local time (`new Date(y, m-1, d, h, min)`) and must be `> now`; `cron` must `parseCron` and have a `nextAfter(…, now)`; `project` kept only if it case-insensitively equals one of `projects` (then returned in its listed spelling), else null. Anything else → null.
  - `runHaiku(prompt: string): Promise<string | null>`: copy of `runClaudeSummary` in `src/addons/workers/report.ts:767` with cwd `join(STATE_DIR, 'remind')` and a 30 s timeout; same argv as workers (`nice -n 19 taskset -c 8-19 claude -p --model haiku …`). Not unit-tested (I/O).

- [ ] **Step 1: Write failing tests** for `checkParse`: a valid cron reply wrapped in prose is accepted; `once` in the past → null; `cron: "99 * * * *"` → null; both once and cron null → null; empty text → null; `project: "TG-BRIDGE"` with projects `['stolik']` returns `'stolik'`; unknown project → `project: null`. One test that `buildParsePrompt` contains the weekday name and `<request>`.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement** `parse.ts`.
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `remind: Haiku parse and check`.

### Task 4: Service, entry point, manifest, build

**Files:**
- Create: `src/addons/remind/service.ts`, `src/addons/remind/main.ts`, `src/addons/remind/stolik-addon.json`
- Modify: `package.json` (`build` script: add `remind` to the manifest copy loop), `src/router/handlers/builtins.ts` (blurb `remind: '/remind, /task, /reminders: reminders and scheduled AI tasks'`)
- Test: `test/remind-flow.test.ts`

**Interfaces:**
- Consumes: everything above; `AddonPeer`, `Handler`, `startAddon` from `src/addons/sdk.ts`; host requests `send {text, rows?}` → `{messageIds}`, `folders {}` → `{folders: [{name, path}]}`, `spawn {dir, prompt, messageId}` → `{ok, error?}`, `quota {}` → `{refuse, reason?}`.
- Produces: `remindHandlers(peer: AddonPeer, deps: { now: () => number; path: string; parse: (prompt: string) => Promise<string | null> }): Record<string, Handler>` with ops `command`, `callback`, `tick`.

Manifest:
```json
{
  "name": "remind", "version": "1.0.0", "protocol": 1, "command": ["node", "main.js"],
  "provides": [
    { "point": "command", "name": "remind" }, { "point": "command", "name": "task" },
    { "point": "command", "name": "reminders" }, { "point": "schedule", "everyMinutes": 1 }
  ],
  "access": ["message.text", "messages.send", "sessions.spawn", "usage.record"]
}
```

Behaviour (the payload of `command` is `{command, text}`; of `callback` is `{data, messageId?}`, return `{toast}`):
- `/remind <words>` and `/task <words>`: return `{handled: true}` at once; in the background call `parse(buildParsePrompt(...))` (projects from `folders` for a task), `checkParse`; on null send the exact failure text. For a task with `project` null, send `Which folder?` with one button per folder (max 8, data `f:<pendingId>:<index>`). Otherwise send `<Remind|Task>: <text>\n<describeSchedule>` (task adds `\nIn: <folder name>`) with buttons `Save` (`s:<pendingId>`) and `Cancel` (`c:<pendingId>`). Pending entries live in a `Map` with a 15-minute expiry; an expired id gets the toast `Expired, send it again`.
- `/reminders`: one message listing items sorted by `nextRun` (`<n>. <Remind|Task> <text> · <describeSchedule>`), one `Delete <n>` button per item (data `d:<id>`), or `No reminders.`.
- Callbacks: `s:` saves (load, push, save) and toasts `Saved`; `c:` toasts `Cancelled`; `f:` sets the folder then sends the Save/Cancel message; `d:` removes and toasts `Deleted`; `k:<id>` (Done) toasts `Done`; `z:<id>` (Snooze) adds a `once` item at `now + 3_600_000` with the same text and toasts `Snoozed 1h`.
- `tick`: if `busy`, return; else `takeDue`, save `keep` first (so a crash never fires twice), then for each fired: remind → send `⏰ <text>` + late suffix with buttons `Done` (`k:<id>`) and `Snooze 1h` (`z:<id>`); task → `quota`; if refused send `Task skipped: <text> (<reason>)`; else send the start text, then `spawn` with its first message id; on `{ok:false}` send `Task failed to start: <text> (<error>)`. Late suffix uses the old `nextRun`.
- `main.ts`: `startAddon((peer) => remindHandlers(peer, { now: Date.now, path: join(STATE_DIR, 'remind', 'items.json'), parse: runHaiku }))`.

- [ ] **Step 1: Write failing tests** in `test/remind-flow.test.ts`, with the fake-host harness pattern of `test/workers-flow.test.ts` (answer `send` with `{messageIds:[1]}`, `folders` with one folder `{name:'stolik', path:'/x/stolik'}`, `spawn` with `{ok:true}`, `quota` with `{refuse:false}`), a temp dir for `path`, a fake clock and a fake `parse` returning fixed JSON:
  - manifest is valid (`readManifest`) and provides the three commands and the schedule.
  - `/remind` then tapping Save stores one item; `/reminders` lists it; `d:` deletes it.
  - a bad parse sends the exact failure text.
  - tick with a remind item due 3 days ago sends one `⏰` message containing `late, was due`; a second tick sends nothing.
  - tick with a due task sends `Task started:` then a `spawn` request with `messageId: 1`; with `quota` answering `{refuse:true, reason:'over pace'}` it sends `Task skipped:` and no spawn.
  - two ticks started without awaiting the first fire the item once.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement** `service.ts`, `main.ts`, the manifest, the build script and the builtins blurb.
- [ ] **Step 4: Run** `test/remind-*.test.ts`, then the whole suite `$(ai-resources prefix) npm test` and `$(ai-resources prefix) npm run build`. Expected: all PASS, build has `dist/addons/remind/stolik-addon.json`.
- [ ] **Step 5: Commit** `remind addon: /remind, /task, /reminders with catch-up`.
