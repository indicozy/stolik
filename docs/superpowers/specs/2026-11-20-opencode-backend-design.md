# opencode backend (thin slice): design

Date: 2026-11-20. Status: draft for the owner's approval.

## Intent

The owner wants to run opencode sessions from Telegram/Discord next to Claude Code sessions. When a new topic starts,
the owner chooses the harness: claude or opencode. An opencode session messages the owner when it needs to (a skill
tells it when), and the owner's chat messages reach that opencode session.

Each harness family gets its own adapter that speaks that harness's own API (owner, 2026-11-20). There is no single
adapter that tries to cover every harness: one for Claude Code (exists), one for opencode (this design), and later one
each for Codex, Gemini and others.

This is the thin first slice (owner, 2026-11-20). Full parity with Claude sessions comes later, if at all.

## Goals

1. When a session is started from chat, the owner can pick **claude** or **opencode**. The new session gets its own
   topic, as Claude sessions do today.
2. The opencode session has a `reply` tool (stolik MCP) and a **stolik skill** that tells it when to use the tool:
   finished, blocked, needs a decision, or something surprising. Its messages appear in the session's topic.
3. Messages the owner writes in that topic are delivered into the opencode session as prompts.
4. The owner can attach to the session at the desk (tmux, opencode TUI), as with Claude sessions.

## Non-goals (this slice)

- Tool approvals from chat. The owner's opencode config allows every action, so nothing asks. If opencode does raise a
  permission request, it waits in the TUI.
- Resume and the transcript list for opencode, idle/away handling, end-of-turn forwarding, usage/cost, the router
  addon's model guess for opencode, questions/plan approval.
- Sessions that the owner starts by hand at the desk (`opencode` in a terminal). Only sessions that stolik started are
  bridged.
- Codex, Gemini and other harnesses. The design only must not block them.

## Anti-goals

- No change in how Claude sessions behave. Claude stays the default, and every current flow (route, `new …:`, resume,
  approvals, hooks) works exactly as before.
- No lowest-common-denominator layer. opencode specifics (HTTP API, server password, skills folder) stay inside the
  opencode adapter. Claude specifics stay inside `claude-code.ts`.
- The router must not parse opencode wire formats.

## Constraints and facts found (2026-11-20)

- opencode v2.2.6 is installed at `~/.opencode/bin/opencode`. Config: `~/.config/opencode/opencode.jsonc` (default
  model `ollama/qwen3-coder:30b`, all permissions allowed, MCP servers under `mcp`).
- `opencode serve --port N --hostname 127.0.0.1` runs an HTTP server with an OpenAPI 3.1 spec at `/openapi.json`. It
  uses basic auth: user `opencode`, with a password that it prints at start (`server password …`). The background
  service keeps its password in `~/.config/opencode/service.json`.
- The relevant endpoints: `POST /api/session` (create; body has `id`, `title`, `agent`, `model`, `location`, …),
  `POST /api/session/{id}/prompt` (body `{ text, files?, … }`), `GET /api/session/{id}/inbox` (queued input),
  `GET /api/event` (SSE), `POST /api/session/{id}/interrupt`, `GET /api/session/active`, and permission endpoints
  (not used in this slice).
- The TUI attaches to a server with `opencode --server <url> --session <id> <dir>`.
- stolik today: the router holds one `agent: AgentBackend` (`src/router/core.ts`). The start flow is
  `src/router/handlers/route.ts` (folder picker, `new <project>:`, [Read-only] [Full]) → `spawnFor`
  (`src/router/spawn.ts`) → `agent.startSession` → the session registers over the socket with its spawn token.
  `SessionKey = number | string`.
- Claude uses MCP in both directions. Inbound works only through Claude Code's development-channels extension
  (`notifications/claude/channel`). opencode has nothing like that, so inbound for opencode goes through its HTTP API.

## Approaches considered

- **A. MCP for outbound, the opencode server API for inbound (chosen by the owner, 2026-11-20).** stolik starts
  opencode in tmux. The stolik MCP `reply` tool sends messages out. The adapter posts the owner's messages to
  `POST /api/session/{id}/prompt`. Each direction uses an opencode feature that is meant for it. The TUI stays
  attachable.
- B. An opencode JS plugin that connects to stolik's socket and both adds the tool and injects input. Everything is in
  one piece, but it ties us to opencode's plugin API, which changes faster than its HTTP API, and it needs a per-user
  plugin install. Rejected.
- C. Headless HTTP only, posting each turn's final text. The simplest, but it drops "message me when needed" (it sends
  every turn) and it has no TUI. Rejected.

## Design

### 1. Several backends in the router

- The router holds `agents: Map<AgentKind, AgentBackend>`, with `AgentKind = 'claude' | 'opencode'`. `router.agent`
  stays as the Claude backend, so the existing code keeps working unchanged. New code looks up the backend that
  belongs to a session.
- Each session record stores its `agent` kind. Records that existed before this change have no kind and count as
  `claude`.
- Dispatch (my call, after the builder check): `router.agent` is not enough on its own. Today many call sites pass a
  session key to `router.agent` (`deliver.ts` `isConnected`/`sendToSession`, `callbacks.ts`, `socket.ts`, `spawn.ts`
  `killSession`/`panePid`, `timers.ts`). Each call that is keyed by a session goes through one helper,
  `router.agentFor(key)`, which reads the session's kind. Calls that are not keyed by a session (trust, transcripts,
  the socket server) stay on the Claude backend.
- The sweep in `timers.ts` (around line 113) drops sessions whose pid is not an interactive Claude process. It must
  skip sessions whose kind is not `claude`. An opencode session stores the pid of its `opencode serve` process, and
  its liveness check is the opencode adapter's (see §3.5).
- `AgentBackend` is not widened to fit opencode. The opencode adapter implements the methods it can. Methods that make
  no sense for it (`isTrusted`, `trustedFolders`, `listTranscripts`, `liveSessionIds`, `watchStartup`, `isInteractive`)
  return neutral values or are made optional. Builder's call: which ones become optional and which return neutral
  values. Any router code that calls them must keep working for Claude sessions.

### 2. Picking the harness when a session starts

- The start buttons get the harness choice. The current [Read-only] [Full] row becomes two rows, or the labels name
  the harness, e.g. [Claude] [Claude read-only] / [opencode] [opencode plan]. Builder's call on the exact layout; it
  must stay one tap to start.
- The prefix `new <project>:` keeps starting Claude, as now. `oc <project>:` and `new oc <project>:` start opencode.
  (My call: a short prefix, because typing on a phone is slow. The owner may rename it.)
- Folders (owner, 2026-11-20): opencode may start only in folders that Claude trusts (the list in `~/.claude.json`,
  through the Claude backend's `isTrusted` and `trustedFolders`). The picker is the same for both harnesses. The
  opencode adapter has no trust list of its own in this slice. Later (owner): a separate opencode list in stolik's
  config, used together with the Claude list.
- Config `defaultAgent: 'claude' | 'opencode'` (default `claude`) decides what auto-start and the name-hit flows use.
- Read-only for opencode means starting with opencode's `plan` agent (`--agent plan` or the `agent` field on create).
  The model comes from opencode's own config unless stolik's model setting names an opencode model
  (`provider/model`). Builder's call: whether stolik's current model setting applies to opencode at all; the safe
  default is that it does not.

### 3. The opencode adapter (`src/adapters/agent/opencode.ts`)

Process model (my call; the builder confirms it in the first step): **one `opencode serve` per stolik session**, so
that the MCP server process and its environment belong to exactly one session.

1. `startSession(project, dir, args, spawnToken)`:
   - Pick a free local port. Start `opencode serve --hostname 127.0.0.1 --port <port>` in `dir`, inside a tmux session
     (window 0, kept for logs). Use the same tmux naming, cgroup/`ai-run` wrapping and nice level that Claude starts
     use. The environment carries `STOLIK_SPAWN_TOKEN`, `STOLIK_AGENT=opencode` and the router socket path, so the MCP
     server that opencode launches inherits them.
   - Read the server password from its output. If opencode supports setting the password by env or flag, set our own
     random one instead. Builder's call, verified against v2.2.6.
   - `POST /api/session` with a title (the project name) and the agent (`build` or `plan`). Keep the session id.
   - Open the TUI in a second tmux window: `opencode --server http://127.0.0.1:<port> --session <id> <dir>`. The owner
     attaches with tmux.
   - Return the tmux session name. Keep `{ port, password, sessionId, tmuxName, serverPid }` in the store with the
     session's kind (my call, after the builder check). After a router restart, the adapter reloads these records,
     checks that each server still answers, and reattaches the sessions that do. Records whose server is gone are
     marked ended. The password is a secret: it goes in the state folder only (which is private to the user), and it
     never goes into logs, the audit log or chat.
2. Registration: the adapter registers the session with the router itself (it knows the spawn token). It does not wait
   for the MCP server to say hello. The MCP server registers too, when opencode starts it, and the router matches it to
   the same session by the spawn token from its environment. Either order must work.
3. `sendToSession(key, content, meta)`: `POST /api/session/{id}/prompt` with `{ text }`. Before the text, add a short
   header line saying the message came from the owner's chat and how to answer (the `reply` tool). This plays the role
   of the channel `meta` that Claude gets. Attachments (`image_path`, `file_path`) go in as `files` with `file://` URIs.
   If the session is busy, opencode queues the prompt (its inbox). Builder's check: does `prompt` block until the turn
   ends? If it does, send it without awaiting the turn.
   Delivery feedback (my call, after the builder check): `sendToSession` returns true when the session is known and
   its server was answering at the last check, as today. The "delivered" reaction is set only after opencode accepts
   the POST (2xx). A failed POST (server down, auth error, rejected) gets a short reply in the topic: "Couldn't
   deliver to opencode: <reason>". The message is not retried by itself.
4. `killSession`: interrupt the session, stop the server and kill the tmux session.
5. Liveness: `isConnected(key)` is true while the server answers. When the server process exits, the adapter tells the
   router that the session closed, so the topic shows it as ended, as with Claude.
6. SSE (`/api/event`) is not needed for this slice. The builder may use it for liveness if that is simpler than
   polling.

### 4. The MCP server for opencode

- Reuse `dist/channel.js`. When `STOLIK_AGENT=opencode`, it:
  - advertises only the tools (`reply`, and `close_session` if it fits), without the `claude/channel` and
    `claude/channel/permission` experimental capabilities;
  - registers with the router using the spawn token from its environment, and no Claude pid lookup;
  - drops inbound `message`/`permission` socket messages, because the adapter delivers inbound over HTTP.
- Registration: the opencode adapter adds the stolik MCP server to the per-session server. It does this through the
  config that is passed to that `opencode serve` (env or a generated config file in the stolik state folder), or with
  `PUT /api/experimental/mcp/stolik` after start. Builder's call; the owner's global `opencode.jsonc` must not be
  edited.

### 5. The stolik skill for opencode

- A skill file `opencode/skills/stolik/SKILL.md` lives in the repo. `install.sh` links or copies it to opencode's
  skills folder. Builder: confirm where v2.2.6 reads skills from (the API has `Skill.ID` and
  `experimental.session.skill`).
- Content: you are bridged to the owner's phone; use `reply` when you finish a task, are blocked, need a decision, or
  find something surprising; keep messages short and lead with what the owner must know or decide; do not message for
  routine progress; messages that start with the stolik header come from the owner, so answer them with `reply`.
  Base it on `claude-rule.md`, trimmed to what applies. It is public text, so it goes through the humanizer before it
  ships.
- If skills do not load reliably in a session that stolik started, the adapter activates the skill on create
  (`experimental.session.skill`), or puts the same text in the session instructions
  (`experimental.session.instructions.entry.put`).

### 6. Model risk

The default model is a local `qwen3-coder:30b`. Whether it calls `reply` at the right times is the main product risk.
The first end-to-end test (below) shows whether the slice works with the owner's default model. If it does not, the
fallback is to name a stronger model on start. That is the owner's decision, not the builder's.

## Testing

- Unit: harness choice in the start buttons and prefixes; session records default to `claude`; the router picks the
  backend by session kind; `channel.js` in opencode mode advertises no Claude capabilities and ignores inbound.
- Adapter: a test against a fake HTTP server for create, prompt and kill. Plus one opt-in live test against the real
  `opencode serve` (skipped when opencode is missing).
- End to end (manual, with the owner): `oc stolik: say hi on telegram` → a topic opens → opencode calls `reply` →
  the message shows in the topic → the owner answers in the topic → opencode gets it and replies again. Then a Claude
  start, to check that nothing changed for Claude.

## Left to the builder

Marked "builder's call" above: the button layout, optional vs neutral backend methods, password handling, how MCP is
registered for the per-session server, whether `prompt` blocks, liveness through SSE or polling, and where skills are
read from. Everything else above is decided.
