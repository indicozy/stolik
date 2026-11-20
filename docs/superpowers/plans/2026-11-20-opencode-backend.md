# opencode backend (thin slice) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** From chat, the owner can start an opencode session (or a Claude one) in a new topic. opencode messages the owner through the stolik `reply` tool, and messages in the topic reach opencode.

**Architecture:** The router keeps one backend for each harness (`claude`, `opencode`) and routes each call by the session's kind. The new `OpencodeBackend` runs one `opencode serve` per session in tmux, with the TUI in a second window. It sends prompts over the server's HTTP API. The stolik MCP server (`dist/channel.js`) runs inside that server in an "opencode mode". It registers the session with the router and serves the `reply` tool.

**Tech Stack:** TypeScript (Node ≥ 22.13, `--experimental-strip-types`), `node --test`, zod config, tmux, opencode v2.2.6 HTTP API.

**Spec:** `docs/superpowers/specs/2026-11-20-opencode-backend-design.md`. Probe facts: `../stolik-assets/opencode-probe/findings.md` and `openapi.json` there.

## Changes from the spec (found while planning, 2026-11-20)

- **Registration.** The router creates sessions only from the MCP server's `register` socket message (`src/router/handlers/socket.ts` `onRegister`). So the opencode MCP server registers the session itself. It sends the spawn token, `agent: 'opencode'` and the serve pid. The adapter does not register anything. After a router restart, the MCP server reconnects and registers again, so recovery works the same way it does for Claude.
- **Persisted server records** (port, password, opencode session id, tmux name, spawn token) are kept by the adapter in its own file, `<stateDir>/opencode-servers.json` (mode 0600), not in the SQLite store. This keeps opencode specifics inside the adapter.
- **Reaction.** The existing `seen`/`queued` reaction in `deliver.ts` stays as it is. A failed POST gets a reply in the topic through a callback from the adapter.
- **The skill** is loaded into each session through `PUT /api/experimental/session/{id}/instructions/entries/stolik` (body `{ "value": <SKILL.md text> }`), with no install step. The file also lives in the repo as a real skill, `opencode/skills/stolik/SKILL.md`.
- **Model.** The local ollama has no models (probe, 2026-11-20), so opencode's configured default fails. New config `opencodeModel` (`"<providerID>/<modelID>"`, nullable) goes into session create as `model: { providerID, id }`.

## Global Constraints

- Claude behaviour does not change. Every existing test passes unchanged, except where a task says to edit a test.
- Never edit `~/.config/opencode/opencode.jsonc` or the opencode background service.
- The opencode server password never appears in logs, the audit log, chat text or test snapshots.
- opencode starts only in folders Claude trusts (`router.agent.isTrusted`, the Claude backend).
- Run builds and tests pinned: `CARGO_BUILD_JOBS=12 $(ai-resources prefix) npm run build` and `$(ai-resources prefix) npm test`. Long jobs write a done-file (`…; echo $? > X.done`). Poll it in the foreground, at most 4 minutes per tool call.
- Commit after each task. End commit messages with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- `AgentKind = 'claude' | 'opencode'`. A session with no kind is `'claude'`.

## Review Focus

1. A Claude session after this change: route, `new x:`, resume, approvals and sweep all behave as before. (Task 2 keeps the full suite green; Task 4 tests `new x:` still starts Claude.)
2. A router restart while an opencode session runs: the MCP re-registers, and the adapter must find its server record again by spawn token. (Task 5 test `restores records from file`.)
3. The opencode server is dead (killed in tmux) when a message arrives: the owner gets "Couldn't deliver to opencode: …" in the topic, and the router does not crash. (Task 5 test `post failure reports`.)
4. Two opencode sessions in different folders at once: each message goes to its own server. (Task 5 test `two servers route separately`.)
5. The sweep must not drop an opencode session whose serve pid is alive. (Task 2 test.)

---

### Task 1: Kinds, config and the session's kind

**Files:**
- Modify: `src/brain/sessions.ts` (Session type, `newSession`)
- Modify: `src/router/shared.ts:81` (`SpawnQueue`)
- Modify: `src/config.ts` (schema near `claudeModel` at ~308, doc comment ~170-200)
- Modify: `src/ports.ts` (export `AgentKind`)
- Test: `test/opencode-config.test.ts`

**Interfaces:**
- Produces: `export type AgentKind = 'claude' | 'opencode'` in `src/ports.ts`. `Session.agent: AgentKind` (`newSession` sets `'claude'`). `SpawnQueue.agent: AgentKind`. Config `defaultAgent: 'claude'|'opencode'` (default `'claude'`) and `opencodeModel: string|null` (default `null`, regex `^[A-Za-z0-9._-]+/[A-Za-z0-9._:/-]+$`).

- [ ] **Step 1: Write failing tests:** `parseTgConfig` with no keys gives `defaultAgent === 'claude'` and `opencodeModel === null`; `{defaultAgent:'opencode', opencodeModel:'openrouter/qwen/qwen3-coder'}` parses; `{defaultAgent:'gpt'}` throws; `{opencodeModel:'noslash'}` throws; `newSession(...)` gives `.agent === 'claude'`.
- [ ] **Step 2: Run** `$(ai-resources prefix) node --test --experimental-strip-types test/opencode-config.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the types and config keys. Add doc lines for both keys in the config comment block. Add `agent: 'claude'` wherever a `SpawnQueue` literal is built (`spawn.ts`).
- [ ] **Step 4: Run** the new test plus `npx tsc -p . --noEmit`. Expected: PASS, no type errors.
- [ ] **Step 5: Commit** `Opencode: agent kinds and config keys`.

### Task 2: The router routes calls by the session's kind

**Files:**
- Modify: `src/router/core.ts` (`RouterDeps`, fields ~62/114/234; start/stop ~294/393)
- Modify: every session-keyed `router.agent.*` call site: `deliver.ts:35,211,221,281`, `handlers/resume.ts:16`, `handlers/callbacks.ts:90,105`, `handlers/socket.ts:76,81,88`, `handlers/timers.ts:113-115`, `spawn.ts:204`, `addon-bridge.ts:276`
- Modify: `spawn.ts` tmux-name calls (`:127,133,148,175,193,223`) to use the queue's kind
- Modify: `test/helpers/fakes.ts` (`harness` option `opencodeAgent?: FakeAgent`)
- Test: `test/agent-dispatch.test.ts`

**Interfaces:**
- Consumes: `AgentKind`, `Session.agent`, `SpawnQueue.agent` (Task 1).
- Produces: `RouterDeps.agents?: Partial<Record<AgentKind, AgentBackend>>` (`agent` stays required and is the Claude backend). `Router.agentOf(kind: AgentKind): AgentBackend` (throws `Error('no backend for <kind>')` when missing). `Router.agentFor(key: SessionKey): AgentBackend` (the session's kind; an unknown key gives the Claude backend). Router `start()`/`stop()` start and stop every backend. Only Claude gets the socket handler; the others get `start(handler)` with the same handler. `harness({ opencodeAgent })` registers a second `FakeAgent` as `'opencode'`.

- [ ] **Step 1: Write failing tests** with `harness({ opencodeAgent })`:
  - `agentFor routes sends`: a session whose `.agent = 'opencode'` and that is marked connected in the opencode fake. Delivering a text to it records it in `opencodeAgent.sent`, not in `agent.sent`.
  - `sweep keeps opencode session`: an opencode session with a pid the Claude fake calls non-interactive is still in the registry after the sweep tick.
  - `claude unchanged`: an existing route test path still records in `agent.sent`.
- [ ] **Step 2: Run** `$(ai-resources prefix) node --test --experimental-strip-types test/agent-dispatch.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `agentOf`/`agentFor` and replace the listed call sites. In the timers sweep, use `router.agentFor(s.key).isInteractive(s.pid)` and `.dropSession`. In `spawn.ts`, use `router.agentOf(q.agent)` for the queue-bound calls. In `resumeEnded`, use `'claude'`. `socket.ts:76` `detachSession(conn)` is keyed by connection: ask every backend in turn and use the first non-null key. Leave the trust, transcript, pid-only (`socket.ts:94,217,362`, `ask.ts:39`) and `respondToAsk` calls on `router.agent`.
- [ ] **Step 4: Run** the new test, then the full suite (`$(ai-resources prefix) npm test`, done-file + poll). Expected: all pass.
- [ ] **Step 5: Commit** `Router: route agent calls by the session's kind`.

### Task 3: Register opencode sessions and give the MCP server an opencode mode

**Files:**
- Modify: `src/adapters/channel/protocol.ts:6` (`ChRegister`)
- Modify: `src/adapters/channel/channel.ts` (capabilities 62-70, register 159-165, `onRouterMessage` ~100)
- Modify: `src/router/handlers/socket.ts` (`onRegister` ~91)
- Modify: `src/router/spawn.ts` (`claimSpawn`)
- Test: `test/opencode-register.test.ts`

**Interfaces:**
- Consumes: `agentOf`, `Session.agent`, `SpawnQueue.agent`.
- Produces: `ChRegister` gains `agent?: 'opencode'` and `agentPid?: number`. In opencode mode (`process.env.STOLIK_AGENT === 'opencode'`), `channel.ts` advertises `capabilities: { tools: {} }` only. It registers with `{ t:'register', claudePid: null, agent:'opencode', agentPid: process.ppid, cwd: process.cwd(), spawnToken }` and ignores the inbound `inbound`/`permission` socket messages (logs one line). The `reply` and `close_session` tools behave the same as before. In `onRegister`, for `msg.agent === 'opencode'`: skip the Claude `isInteractive` check, use `procRef(msg.agentPid)` for the registry claim, set `s.agent = 'opencode'`, and call `router.agentOf('opencode').attachSession(s.key, conn)`. The adapter must also learn which server this is: `OpencodeBackend.bindToken(key: SessionKey, spawnToken: string): void` is called right after `attachSession` when the message has a spawn token. Declare it on `AgentBackend` as an optional method `bindToken?(key, spawnToken): void`.

- [ ] **Step 1: Write failing tests** (harness with `opencodeAgent`, `FakeConn`):
  - `opencode register creates opencode session`: a register with `agent:'opencode', agentPid: <pid>, spawnToken` matching a queued spawn whose `agent:'opencode'` creates a session with `.agent === 'opencode'`, attaches it in the opencode fake (not the Claude one) and flushes the queued message to `opencodeAgent.sent`.
  - `opencode register calls bindToken` with the token.
  - `claude register unchanged`: the existing register test still passes.
  - A unit test for a pure helper `channelCapabilities(agent: string | undefined)` exported from `channel.ts`. It returns no `experimental` key for `'opencode'`, and both `claude/channel` keys otherwise.
- [ ] **Step 2: Run** the test. Expected: FAIL.
- [ ] **Step 3: Implement** as in Interfaces. Add `bindToken` to `FakeAgent` (it records `bound: [key, token][]`).
- [ ] **Step 4: Run** the new test and the full suite. Expected: PASS.
- [ ] **Step 5: Commit** `Channel: opencode mode and opencode session registration`.

### Task 4: Choosing the harness when a session starts

**Files:**
- Modify: `src/brain/prefixes.ts` (`PrefixKind`, `PREFIX_WORDS`, `NAME_KINDS`, `WORD_RE`)
- Modify: `src/router/handlers/prefix.ts` (`runPrefix`)
- Modify: `src/router/state.ts` (`launchRows` 306, `startRows` 317, `RouteCallback` 333, `parseRouteCallback` 341, `RoutePending`)
- Modify: `src/router/handlers/route.ts` (`READ_ONLY_ARGS` 30, auto-start ~254, `startNewFromPrefix` 308, `launch` 582, `startFolder` 570)
- Modify: `src/router/spawn.ts` (`SpawnOptions.agent?: AgentKind`; `--model` only for Claude; queue `agent`)
- Test: `test/opencode-start.test.ts`

**Interfaces:**
- Consumes: `Router.agentOf`, `SpawnQueue.agent`, config `defaultAgent`.
- Produces:
  - New prefix kind `'oc'` with words `['oc', 'opencode']`, which needs a name (`oc stolik: hi`). The phrases `new oc` / `new opencode` parse as kind `'oc'`.
  - Callback data `rt:l:<id>:(ro|full|oro|ofull)`. `RouteCallback` `l` becomes `{ kind:'l'; pendingId; readOnly: boolean; agent: AgentKind }`.
  - `launchRows` gives two rows: `[Claude] [Claude read-only]` and `[opencode] [opencode plan]`, with labels exactly as written. `startRows` gives `[Full] [👁 Read-only] [opencode] [Other…]`, where `[opencode]` is `ofull`.
  - Read-only args: Claude `['--permission-mode','plan']`, opencode `['--agent','plan']`.
  - `spawnFor(..., options: { agent?: AgentKind })` passes the kind to the queue and calls `router.agentOf(agent).startSession`. The `--model` argument is added for Claude only.
  - Auto-start and name-hit starts use config `defaultAgent`.

- [ ] **Step 1: Write failing tests:**
  - `parsePrefix('oc stolik: hi')` gives `{kind:'oc', name:'stolik', body:'hi'}`; `new oc stolik: hi` gives the same; `new stolik: hi` stays `'new'`.
  - `parseRouteCallback('rt:l:0123abcd:ofull')` gives `{kind:'l', readOnly:false, agent:'opencode'}`; `:ro` gives `agent:'claude'`.
  - Harness with `opencodeAgent` and a trusted folder `stolik`: `oc stolik: hi` → the opencode fake's `startedSessions` has one entry, the Claude fake's has none; `new stolik: hi` → Claude only. The `[opencode plan]` tap passes `['--agent','plan']`.
- [ ] **Step 2: Run** the test. Expected: FAIL.
- [ ] **Step 3: Implement** as in Interfaces.
- [ ] **Step 4: Run** the new test and the full suite. Expected: PASS.
- [ ] **Step 5: Commit** `Start: pick claude or opencode when a session starts`.

### Task 5: OpencodeBackend

**Files:**
- Create: `src/adapters/agent/opencode.ts`
- Create: `src/adapters/agent/opencode-http.ts` (a small HTTP client: `ocFetch(rec, method, path, body?)` with basic auth `opencode:<password>`, 5 s timeout)
- Create: `opencode/skills/stolik/SKILL.md` (Task 6 writes the final text; for now a placeholder with frontmatter `name: stolik` and `description`)
- Modify: `src/adapters/tmux.ts` (`tmuxNewSessionArgs`/`startTmux` take an optional `launcher argv` instead of the hard-coded `bin/tg-claude`; the default stays `tg-claude`)
- Modify: `src/app.ts:~199` (wire `agents: { opencode: new OpencodeBackend({...}) }`; `onDeliveryError` → router)
- Modify: `src/router/core.ts` (`Router.reportDeliveryError(key: SessionKey, reason: string): Promise<void>` says `Couldn't deliver to opencode: <reason>` in the session's topic)
- Test: `test/opencode-backend.test.ts` (fake HTTP server on 127.0.0.1:0, fake tmux runner)

**Interfaces:**
- Consumes: `AgentBackend` (`src/ports.ts:56`), `bindToken` (Task 3), the `startTmux` launcher param.
- Produces: `class OpencodeBackend implements AgentBackend`, constructor `{ stateDir: string; model: string | null; socketPath: string; channelScript: string; opencodeBin?: string; tmux?: TmuxRun; fetchImpl?: typeof fetch; onDeliveryError: (key: SessionKey, reason: string) => void; now?: () => number }`.
  - Record type `OcServer = { token: string; tmuxName: string; port: number; password: string; sessionId: string | null; dir: string; agent: 'build' | 'plan' }`, saved to `<stateDir>/opencode-servers.json` (0600) on every change and loaded in the constructor.
- Behaviour:
  1. `startSession(project, dir, args, token)`:
     - Pick a free port: listen on 0, close, use that port.
     - Make a password with `randomBytes(24).toString('base64url')`.
     - Read the agent from `args` (`--agent plan` → `plan`, else `build`).
     - Tmux name `oc-<project>`, with the `tmuxNameFor` rules and the `oc-` prefix.
     - Window 0 runs `opencode serve --hostname 127.0.0.1 --port <port>` in `dir`, with env `OPENCODE_PASSWORD`, `STOLIK_AGENT=opencode`, `STOLIK_SOCKET`, `STOLIK_SPAWN_TOKEN`, and `OPENCODE_CONFIG_CONTENT={"mcp":{"stolik":{"type":"local","command":["<node>","<channelScript>"]}}}`, where `<node>` is `process.execPath`.
     - Save the record and return the tmux name.
     - Then, without blocking the return, poll `GET /health` (every 500 ms, up to 30 s). Then `POST /api/session` with `{ title: project, agent, location: { directory: dir }, model? }`, where model is split from `opencodeModel` on the first `/` into `{ providerID, id }`.
     - Then `PUT /api/experimental/session/{id}/instructions/entries/stolik` with `{ value: <SKILL.md body without frontmatter> }`.
     - Then open the TUI: `tmux new-window -t <name>` running `opencode --server http://127.0.0.1:<port> --session <id> <dir>` with env `OPENCODE_PASSWORD`.
     - Save `sessionId`. Any failure is logged without the password, and the session simply never registers (the router's spawn timeout reports it).
  2. `bindToken(key, token)` maps the key to the record. `attachSession`/`detachSession`/`dropSession`/`isConnected` keep a key→conn map, as the Claude backend does.
  3. `sendToSession(key, content, meta)`:
     - Return false when the key is not bound or the record has no `sessionId`.
     - Otherwise start `POST /api/session/{id}/prompt` with `{ text: header + content, delivery: 'queue' }` and return true. The header is `[stolik] Message from the owner's chat. Answer with the stolik reply tool.\n\n`.
     - Attachments: for `meta.image_path`/`meta.file_path`, add `files: [{ uri: 'file://' + path }]`.
     - A non-2xx answer or a network error calls `onDeliveryError(key, '<status or error message>')`.
  4. `killSession(name)`: `POST /api/session/{id}/interrupt` (errors ignored), then `killTmuxSession(name)`, then delete the record.
     - `panePid(name)` → `tmuxPanePid(name)` (window 0 is the serve process).
     - `paneTail(name)` → tmux pane tail.
     - `watchStartup(name, timeoutMs, isRegistered)` polls `isRegistered()` every 500 ms until true (`'registered'`), the tmux session is gone, or the timeout passes. Use the same `StartupOutcome` values as `tmux.ts`.
  5. `isInteractive(pid)`: true when the pid is alive (`process.kill(pid, 0)`), or when pid is null.
     - `isTrusted`/`trustedFolders`: return false / `[]`. Trust stays with the Claude backend.
     - `listTranscripts` → `[]`; `liveSessionIds` → empty Map; `sweep()` → no-op.
     - `answerPermission` → false; `respondToAsk` → no-op.
     - `start()`/`stop()` → resolve (no socket of its own); `onEvent` → no-op.
     - `startCommand(project, dir, args)` returns the serve argv without the password.

- [ ] **Step 1: Write failing tests** against a fake HTTP server that checks basic auth and records requests:
  - `startSession runs serve in tmux with env`: the fake tmux sees `new-session` with `oc-stolik`, `opencode serve --hostname 127.0.0.1 --port <n>`, `STOLIK_AGENT=opencode`, `STOLIK_SPAWN_TOKEN=<token>`, and an `OPENCODE_CONFIG_CONTENT` that contains `"stolik"`. The `startCommand` output has no password.
  - `after health it creates the session, loads the skill, opens the TUI`: requests in order `GET /health`, `POST /api/session` (body has `location.directory`, `agent:'plan'` when args have `--agent plan`, `model:{providerID:'openrouter',id:'qwen/qwen3-coder'}` for `opencodeModel:'openrouter/qwen/qwen3-coder'`), `PUT …/instructions/entries/stolik`. Then tmux `new-window` with `--session <id>`.
  - `sendToSession posts prompt`: after `bindToken`, it returns true, and the fake server gets `POST /api/session/<id>/prompt` with the header plus the text and `delivery:'queue'`.
  - `post failure reports`: the server answers 500 → `onDeliveryError` is called once with the key and a reason containing `500`. A closed port → called with the error message. The password is not in the reason.
  - `two servers route separately`: two records with two tokens → each key's prompt reaches its own port.
  - `restores records from file`: a new `OpencodeBackend` with the same `stateDir` → `bindToken` of a saved token works, and the file mode is `0o600`.
  - `unbound send returns false`.
- [ ] **Step 2: Run** `$(ai-resources prefix) node --test --experimental-strip-types test/opencode-backend.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the adapter, the HTTP helper, the tmux launcher param, the `app.ts` wiring and `Router.reportDeliveryError`. Find the session's topic target the same way the existing `notConnected` path in `deliver.ts` does.
- [ ] **Step 4: Run** the new test, `npx tsc -p . --noEmit` and the full suite. Expected: all pass.
- [ ] **Step 5: Commit** `Opencode backend: serve per session, HTTP prompts, skill per session`.

### Task 6: Skill text, docs, build and live smoke

**Files:**
- Modify: `opencode/skills/stolik/SKILL.md` (final text)
- Modify: `docs/design-v3.md` §3.3 (opencode is now a backend; one line on each harness having its own adapter)
- Modify: `README.md` (a short "opencode" section: `oc <project>:`, the `[opencode]` buttons, `opencodeModel`)
- Modify: `package.json` `files` field, if there is one, to include `opencode/`

- [ ] **Step 1: Write the SKILL.md body** from `claude-rule.md`, trimmed to what applies to opencode:
  - You are bridged to the owner's phone through stolik.
  - Use the `reply` tool when you finish a task, are blocked, need a decision, or find something surprising. Lead with what the owner must know or decide. Use one or two sentences.
  - Do not message for routine progress.
  - Messages that start with `[stolik]` come from the owner; answer them with `reply`.

  Run the text and the README section through the `ste80-humanizer:ste80-humanizer` skill.
- [ ] **Step 2: Build**: `$(ai-resources prefix) npm run build; echo $? > build.done` (poll). Expected: exit 0.
- [ ] **Step 3: Full tests** pinned, with a done-file. Expected: all pass.
- [ ] **Step 4: Live adapter smoke (no chat)**: a script `scripts/opencode-smoke.ts` runs `OpencodeBackend.startSession('smoke', <scratch dir under ../stolik-assets/opencode-probe/proj>, [], 'smoke-token')`. It waits for `sessionId`, checks `GET /api/mcp` lists `stolik`, checks `GET /api/session/<id>/...instructions` has `stolik` (if a list endpoint exists), and then calls `killSession`. Expected: the script prints `OK` and `pgrep -f 'opencode serve --hostname 127.0.0.1'` finds none of its servers.
- [ ] **Step 5: Commit** `Opencode: skill text, docs, smoke script`.
- [ ] **Step 6 (with the owner): end to end in chat.**
  - Restart `stolik.service`.
  - Send `oc stolik: say hi on telegram` → a topic opens → opencode calls `reply` → the owner answers in the topic → opencode answers again.
  - Then a Claude start, to check that nothing changed.
  - This needs a working `opencodeModel` (the owner picks it).
