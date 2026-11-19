# stolik v3: design

Status: design record, 2026-11-14.

**Open:** marks something no ticket settled and no coordinator decision covers. Nothing marked Open is decided.

**One open owner decision: the test approach (§7).**

## 1. Goal and scope

stolik lets the owner talk to Claude Code sessions from Telegram: send messages, read answers, approve tool use,
resume sessions, and ask quick questions that need no session. v3 does four things:

1. **New Telegram layout.** A private supergroup with one topic per folder (ticket 22), instead of one DM with the bot.
2. **Fixes and one feature.** Three bugs fixed (first message lost on `/to`, answers sent twice, no resume from the
   phone), plus the official Claude Code approval relay.
3. **Small core, addons for features.** Voice, cleanup, digest, modes and notes are addons. Nobody edits the core to
   add a feature.
4. **Installable on the owner's other machines.** Linux and macOS natively, Windows through WSL. This PC's specifics
   become config.

Out of v3 (§8): btw, the reranker and the Haiku classifier, native Windows, a public addon index, any AI backend other
than Claude Code.

## 2. What changed from v2

| Area | v2 (2026-11-11) | v3 | Ticket |
|---|---|---|---|
| Where the owner talks | DM with the bot | Private supergroup, topic per folder; DM is fallback only | 06 |
| Unprefixed messages | Local reranker (Qwen3-Reranker-0.6B) | No reranker, no Haiku classifier. Last active session (about 30 min), else buttons | 12 |
| Prefixes | §4 set, with btw | Same set minus btw; General only; nothing parsed inside a topic | 07 |
| Modes | quick, read, web, btw | quick, read, web as an addon; btw removed; cwd `~/Documents/projects/master` | 09 |
| Digest | Nightly 04:00, on request only, never pushed | Addon; schedule configurable (daily, weekly, or on request); cost line | 11, 12 |
| Extension | Edit the code | Addons: manifest, NDJSON over stdio, declared access | 18 |
| Storage | JSON files, chat log | SQLite for structured state; files for log, attachments, notes, audit | 19 |
| Outbound | Direct sends | Rate-limit queue and per-turn ledger | 02, 11 |
| Sessions | Start only | `/resume` of ended sessions | 04 |
| Platform | This PC | Linux and macOS; Windows via WSL; machine specifics as config | 16 |

Unchanged from v2: no hosted model in the plumbing; the GPU rule (RTX 4060 only, loaded on demand); the voice flow.

## 3. Architecture

### 3.1 Layers

| Layer | What it holds | Depends on |
|---|---|---|
| Brain | Pure decisions: sessions, topics, inbound, outbound ledger and away rule, prefixes, modes, approvals, resume | Adapter interfaces only |
| Adapters | telegram, channel, hooks, tmux, claude-cli, ml, store, platform (idle, lock, process info, paths, pinning) | Libraries and OS |
| Agent backend | Facade over channel, hooks, tmux and claude-cli: Claude Code as one backend | Adapters |
| Addons | Separate programs (§3.2) | Core, via NDJSON |
| `app.ts` | Wires adapters into the brain | Everything |

Brain modules are unit-tested without the network. Telegram, the ML backend, the agent or storage can be swapped without
touching decisions. Stack stays TypeScript on Node, grammY and the official MCP SDK; Python runs only the ML worker. No
rewrite: a module split.

The agent backend is one `AgentBackend` interface: send to a live session; events turn-ended, user-prompted and needs-approval; list and resume sessions; headless runs. The Claude Code backend implements it internally, using the channel, hooks, tmux and claude-cli adapters. Core only sees `AgentBackend` (decided 2026-11-14, coordinator).

Folder names: `src/brain/`, `src/adapters/`, `src/addons-host/` (only if needed), `src/app.ts`.

### 3.2 Addons

An addon is a separate program in any language. A manifest declares what it provides and may see. The bot starts it and
talks NDJSON over stdin and stdout, as the whisper worker does today. A crash stays inside the addon.

| Plug-in point | What it does |
|---|---|
| Media | Voice, audio, photo or document to text or an action |
| Text filter | Rewrites text before routing (voice cleanup) |
| Prefixes and commands | Adds prefixes or commands handled in General |
| Router backend | Scores sessions for an unprefixed General message. No v3 addon implements it; the reranker is backlog (§8) |
| Route | Picks a live session or a trusted folder for an unprefixed General message that names none (the `router` addon, §4.4). Needs `sessions.read` and ml-worker |
| Schedule | Runs jobs at a time (digest) |
| Listener | Read-only view of every message; warned at install |
| Gate | Holds a message to a session before it is delivered (cost-guard, §4.15). Needs `messages.gate`; only the addon that held a message can release, drop or read it back |

**Core keeps:** sessions, topics, prefix dispatch and buttons, the outbound ledger, approvals, resume, the chat log, access
control.

**First-party addons:** voice, voice cleanup, digest, modes (quick, read, web), notes, usage-watch, cost guard (§4.15), workers (`/workers`, plan 3.7), and the ML worker that voice,
cleanup and digest share. The reranker router is backlog.
Ticket 18's list omits the ML worker; it is added here.

**usage-watch** (schedule and command points, plan 3.5) runs once a day at 04:00 local. It runs the usage-audit analyzer
on `~/.claude/projects`, checks the day before (cache misses after idle gaps above 5% of the day's usage; Haiku subagent
calls over 100k context above 50%, from 20 calls; the weekly quota more than 10 points ahead of pace) and sends one message
to General only when a threshold is crossed. It shows percentages, never money. `/usagecheck` runs the same check for
yesterday and always answers. Access: `messages.send` only.

**Trust.** Declared access only: an addon gets only what its manifest declares. Install shows the list and needs an
explicit yes. Listeners get a loud warning. Any addon can be disabled from Telegram. No sandbox; addons run as the user.

**Install.** From the PC only: `stolik addon add <git url | npm name | folder>`. In Telegram, `/addons` lists, enables
and disables. Nothing installs from the chat. A public index is backlog. Install refuses a name that is a built-in, counts
a built-in as a present requirement, records the consent hash and leaves the addon off.

**Re-consent.** Install stores a hash of the consented manifest (name, version, command, provides, access, requires,
serves). When a user addon's manifest later differs from that hash, the host stops it, marks it "needs re-consent" in
`/addons`, and it cannot run until the owner runs `stolik addon consent <name>` on the PC and types `yes`. Nothing from
Telegram can consent. Built-in addons ship with the code, so a changed built-in manifest updates its stored hash without
asking. A user folder that has a built-in's name is ignored, and the built-in wins. Open for the owner's veto: the consent step is
on the PC, as install is, rather than a typed `yes` in `/addons` (the coordinator's wording was "a yes in /addons"; Telegram
is kept free of consent because it is the channel a stolen session would use).

Manifest: a JSON file `stolik-addon.json` at the addon root, with `name`, `version`, `protocol` (integer; 2 is the only one the host speaks, any other is refused), `command` (argv array), `provides` (plug-in points with their params, for example `{point:"prefix", words:[...]}`), `access` (what the addon may receive), `requires` (names of other addons) and `serves` (the ops it answers for other addons through `requires`; default none). The host refuses an addon-to-addon call to an op the target does not list in `serves`. The host's own point ops (prefix, reply, callback, tick, route, command, general, media, text-filter, event, router, gate) can never be listed in `serves`; the manifest is refused if they are. A gate provider must declare `messages.gate` (the manifest is refused otherwise). The ML worker serves `generate`, `transcribe` and `clean`. The coordinator's reserved list also named `clean`; it is allowed
here because voice cleanup needs it through ml-worker, and only addons that require ml-worker can call it (open for veto).

**Protocol 2: ids and buttons.** The host hands every chat, thread and message id to an addon as an opaque string (`tg:…` on Telegram). The addon echoes it back and never parses it; a number in an id field is refused. A reply to a message is the `reply` point (`{ text, replyTo, messageId }`), not `thread`. Button data is tokenised by the host: a button carries `ax:<token>` (10 random characters, kept in memory for 24 h, at most 2000 tokens, oldest evicted), and the addon's data behind it is 1 to 256 characters. A press on an unknown or expired token gets the toast "This button has expired." and the addon is not called. The host lays out an addon's buttons to the chat app's limits (`capabilities.buttons`); the addon does not see them.

Every addon call carries a `deadline` (epoch ms, the host's clock plus the call's timeout). The ML worker drops a request whose deadline has passed before it starts, so a caller that gave up does not leave the GPU or CPU busy.

Built-in addons are compiled into `dist/addons/` (the build copies each manifest there) and read from that folder. User addons live in the config folder's `addons/`. A bare `node` as the first word of a `command` runs with the bot's own Node binary (`process.execPath`), because a service's PATH may not have one.

Restart: after a crash, restart with backoff of 1 s, then 5 s. The third crash within 10 minutes disables the addon and sends one alert in General (so there is no third delay: the 30 s step was unreachable and is gone).

Dependencies: the host starts required addons first, and refuses to enable an addon whose requirement is missing or disabled. The ML worker is the first-party addon `ml-worker`, required by voice, voice-cleanup, digest and router.

**Built-in offer.** The built-ins are off until the owner enables them. After `/bind`, and on the first start in DM mode when no built-in has ever been chosen, the bot posts one message in General: each built-in in one line with its declared access, and two buttons. "Enable all" turns them on in dependency order through the same `setEnabled` path `/addons` uses (same audit, same consent record), then edits the message with each result (on, or failed with the reason). An addon the owner chose before (on or off) is never touched. The offer is made once; a flag in the store records it.

**Router addon** (`src/addons/router`, `route` point, access `message.text` and `sessions.read`, requires ml-worker). It now
only answers the model question: given the owner's message, the live sessions and the trusted folders, it asks the local
model (`generate`, 20 s limit) to pick one option by number, and the reply is parsed strictly. A bad reply, a timeout or a
missing ml-worker gives no answer, and the router shows its buttons. The addon's answer is a suggestion only: it never starts
or forwards anything by itself. The name matching that used to live in the addon moved to the router
(`src/brain/route-match.ts`), so a compromised or buggy addon cannot force an auto-start. Smoke (RTX 4060, 2026-11-14): a
Russian paraphrase chose shop-ui in about 2.7 s with the first model load; an unrelated question gave no target.

**Router policy** (§4.4 for where it sits in the order). Config `routerAutoStart`: `"confirm"` (default), `"auto"`, `"off"`.
Decided by the coordinator; the owner may veto.

| Case | confirm (default) | auto | off |
|---|---|---|---|
| Model guess, folder | one tap: Start folder? [Full] [👁 Read-only] [Other…] | same | no addon asked |
| Model guess, live session | one tap: Send to session? [Yes] [Other…] | same | no addon asked |
| Name hit (deterministic), live session | forward with "wrong one?" | same | no name matching |
| Name hit, folder, at the start with a separator (`imgtune: …`, `in imgtune, …`) | one tap | start at once with "wrong one?" (quota gate; 1 auto-start per 5 min; over that, one tap) | no name matching |
| Name hit, folder, mid-sentence | one tap | one tap | no name matching |
| Forwarded message | buttons only (never the addon, never a name match) | same | same |

Name rules: a name is its words in the message (display name or basename, case-insensitive, Cyrillic-safe). Names of four
characters or fewer, and words in a small English and Russian stopword list, never match mid-sentence. A separator is a
colon, a comma, or a dash after a space. "Wrong one?" on an auto-started session offers [⏹ Stop it] (kills that tmux session
by its exact target, `tmux kill-session -t =<name>`, then shows the folder picker). Confidence is kept in the audit only.
Each decision is audited with decision, source (rule, match, model or buttons), folder or session, reason and confidence.

### 3.3 Agent backend

Claude Code is the only backend in v3. The adapter covers:
send to a live session; events for turn ended, user prompted, needs approval; list and resume sessions; one-off headless
runs. Claude specifics (channel MCP, hooks, `--resume` with `~/.claude/projects`, `claude -p`) live only inside it.

- **Stateless where possible.** Sessions, threads and ledgers live in the core store, keyed by backend and backend
  session id. In-process connections and caches are allowed case by case.
- **Later:** opencode, Codex CLI, Gemini CLI and chat APIs (backlog). A chat API fits as a headless-only backend.
- **Names.** Core and chat log say "agent session", not "Claude session". Done during the split.

### 3.4 Storage

| Store | Contents | Why |
|---|---|---|
| SQLite `stolik.db` via `node:sqlite` | Sessions, topics, mode threads, outbound ledger, addon settings, router decisions, usage and cost | Consistency and real queries; no extra dependency |
| Files | Chat log (`log/YYYY-MM.jsonl`, daily `YYYY-MM-DD.md`), attachments, notes inbox, audit log | Greppable by the owner and read mode |

The database is `~/.local/state/stolik/stolik.db` (config `stateDir` overrides the folder). The v3 folder is
separate from the old bot's `~/.local/state/stolik/`, so v3 can run beside it. The audit log is `audit.log` in the same
v3 folder. The chat log, daily Markdown files, digests and attachments sit under the log root (`logRoot`, default
`~/Documents/notes/telegram`). The notes inbox and its attachments stay under `~/Documents/notes/`.

Everything goes through the `store` adapter.

Minimum Node is `engines.node >= 22.13`, where `node:sqlite` loads without a flag. Checked on Node 24 in Phase S (plan S9) (decided 2026-11-14, coordinator).

Attachments: files received or sent in chat go to `~/Documents/notes/telegram/attachments/YYYY-MM-DD/` (v2 §7). The notes addon keeps its own inbox and `~/Documents/notes/attachments/` as today.

## 4. Telegram UX

### 4.1 Layout and topics

- A **private supergroup**. The bot is admin with `can_manage_topics`, and `can_delete_messages` to delete topics.
- An admin bot sees every group message, so **every message and callback is checked against the owner's user id**
  (`from.id`). The chat id alone is not enough. Phase 1 already does this for callbacks and text verdicts.
- Topic lifecycle:

| Event | Topic |
|---|---|
| Any session connects (terminal or phone) | Created, named `project`, then `project#2` |
| Session ends | Closed (still readable) |
| `/resume` of that session | Reopened |
| 7 days after the session ended | Deleted; a later `/resume` gets a fresh topic |
| Idle 60 min (warned 5 min before, `[Keep open]` restarts the time), or the session calls `close_session` on the owner's request | Closed (still readable); its terminal closes too. The next message in the folder starts a fresh session; a Telegram reply quotes the replied-to text into its first prompt |

Sessions without a channel (Remote Control) never register with the bot, so they get no topic. `/resume` shows them with the Remote Control hint (decided 2026-11-14, coordinator).

### 4.2 Where things go

| Destination | Content |
|---|---|
| The session's topic | Answers, end-of-turn text, proactive pings, approvals, AskUserQuestion, plan approvals. Only there |
| General | `/list`, `/resume` picker, note confirmations, quick/read/web answers, bot alerts (errors, quota), "which session?" buttons |
| Bot DM | Fallback when the group is unreachable. Anything written there gets "use the group" and a link; not routed |

### 4.3 Prefixes

Prefixes work **only in General**. Inside a folder topic only `/new` is parsed (ticket 22), including a message starting "note:".

| Prefix | Words (case-insensitive) |
|---|---|
| `to <session>` | to, send to, отправь в |
| `new <project>` | new, новая, новый |
| `note` | note, заметка, запиши |
| `quick` | quick, question, вопрос, быстро |
| `read` | read, check, почитай, проверь |
| `web` | web, search, поиск, загугли |

A prefix is followed by a colon, a comma, or a dash followed by a space. No separator, no prefix: "note that the build
failed" is an ordinary message. For `to` and `new` the name runs up to the first colon or comma, or to a dash set off by
spaces, so "to stolik - hi" names stolik, and a dash inside a word ("quick-fix") is never a separator. `to` stays so a voice note in General can reach a session. Names match loosely against open sessions and
trusted folders; an unclear match shows buttons (v2 §4).

### 4.4 Unprefixed General messages

Order, first match wins:

1. The **only session active in the last 30 minutes** (a message in or out) gets the message, with a "wrong one?" button (rule, no addon asked).
2. **Names and the router addon** (`route` point, §3.2, policy table there). A name that the message contains forwards to a live session ("wrong one?"). A folder name at the start of the message, with a separator, starts a Full session at once only when `routerAutoStart` is `auto`; in the default `confirm` mode, and for a mid-sentence name, the owner gets one tap. The router addon's model guess only preselects with one tap. A forwarded message never reaches the addon and gets the buttons.
3. Otherwise buttons: each open session, New…, quick, read, web (v2 §1, btw removed). With no live session the buttons are New… and the modes only.

"New…" (the New button, `new:` alone) opens the folder picker: every trusted folder, master first, then by the newest Claude activity, then by path, eight per page with ◀ and ▶ (the message is edited in place). Each row has "＋ folder" (a Full session starts at once) and "👁" (read-only at once, `--permission-mode plan`; approving its plan upgrades it to full, v2 §1, Q9). Button labels are the folder basename, or parent/basename where two share one. The new session's folder gets its topic (shared with the folder's other sessions).

`new <project>:` keeps its own question: [Read-only] [Full] for the named folder (decided 2026-11-14, coordinator).

A word that starts a message and that no addon answers (quick, read, web, note) is answered with a notice: "not installed" only when no installed addon declares it; when one does and it is off, the notice names it ("comes from the modes addon, which is off") with a button that opens its entry in `/addons`.

### 4.5 Outbound queue and ledger

- **Queue.** One per group, 15 messages a minute refilled, bursts of 5: at most 20 in any minute. Telegram allows 20 per minute per group, shared
  by all topics. Chunks stay in order. Permission approvals, AskUserQuestion and plan approvals
  jump the queue, and may land between the chunks of a message. Normal groups are served round-robin per session; at most 200 normal sends wait. On 429, the bot-wide pause waits `retry_after` and retries. Transient failures (5xx, network) retry with a backoff of 2, 5 and 15 s.
  Uploads use a separate lane that shares the chat's bucket.
- **Ledger.** Keyed by kind, text and files. A retry joins the in-flight send or reuses its result; a failed part is
  resent alone. A 60 s grace after a Stop. Reply timeout 120 s. Each send writes an audit event
  (02; done in Phase 1).

Everything else is FIFO per group, with chunk order kept (decided 2026-11-14, coordinator).

### 4.6 Concurrency

A message to a busy session is delivered at once (Claude Code queues it), with a "⏳ queued, session is busy" reaction.
Mode runs: at most 3; a fourth shows "⏳ waiting". Spawn cap stays at 3. The Interrupt button is backlog.

### 4.7 Approvals

- The official channel permission relay stays. It works only
  while the owner is away. Verdicts come from the owner only. The label says "Sent: allow" or "Sent: deny", and claims
  nothing about the terminal.
- **Reminder** at half the TTL (30-minute permission TTL, so 15 minutes) in the session's topic. At expiry, the note
  reads "expired, answer at the desk or /resume". Release to the terminal; no deny on timeout.
- **Stale buttons.** A prompt answered at the desk with "Yes" is followed by a `PostToolUse` event for that tool call. The spike (task 1.3) found it, and the bot clears the buttons and says "✅ Answered at the desk" (task 1.2; `src/brain/posttool.ts`). A desk denial sends no `PostToolUse`, so that prompt keeps its buttons until the 30-minute sweep. `PermissionDenied` is not used.
- The reminder and the expired note apply to all three kinds: tool approvals, AskUserQuestion and plan approvals.
- Every permission prompt, of any tool, is forwarded to the session's topic while the owner is away (the `PermissionRequest` hook has no tool matcher). AskUserQuestion and ExitPlanMode prompts are shown as a question and a plan approval; other tools show their name and a summary of the call, with Allow / Deny.

### 4.8 /resume

- Lists ended CLI sessions (transcripts with `entrypoint == cli`, newest first) and live sessions with a channel. A live
  session with a channel is routed to. A live session without one gets the Remote Control pointer; it is never forked.
- An ended session resumes in tmux with `claude --resume <id>` via `tg-claude`, after checks: id format, transcript
  exists, cwd is a real directory, trust accepted, no live process holds that id, spawn cap not reached.
- Verified on 2.1.323: argv passes through tmux intact; the dev-channels dialog reappears and one Enter clears it; the
  resumed session registers and keeps its history. Launch flags are not restored and must be passed again.

### 4.9 Usage and quota

- Mode-run cost and per-session token totals go into SQLite. `/usage` shows today and the week, per session and per mode,
  against the quota-gate pace. One alert a day in General when over pace.
- Modes refuse above the weekly limit (99% now, in config). The digest carries a cost line.

### 4.10 Modes (quick, read, web)

An addon. Runs `claude -p` headless, pinned, cwd `~/Documents/projects/master`. Flags verified on 2.1.323.

| Mode | Model (v2 Q8) | Tools | Limit |
|---|---|---|---|
| quick | Haiku | none (`--tools ""`) | 60 s |
| read | Sonnet | Read, Grep, Glob, Bash allowlist | 5 min, 30 steps (`--max-turns`) |
| web | Sonnet | WebSearch, WebFetch | 5 min, 30 steps |

- Every run uses `--strict-mcp-config`, or account MCP tools load. read and web use `--allowedTools` with
  `--permission-mode dontAsk --permission-prompts none`: denied calls never prompt or hang.
- **Working folder.** Read runs in `~/Documents/projects/master`. Quick and web run in an empty neutral folder under the
  state dir, so no CLAUDE.md or memory of the master project is loaded.
- **Read allowlist** (owner-accepted commands, now with argument allowlists): `git status`, `log`, `diff`, `show`, `branch`
  (explicit flags per subcommand; no `-c`, `-C`, `--git-dir`, `--output`, `--ext-diff`, `--textconv`, `--no-index`, no `..`;
  paths inside the master folder); `ls`, `df`, `du` (short flags and paths only; no `--*-from=`, `--exclude-from=`, `-H`,
  `--host`, `-M`); `free`, `uptime`; `ps` (listing forms only, no environment columns); `systemctl --user status` (unit names
  and `--no-pager`, `-n N`, `-l`; no `-H`, `--host`, `-M`); `journalctl --user` (fixed reading options); `nvidia-smi`
  (query forms); quota-gate. Nothing that writes, installs, deletes, restarts or uses the network.
- **Read roots (allowlist, not a deny-list over the home folder).** A read or search may open only paths inside: the master
  project, the chat log root, the notes folder, `/tmp`, the trusted project folders, `/var/log`, and a few `/etc` files (for
  example `os-release`, `hostname`, `hosts`). The root check uses the real path, so a symlink into another folder does not
  pass. No cap on the roots: the hook's allowlist is the exact list. Inside a root the
  secret patterns still refuse credentials, keys, `.env*`, `.npmrc`, `.netrc`, `.pgpass`, `.git-credentials`, keystores,
  `id_*`, `*.pem`/`*.key`/`*.p12`, kube and docker configs, shell and REPL history files, browser and Telegram profiles, and
  `~/.claude` settings, projects and credentials. `/proc`, `/sys` and `/dev` are refused wherever they appear as a path value (at the start of a word, or after `=` or `:`); a folder named `dev` inside a home path is readable.
- **Globs.** A Glob or Grep glob must end in a literal extension from a safe list (code, text, markdown, JSON, YAML, logs);
  a glob that could match a dotfile or dot-folder, or a secret-like name, is refused.
- **Refusals.** Each call the read-mode hook refuses is logged at warn level by its folder (`warning: read-mode guard refused Read in ~/.ssh`, never the file name). An answer withheld for naming a secret path says how many calls were refused in that run.
- **Answers.** Lines of a read or web answer that mention a secret path are dropped before they are sent. Tool output still
  reaches the model during the run; this filters what reaches the chat (residual risk, see §8).
- A **PreToolUse hook** in read and web re-checks every call. It only ever denies, and a hook that fails to start blocks
  the call (`|| exit 2`). At addon start the hook is self-tested with a known-bad call; if it does not deny, read and web
  refuse to run.
- **Web checks** (the hook, `src/brain/hook-policy.ts`): a WebFetch needs an http or https URL with no user info, a host
  named in the owner's question or in a WebSearch result of the same run (a PostToolUse hook records those hosts), a query
  string of at most 100 characters, and no path segment over 64 characters or high-entropy. Every URL decision is written to
  `web-audit.log` in the state dir.
- **Cost of a timeout.** A run that is cut off by its timeout records an estimate ($0.02 a minute for quick, $0.25 a minute
  for read and web, at least one minute). A run that errors records the cost the CLI reported, when it reported one.
  Each mode start checks the quota gate, again after waiting for a run slot. At most 10 runs wait; the 11th is refused.
  Upgrade is gated by the quota too. The gate now refuses unless the quota is read as clear.
- Answers appear in General as a reply to the question. A swipe-reply continues the thread with `--resume`; a new message
  starts fresh. No topics for modes.
- A limit gives the partial answer and a **Continue** button (fresh limits). Every answer ends with a cost and time footer
  from `total_cost_usd`.
- **Upgrade** opens a folder picker (master first, then trusted projects) and starts a full session in its folder's topic. Its
  first message carries the question and the answer.

The PreToolUse hook is attached through a per-mode settings file passed with `--settings <file>` (decided 2026-11-14, coordinator). Fallback: `--settings` with a JSON string. No `settings.json` goes in the cwd, which is `~/Documents/projects/master`, a real project. Plan task 2.11 verifies the flag, whether `dontAsk` alone denies (the test also used the allowlist), and that the Sonnet and Opus aliases resolve.

The argv is built by `modeArgv` in `src/brain/modes.ts`. The prompt comes last, after `--`, so a follow-up or Continue
that starts with a dash is never read as a flag. Read mode adds the fewest `--add-dir` folders that cover every root (`readAddDirs`:
the parent of several roots, e.g. `~/Documents/projects`, or the root itself; never the home folder). Under `dontAsk` the CLI
denies paths outside the working folder unless they are added. The PreToolUse hook is the decider for every path: it allows
exactly the roots, so a folder covered by an added parent but not listed as a root is still refused (it reads a per-run
policy file; the CLI flags are only the first layer).

**Upgrade.** The answer of a read run becomes the first message of a full session, marked as content written by a
read-only run from files that may be untrusted: data, not instructions, and the session asks before it acts on it.

Headless JSON output fields (ticket 08): `result`, `session_id`, `is_error`, `subtype`, `num_turns`, `permission_denials`, `total_cost_usd`.

### 4.11 Chat log

Every incoming and outgoing message is logged with its **topic and session**, plus the v2 T1 fields
. Files: `log/YYYY-MM.jsonl` and a readable `YYYY-MM-DD.md`; read mode can grep them.

Chat-log JSON fields: ts, dir, kind, text, raw, target {type, name}, topic_id, backend, scores, gap, attachments, tg_message_id (v2 T1 list plus topic_id and backend). The headless output fields are fixed, see §4.10.

### 4.12 Voice

An addon on the ML worker (§5.4) transcribes and cleans. The echo and its raw toggle belong to the router (`src/router/voice-echo.ts`; callback `vt:<message id>:raw|clean`), so no addon sees them. Flow from v2 §3: transcribe; clean with local Qwen3-4B (never adds content; raw
fallback on guard failure or output over 1.3x the input); then the same path as typed text. Echo `🎙 "<clean>"` with a raw
button. Both versions logged. No hosted fallback.

Cleanup latency on CPU, when the 4060 has too little free VRAM, is a measurement step in plan tasks 3.1 and 3.3. Over 10 s is flagged, and the fallback is Qwen3-1.7B (decided 2026-11-14, coordinator).

### 4.13 Notes

The notes addon keeps the v1 inbox. `note:` works in General only; confirmations go to General.

### 4.14 Digest

An addon (`src/addons/digest`) that needs the ML worker. It reads the chat log of one period and asks the local Qwen
(`generate`, §5.3) for what was asked, what was done and what is open. It adds a cost line from the usage totals (§4.9).

- **Schedule.** Config `digestSchedule`: `request` (default: only `/digest`), `daily` or `weekly`. Scheduled runs happen
  at 04:00 local. A daily run covers the day before; a weekly run (Monday) covers the week before.
- **Catch-up.** The addon checks its schedule every 5 minutes. Runs missed while the bot was down are made at the next
  check, at most 7 of them, the newest kept. A schedule that has never run makes only its latest run.
- **`/digest [YYYY-MM-DD]`** in General. No date means yesterday, the last whole day. A future day is refused. A saved
  digest is sent as it is; otherwise one is made.
- **Files.** `<logRoot>/digest/<period>.md`, where the period is a day (`YYYY-MM-DD`) or an ISO week (`YYYY-Www`).
  A failed scheduled run is reported in General with the `/digest` command to retry.
- **Privacy.** Secrets are masked before the transcript reaches the model or a file.

### 4.15 Cost guard

An addon (`src/addons/cost-guard`, first-party, no ML worker) that holds a Telegram message to a session whose prompt cache has
expired. Claude Code re-reads the whole history uncached on the next prompt after the cache's hour, about 10-15x a normal turn.
The terminal has a hook for this (token-guard); Telegram messages bypassed it, so this addon gives them the same check, with buttons.

- **Gate (protocol 2, `gate` point).** Before delivery (`send` in `src/router/deliver.ts`, after voice is transcribed), the router asks
  each gate provider in turn, with a 3 s limit. A plain message is held only when the session's id is known, its transcript
  (`~/.claude/projects/<folder of cwd>/<session id>.jsonl`, last 2 MB) gives a context of at least 100k tokens, the last main-chain
  turn is at least 60 minutes old, and the owner did not release that session in the last 10 minutes. Forwarded messages and an
  addon's own prompts are never gated. A gate that fails or times out lets the message through, and the reason is logged.
- **Notice.** A held message gets a 😴 reaction (the pause sign is not on Telegram's reaction list) and a reply in General:
  `⏸ Held: <session>'s cache expired (idle 2h 05m, context 154k). …`, with a `Week: 58% used, pace 36%.` line when the quota
  can be read (the `quota` request now also returns `usedPct` and `pacePct`). Buttons: **Send anyway** (delivered once; the
  session's follow-ups pass for 10 minutes), **New session** (starts a session in the same folder with the message, and a pointer
  to the old transcript, then drops the held one), **Cancel** (drops it).
- **Held messages (`src/router/gate.ts`).** The router keeps them until release or drop, at most 50 (the oldest is dropped).
  `release`, `drop` and `held` requests (`messages.gate`) act only on a hold the calling addon made. A release is delivered with
  the gate skipped, so it is not held again. Holds are keyed by the message id string the host gave. If the session is gone, the release is refused and the hold stays for a drop.
- **Not offered: "compact first".** `/compact` on a cold cache also re-reads everything cold. The per-topic pinned status line is
  backlog (ticket 21).
- **Thresholds** are constants at the top of `src/addons/cost-guard/decide.ts`. The hook also uses a 5-minute TTL when the cache
  was written with the short TTL; this addon uses the 60-minute main-session TTL only.

## 5. Platform and packaging

### 5.1 Session side and router

- Channel and hooks ship as a **Claude Code plugin**. A non-allowlisted plugin channel loads with
  `--dangerously-load-development-channels plugin:<name>@<marketplace>` plus one confirm. Admins can allowlist it
  (`allowedChannelPlugins`). A public release needs an official listing. The Node channel needs no Bun.
- An **npm package**: `npx stolik setup` (bot token, owner pairing by a code sent to the bot, group setup; `--owner-id` for scripts; see docs/install.md) and `stolik service install`. The router runs in the user's logon session, not as a system
  service; service definitions are written by us.

The plugin is named `stolik`, in a local marketplace `indicozy` on the owner's machines. `tg-claude` stays as a convenience launcher that adds `--dangerously-load-development-channels plugin:stolik@indicozy` (decided 2026-11-14, coordinator).

| Platform | Process | Service | Idle and lock | IPC | Process info |
|---|---|---|---|---|---|
| Linux (incl. Wayland) | tmux | systemd `--user` | logind `IdleHint`, `LockedHint` | Unix socket | `/proc` |
| macOS | tmux (brew) | LaunchAgent | Unverified (CGEventSource or `ioreg HIDIdleTime`; lock not checked) | Unix socket (103-byte path cap) | `ps`, `sysctl kern.boottime` |
| Windows | WSL, with tmux inside | WSL | WSL | WSL | WSL |

Native Windows (ConPTY, logon task, named pipes, `claude.exe`) is backlog.

The macOS idle and lock backend is a spike in plan task P4. Whether `claude --bg`, `attach` or `logs` can replace tmux is a spike in a Phase S note. tmux stays in v3 (decided 2026-11-14, coordinator).

### 5.2 This PC's specifics

Machine specifics are config with neutral defaults. Other machines get no pinning by default.

| Setting | This PC | Default |
|---|---|---|
| CPU affinity and nice for spawned and ML work | CPUs 8-19, nice 19 (desktop keeps 0-7) | none |
| GPU for the ML worker | RTX 4060: `CUDA_DEVICE_ORDER=PCI_BUS_ID CUDA_VISIBLE_DEVICES=1` | CPU |
| Presence backend | X11 idle (`xidle.py`) and `i3lock` | logind |

### 5.3 ML worker

One Python worker addon serves whisper (voice) and Qwen3-4B (cleanup, digest). Models load on demand and unload after 10
minutes idle. A model goes to the 4060 when free VRAM allows (7.8 GB free on 2026-11-14), otherwise CPU. The VRAM check is per model.

The venv (`ml/.venv`, pins in `ml/requirements.txt`) is installed by `stolik setup` (optional step 5) or by hand.
The CUDA build of llama-cpp-python needs the environment setup prints. See `docs/install.md`.

## 5a. Observability

Status: built 2026-11-14 (owner approved). The router, the CLI and the Telegram side share one model: a trace id per
flow, one log writer, a Logs topic for problems, and a doctor for the machine.

**Trace ids.** Every flow starts with a trace id of 8 lowercase hex characters (`newTraceId`, src/brain/observe.ts). A
flow is a Telegram update, a button tap, a message on the socket (channel, hook, notify, ctl), an addon request, or a timer.
The id is carried by AsyncLocalStorage (`runTraced`), so the awaits and timers the flow starts keep it. Every log line and
audit event written inside the flow carries `trace`. The addon protocol carries it too: a call from the host has
`payload.trace` (protocol 2, optional, ignored by addons that do not read it), and an addon's request or call may carry its
own `trace`, which the host then uses. A repeating timer gets a new id per tick. The trace map (SQLite `trace_map`, schema
v3) keeps the Telegram message ids, in and out, against their trace ids for 7 days (`TracedTelegram` records the outbound
ids, the router the inbound ones). `/trace` and `stolik trace` read the timeline from the log files.

**Log writer** (src/router/log.ts). One `emit(level, component, msg, fields)` for everything: the journal (stderr, human
lines), `<stateDir>/logs/router.jsonl` (JSON lines `{ts, level, component, trace?, msg, ...fields}`, 10 MB per file, five
kept), and for warnings and errors a sink. The audit log stays `audit.log` (JSON lines with `event`, now with `trace`).
Secrets are redacted from every line and every file. Addon stderr goes to `<stateDir>/logs/addons/<name>.log` (same format,
component `addon:<name>`) and the journal; a line that looks like a traceback or an error is an error, one that says
"failed" is a warning (`stderrLevel`). Levels: debug, info, warn, error. `logLevel` in config sets the floor; `/debug on
[minutes]` (default 60, at most 1440) lowers it to debug for the window and `/debug off` ends it early.

**Logs topic** (src/router/logs-topic.ts). Warnings and errors go to the "🛠 Logs" forum topic of the bound group, when
`logsTopic` is true. The topic id is kept in the store (an addon setting under the router's own scope). At most 10 lines a
minute; the same message within 5 minutes is counted, not repeated, and the next line of that kind says how many. The
lines dropped by the limit are rolled up in one line a minute later. Every line ends with its trace id. If Telegram says the
thread is gone ("message thread not found"), a new topic is made and the line goes there. In DM mode (no group) only
Telegram send errors are posted, to the owner's private chat, at most 3 a minute. Sources of warnings and errors: a spawn
that fails, an addon crash or disable, Telegram HTTP 4xx and 5xx on sends and edits (`TracedTelegram`), a quota block, an
ML load failure (through the addon stderr rule), and the doctor's start-up checks. The Logs topic's own failures are never
posted to it (the component "logs" does not reach the sink, and its sends are `quiet`).

**/debug** (owner, General; src/router/handlers/debug.ts). The report: version and commit, uptime, log level, sessions
(connected, last activity, folder, tmux name), addons (status, restarts, last error), outbound queue depth per chat, the
ML worker (loaded models, device, seconds to idle unload, VRAM of the configured GPU from nvidia-smi), the quota reading,
and the Logs topic state. `/debug on [minutes]` and `/debug off` switch debug lines.

**/trace** (owner, any topic, as a reply). Answers with the timeline of the message replied to: up to 60 lines, short
form (`+time component: message fields`), chunked for Telegram. Messages older than 7 days, or not handled by this router,
have none.

**tmux scope.** Every scoped start of the tmux server names its own transient unit (`tg-tmux-<hex>`, tmux.ts), and a refused scoped start is tried once more under a new name before the plain fallback. A plain server shares the router's cgroup, so the router-cgroup check (below) warns about it. Each headless run (modes: quick, read, web) starts in its own scope `tg-modes-<hex>` (adapters/scope.ts), so the `claude -p` process and the plugin hooks it starts stay out of the router's unit; the addon warns once when no scope is available. The check reads `/proc/<router>/cgroup` and its `cgroup.procs`, and warns about each process whose parent chain does not reach the router (adapters/cgroup.ts).

**Doctor** (src/cli/doctor.ts; `stolik doctor [--json]`). Each check is a function of its inputs and is tested with
fakes. `startup` scope (run by the router at start, no network, no model): node, claude and tmux on PATH and on the router
unit's PATH, `claude --version`, the socket path (writable, at most 107 bytes), the secrets file (mode 600, keys present),
the config, disk space (warn below 1 GiB, fail below 200 MiB), the database integrity (`PRAGMA integrity_check`, read-only),
the addon manifests and the requirements of enabled addons, the ML venv and the GPU's presence. `full` scope adds the
token (`getMe`), the group (a forum; the bot an admin with can_manage_topics, can_delete_messages and can_pin_messages) and
CUDA as the ML venv sees it. Exit 1 when a check fails, 0 otherwise. Secrets are never printed. The CLI reads the store
read-only (`ReadOnlyStore`): a doctor or `trace` run never migrates the database, so the running router's schema stays put.

**Spawn forensics** (src/router/forensics.ts). A failed router-started session writes `<stateDir>/forensics/<time>-<project>.txt`
(mode 600): the start's argv, the folder, the tmux session, the environment variable names and the PATH value (no other
values), the pane's last lines, `claude --version`, and the reason. The failure message and the Logs topic name the file.

**Addon status.** `/debug` shows each addon's restarts and last error. `AddonInfo` carries them (ports.ts); the `/addons` menu is unchanged.

**Tests.** test/observe.test.ts (rules), log.test.ts (writer, rotation, sink, redaction), observe-sinks.test.ts (Logs topic,
traced Telegram, forensics), observe-router.test.ts (flows through the router: trace on ingress, /trace, /debug, spawn
forensics, start-up checks, the Logs topic at start), doctor.test.ts, logs-cli.test.ts, addons-observe.test.ts,
observe-store.test.ts; ml/test_worker.py covers the `status` op of the ML worker.

## 6. Rollout

### 6.1 Order and testing

1. Phase 1 (done on `phase1/integration`, not deployed) plus its leftovers.
2. The module split, as a behaviour-preserving refactor.
3. Topics and the rest, on the clean code.

The current bot keeps running the old code. The new version is tested on a **new, separate bot** (same ticket).

The test approach is the open owner decision in §7 (ticket 13).
Phase 1 reaches the live bot only at cutover (§6.2). The live bot keeps the old code until the full v3 is done, so Phase 1 ships with v3 (decided 2026-11-14, coordinator).

### 6.2 Cutover

In place, with no long side-by-side period:

1. Owner creates the private supergroup with topics and adds the bot as admin with manage-topics. `stolik setup` guides it.
2. Stop and disable the old service.
3. Run the one-shot migration script, which only reads the old files.
4. Start v3.

The bot learns the group id from `/bind`. `stolik setup` tells the owner to create the private supergroup with Topics on, add the bot as admin with "manage topics" and "delete messages", then send `/bind` in the group. The bot checks that the sender is the owner and stores the chat id in SQLite (decided 2026-11-14, coordinator).

Sessions live during the switch: when v3 starts, live channel sessions reconnect to the socket and register. Each gets a topic on registration, like any new session. There is no special path.

On a group migration (`migrate_to_chat_id`), the bot replaces the stored group id automatically and logs it.

### 6.3 Rollback

Stop v3 and re-enable the old service. Possible because the migration only reads the old files.

### 6.4 Migration scope

Copies what v3 needs from `~/.local/state/stolik/` (session registry, message map, audit log) into the v3 store and
chat-log folder. The notes inbox stays where it is.

Attachments are not migrated. From v3 on they go to `~/Documents/notes/telegram/attachments/YYYY-MM-DD/` (§3.4).

## 7. Test approach

**Open:** owner deferred. Known: `node:test` unit tests for every pure module; the new bot for live testing (§6.1).

## 8. Backlog and out of scope

Backlog (after v3 ships): Interrupt button on "⏳ queued";
native Windows; public addon index; local reranker router addon, Qwen3-Reranker-0.6B on CPU, built against
real chat-log data; other AI backends
(security review, 2026-11-14): read-mode content filtering beyond the answer (tool output still reaches the model in a
read run); a Grep over a folder can read a matching file inside a root (ripgrep skips hidden files, the answer is filtered);
live model-generated routing without any confirm; a `yes` in `/addons` for re-consent (the PC CLI is used instead, see §3.2).


Out of scope: btw (forked side questions; ruled out by the owner, 2026-11-14); forking a live session with no channel
(Remote Control covers it); dictation into desktop apps.

## 9. Decisions log

| # | Decision | Ticket |
|---|---|---|
| 1 | Private supergroup, topic per folder (ticket 22); DM is fallback only | 06 |
| 2 | Topic lifecycle: create on connect, close at end, reopen on `/resume`, delete after 7 days | 06 |
| 3 | Session output only in its topic; sessionless output in General | 06 |
| 4 | Prefixes in General only; word table as listed; `to` kept | 07 |
| 5 | No reranker, no Haiku classifier; last active session, else buttons | 12 |
| 6 | Local reranker is backlog | 12 |
| 7 | Headless flags: `--strict-mcp-config` everywhere; quick `--tools ""`; web and read use `dontAsk` with allowlists | 08 |
| 8 | Modes answer in General, threads by swipe-reply; read allowlist; Upgrade; limits; cost footer; PreToolUse re-check | 09 |
| 9 | btw removed | Map, out of scope |
| 10 | Outbound queue 15/min refilled with bursts of 5 (20 a minute at most), approvals first, honour `retry_after` | 11, 05 |
| 11 | Usage and cost in SQLite; `/usage`; daily pace alert; modes refuse above weekly limit | 11 |
| 12 | Busy session: message delivered, ⏳ queued; mode runs max 3; spawn cap 3 | 11 |
| 13 | No folder sandbox; phone-started sessions never in bypass mode | 11 |
| 14 | Approvals: release to terminal, half-TTL reminder, expired note | 11 |
| 15 | Approval relay kept; away only; owner-only verdicts | 03 |
| 16 | First-message fix: flush 1 s after registration | 01 |
| 17 | Duplicate answers: per-turn ledger, 120 s reply timeout | 02 |
| 18 | `/resume` of ended sessions in tmux; live sessions routed or pointed to Remote Control | 04, 10 |
| 19 | Topics API: `can_manage_topics`; from.id check; 20 msg/min per group | 05 |
| 20 | Stack stays TypeScript, grammY, MCP SDK; Python only for ML | 15 |
| 21 | Brain and adapters split, wired in `app.ts` | 15 |
| 22 | Order: Phase 1 fixes, then split, then topics | 15 |
| 23 | Storage: SQLite for structured state; files for log, attachments, notes, audit | 19 |
| 24 | Addons: separate programs, manifest, NDJSON over stdio, crash isolated | 18 |
| 25 | Six plug-in points; core keeps sessions, topics, prefixes, outbound, approvals, resume, log, access | 18 |
| 26 | Declared access, install from PC with yes, `/addons` to toggle, no sandbox | 18 |
| 27 | Agent backend adapter, Claude Code first, stateless where possible | 20 |
| 28 | Owner's machines first; Claude Code plugin plus npm CLI; `setup` and `service install` | 16 |
| 29 | Linux and macOS natively; Windows via WSL | 16 |
| 30 | Plugin needs the dev-channels flag unless allowlisted; tmux stays; services written by us | 17 |
| 31 | One ML worker addon; voice cleanup then digest; models unload after 10 min idle | 12 |
| 32 | Digest: configurable schedule (daily, weekly, on request), cost line; replaces v2 "on request only" | 11, 12 |
| 33 | Machine specifics as config with neutral defaults | 16 |
| 34 | In-place cutover with read-only migration script; rollback by re-enabling old service | 13 |
| 35 | New version tested on a separate new bot; old bot keeps old code | 15 |
| 36 | Chat log records topic and session as well as session name | |
| 37 | Router policy: `routerAutoStart` confirm (default) / auto / off; a model guess only preselects; auto-start only on a folder name at the start of the message; forwarded text never reaches the addon (§3.2, §4.4) | security review 2026-11-14, coordinator |
| 38 | Read mode is an allowlist of roots with argument allowlists per command; globs need a safe extension; quick and web run in a neutral folder; web hosts limited to the question and prior search results (§4.10) | security review 2026-11-14, coordinator |
| 39 | Addon manifests: `serves` lists the ops answered for other addons; user addons need re-consent (PC CLI) when the manifest changes; built-in wins a name clash; backoff is 1 s then 5 s (§3.2) | security review 2026-11-14 (re-consent on the PC is open for veto) |
| 40 | Modes cost: estimate on timeout ($0.02/min quick, $0.25/min read and web); quota checked again after the wait; at most 10 waiting runs (§4.10) | security review 2026-11-14 (rates are estimates, open for veto) |
| 41 | When the idle state is unknown, Stop summaries and Notifications still go to Telegram; asks go back to the terminal (`UNKNOWN_AWAY_NOTE`) | owner decision, 2026-11-14 |
| 42 | Idle close for all sessions, desk terminals too: 60 min idle (`idleCloseMinutes`, 0 = off), warning 5 min before with `[Keep open]`; closed only when every busy check says idle, and a check that cannot run counts as busy; start fresh, not auto-resume; `close_session` tool ends a session on the owner's request; a reply starts a session with the quoted text | owner decision, 2026-11-18 |
