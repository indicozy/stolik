# Install stolik

stolik runs a router in your logon session. It talks to Telegram and to Claude Code sessions through tmux. The
Claude Code side is a plugin (`plugin/`) that loads a channel server and hooks.

You need: Node 22.13 or newer, tmux, Claude Code, and a bot token from @BotFather.

Plan and design: `docs/plan-v3.md` (P3, P4, P5), `docs/design-v3.md` (§5, §6.2).

## Linux

`./install.sh` runs steps 1 and 2 (`npm ci`, `npm run build`, then `stolik setup`) and prints the rest. It does not
register an MCP server or touch `~/.claude/settings.json`; the plugin in step 5 does the Claude side.

1. Install the package. The npm way, which puts the `stolik` command (and the `stolik` alias) on your PATH:

   ```sh
   npm install -g stolik
   ```

   Do not use `npx` for this. npx runs from npm's cache, which can be cleaned, and the service must point at a copy
   that stays put. `stolik service install` refuses to run from the cache.

   From a checkout instead (for development):

   ```sh
   git clone https://github.com/indicozy/stolik.git ~/Documents/projects/stolik
   cd ~/Documents/projects/stolik
   npm ci && npm run build && npm link
   ```

2. Run setup. It asks for the bot token (hidden), then pairs the bot with your Telegram account. Setup prints a
   six-digit code. Send it to the bot in a private chat (not a group). The code works for 5 minutes and 5 tries.
   Setup then shows the account that sent it and asks you to confirm with `y`. It writes `~/.config/stolik.env`
   (chmod 600, with `STOLIK_TOKEN`; `TG_CHAT` is set to the owner's id when it is missing or the owner changes) and
   `~/.config/stolik/config.json` (the owner goes to `chat.telegram.ownerUserId`), prints the group and plugin
   steps, and offers the optional ML worker (see below):

   ```sh
   stolik setup
   ```

   An install that already has an owner is not asked again. Run `stolik setup --pair` to pair again.
   `stolik setup --owner-id <n>` sets the owner without pairing, for scripts and tests. `--chat telegram` is the
   default. `--chat discord` is not available yet.

   The router can keep running during pairing. Setup asks it to listen for the code. Until the owner pairs, the
   router answers nobody, and `stolik doctor` reports "not paired yet".

3. Group: create a private supergroup, turn Topics on, add the bot as admin with "Manage topics" and "Delete
   messages", then send `/bind` in the group. The router checks that the sender is you.

4. Service: write the systemd user unit and start it. Without `--start` the command only writes the unit. If the unit
   is already running, `--start` restarts it so the new definition applies.

   ```sh
   stolik service install --start
   stolik service status
   journalctl --user -u stolik -f
   ```

   The unit uses `KillMode=process`, so restarting the router leaves the tmux server and the Claude Code sessions
   in it running. The tmux server runs in its own systemd scope, so `CPUAffinity` and `Nice` apply to the router only.

5. Plugin, inside Claude Code (run once):

   ```
   /plugin marketplace add ~/Documents/projects/stolik/plugin
   /plugin install stolik@indicozy
   ```

   Start Claude with the channel on: `claude --dangerously-load-development-channels plugin:stolik@indicozy`.
   Or use `STOLIK_PLUGIN=1 tg-claude`, which adds the same flag. Without `STOLIK_PLUGIN=1`, `tg-claude` expects a
   user-level MCP server named `stolik`, which nothing creates now.
   With the global install, the plugin folder is `$(npm root -g)/stolik/plugin`; `stolik setup` prints the exact path.

Idle and lock detection use logind (`loginctl`). For X11 without logind, set `"presence": "x11"` in `config.json`.

## ML worker (optional: voice, voice cleanup, digest)

The ML worker runs faster-whisper (voice notes) and a local Qwen3-4B (voice cleanup, digest). It lives in `ml/.venv`
and loads each model on first use; models download on first use and unload after 10 minutes idle. Without it, the
voice, voice-cleanup and digest addons stay off.

`stolik setup` asks at step 5 (default no). If you say yes, it prints the build environment and the exact commands,
asks again, then runs them. An existing `ml/.venv` is reused, never removed. A folder at that path with no
`bin/python` is refused: move it aside and run setup again.

What it needs:

- `uv` (https://docs.astral.sh/uv/). uv creates the Python 3.12 venv.
- A C++ compiler and CMake. `llama-cpp-python` has no CUDA wheel, so it is built from source on every install.
- For the GPU build only: the CUDA toolkit (`nvcc`). Setup looks in `$CUDA_HOME`, `/usr/local/cuda` and PATH.
  With nvcc it builds with `CMAKE_ARGS="-DGGML_CUDA=on"` and `CUDACXX`. CUDA 13.2 refuses a host compiler newer than
  gcc 15, so when gcc-15 and g++-15 are installed, setup also sets `CC`, `CXX`, `CUDAHOSTCXX`, `NVCC_CCBIN` and
  `-DCMAKE_CUDA_HOST_COMPILER` to them. Without gcc-15 it says so and uses the default compiler.
- Without nvcc: a CPU-only build, no extra environment. This works; the models just run on the CPU.

The requirements are `ml/requirements.txt`, pinned to the versions of the working venv. The same install by hand:

```sh
uv venv --python 3.12 ml/.venv
# CUDA build (example paths; use the environment setup prints):
CMAKE_ARGS="-DGGML_CUDA=on -DCMAKE_CUDA_HOST_COMPILER=/usr/bin/g++-15" CUDACXX=/usr/local/cuda/bin/nvcc \
  CC=/usr/bin/gcc-15 CXX=/usr/bin/g++-15 CUDAHOSTCXX=/usr/bin/g++-15 NVCC_CCBIN=/usr/bin/g++-15 \
  uv pip install --python ml/.venv/bin/python -r ml/requirements.txt --no-binary llama-cpp-python
# CPU only: the same command without the environment variables.
```

GPU use is set in `config.json` (`gpu`, see Configuration). The default is CPU. Check the install with the venv's Python:

```sh
ml/.venv/bin/python -m unittest discover -s ml -p 'test_*.py'
```

`ml/smoke.py` runs real audio through the worker. It needs `espeak-ng` and `ffmpeg` to synthesize its sample, and
`ml/smoke.py --cpu` times the CPU cleanup.


## macOS (unverified)

Nothing here has run on a Mac yet. The parsers are unit-tested with fixture output only; see `src/adapters/platform/macos.ts`.

1. `brew install tmux node`, then the same clone, build and `npm link` as on Linux.
2. `stolik setup`, then the group and plugin steps above.
3. `stolik service install --start` writes `~/Library/LaunchAgents/com.stolik.router.plist` and loads it
   with `launchctl bootstrap`. The log is `~/Library/Logs/stolik.log`.
4. Idle time comes from `ioreg` (HIDIdleTime). Lock detection is best effort. There is no CPU pinning on macOS.

## Windows (WSL2)

The router, tmux and Claude Code run inside WSL. Windows itself only hosts the terminal.

1. `wsl --install -d Ubuntu`, then open the Ubuntu shell.
2. Inside WSL, install tmux, Node 22.13 or newer and Claude Code (the Linux build). Then follow the Linux steps.
3. Systemd: add `[boot]` with `systemd=true` to `/etc/wsl.conf`, run `wsl --shutdown` from Windows, and reopen Ubuntu.
   `stolik service install --start` then works as on Linux.
4. Without systemd, start the router from a Windows logon task that runs
   `wsl.exe -d Ubuntu -- node <repo>/dist/router/main.js`. This path is unverified.

Idle and lock detection need a logind session, which WSL usually lacks. The router then treats you as away, so
Telegram gets every reply. This is expected for now.

## Configuration

Secrets: `~/.config/stolik.env`, key `STOLIK_TOKEN` (chmod 600). Everything else: `~/.config/stolik/config.json`
(`$XDG_CONFIG_HOME` is respected). Unknown keys make the router refuse to start. A missing file gives the defaults.

A trial instance beside the old bot sets two environment variables, so it uses its own secrets file and its own router socket:

- `STOLIK_ENV_FILE`: the secrets file, absolute or starting with `~/`. Default `~/.config/stolik.env`. It is read by the router, the notify path and `stolik setup`.
- `STOLIK_SOCKET`: the router socket. It wins over `socketPath` in config.json. Without it (and without
  `socketPath`) the default is `$XDG_RUNTIME_DIR/stolik.sock` (`/run/user/<uid>/stolik.sock` on Linux). On macOS
  without `XDG_RUNTIME_DIR` it is `$XDG_STATE_HOME/stolik/router.sock` (`~/.local/state` by default), or
  `$TMPDIR/stolik-<uid>.sock` when that path is longer than 100 bytes.

For example: `STOLIK_ENV_FILE=~/.config/stolik.env STOLIK_SOCKET=$XDG_RUNTIME_DIR/stolik.sock`.

| Key | Default | Meaning |
|---|---|---|
| `chat` | `{ "app": "telegram", "ownerAlias": null, "telegram": { "ownerUserId": null, "homeId": null } }` | The chat section. `app` picks the chat app (only `telegram` runs today). `ownerAlias` is the `user` name sessions see for the owner (default: the Telegram username). `telegram.ownerUserId` is the owner's Telegram user id. `telegram.homeId` is the group as `tg:<n>`. The router's stored home still wins at run time |
| `groupId` | `null` | Older key for the supergroup id, still read. Set by `/bind`, which wins over this value. `null` = DM mode |
| `ownerUserId` | `null` | Older key for the owner id, still read. Messages and taps from anyone else are ignored |
| `shutdownTimeoutMs` | `10000` | Milliseconds the router waits for work to finish when it shuts down |
| `presence` | `"logind"` | Idle and lock source: `logind` or `x11` (ignored on macOS) |
| `cpuAffinity` | `null` | CPU list for spawned heavy work and the unit's `CPUAffinity`, e.g. `"8-19"` |
| `nice` | `null` | Nice level for spawned work and the unit's `Nice`, 0 to 19 |
| `gpu` | `null` | `{ "cudaVisibleDevices": "1", "cudaDeviceOrder": "PCI_BUS_ID" }` for the ML worker; `null` = CPU |
| `weeklyLimitPct` | `99` | Weekly Claude quota at which modes refuse, 1 to 100 |
| `logRoot` | `"~/Documents/notes/telegram"` | Chat log folder (absolute or `~/`) |
| `nodePath` | `null` | Node that ran `setup`. The plugin launcher uses it first, then node on PATH |
| `logLevel` | `"info"` | Lowest level kept in the journal and `router.jsonl`: `debug`, `info`, `warn`, `error`. `/debug on` lowers it for a while |
| `logsTopic` | `true` | Post warnings and errors to the "🛠 Logs" topic of the group (rate-limited). `false` = files and journal only |

Old keys still work. The owner id comes from the first of these that is set: `chat.telegram.ownerUserId`, then
`ownerUserId`, then `TG_CHAT`. An existing install needs no edit.

Sessions see the sender in their channel meta: `chat_app` (`telegram`), `user` (the `ownerAlias`, or the Telegram
username) and `user_id` (`tg:<n>`, the paired account). `user_id` is set only on the owner's own messages. Forwarded
messages and messages made by addons never get it.

## Doctor and logs

`stolik doctor [--json]` checks the install: node version, claude and tmux on PATH (and on the PATH of the router's unit),
`claude --version`, the socket path, the secrets file (mode 600; its contents are never printed), the config, free disk
space, the database integrity, the addon manifests and their requirements, the ML venv and the GPU, and, with the token,
the bot and the group (a forum, and the bot an admin with topic, delete and pin rights). It exits 1 when a check fails;
warnings do not fail it. The router runs the checks that need no network at start and posts the problems to the Logs topic.
Before the owner pairs, doctor reports `not paired yet`.

Run it for a trial instance with the instance's secrets file: `STOLIK_ENV_FILE=~/.config/stolik.env stolik doctor`.
Without the variable, the doctor checks the default secrets file, as the router would.

`stolik logs [--addon NAME] [--level warn] [--since 10m] [--trace ID] [-f]` prints the router log (`logs/router.jsonl`,
with the audit log), or one addon's log (`logs/addons/NAME.log`), filtered. `-f` keeps printing new lines.

`stolik trace <traceId | telegramMessageId>` prints the timeline of one flow, with the time since its first line. A
number is looked up first as a Telegram message id (kept 7 days). In Telegram, reply to any message with `/trace` for the
same timeline, short form. Files are in `~/.local/state/stolik/logs/` (10 MB per file, five kept).

## Service commands

| Command | Does |
|---|---|
| `stolik service install [--name N] [--start]` | Writes the unit (`N` defaults to `stolik`) or the LaunchAgent. With `--start` it loads it, or restarts it if it runs |
| `stolik service uninstall [--name N] [--stop]` | Removes the file and disables the unit (it does not start at logon). `--stop` also stops it now |
| `stolik service status [--name N]` | Shows the file and the service state (read only) |

To keep an old unit next to a new one, install the new one under another name, e.g. `--name stolik`.

## Coming from tg-bridge

`stolik migrate` copies your old tg-bridge settings and state into the stolik locations. It does not move anything. Your old files stay where they are.

1. Stop the old service. Run `systemctl --user disable --now tg-bridge`. On macOS, run `launchctl bootout gui/$(id -u)/com.tg-bridge.router`. `stolik migrate` refuses to run while the old service is up.
2. Run `stolik migrate`. `stolik setup` runs the same copy first when it finds the old files. Then start stolik with `stolik service install --start`.
3. In Claude Code, remove the `tg-bridge@indicozy` plugin and add `stolik@indicozy`. The channel tools are now named `mcp__stolik__…`. Update any CLAUDE.md, hook or setting that names `mcp__tg-bridge__`.

Delete the old files after stolik works.

## Troubleshooting

- **Development-channels prompt.** Claude asks to confirm `--dangerously-load-development-channels` once per start.
  The router answers it through tmux when it starts a session. If you start Claude by hand, confirm it in the terminal.
- **Trust dialog.** A folder Claude has not trusted yet cannot be started from Telegram. The bot says
  "hasn't been trusted yet". Open the folder once in Claude at the desk and accept the trust dialog.
- **`/bind` does nothing.** Send it in the supergroup, not in the bot's private chat. The bot must be admin with
  "Manage topics", and the sender must be the paired owner (`chat.telegram.ownerUserId`). After a successful bind, the
  group id is stored in the router's database and `chat.telegram.homeId` in `config.json` is not changed.
- **Exit 75: "another stolik router is running".** Another router holds the lock or answers on the socket. Stop it
  (`systemctl --user stop stolik`, or the other instance), then start this one. systemd does not retry exit 75.
- **Exit 78: "config error".** `config.json` or the env file is wrong. The router's message names the key or file.
  Fix it, then `systemctl --user start stolik` (systemd does not retry exit 78).
- **`no node found` from the plugin.** Run `stolik setup` again so `nodePath` is written, or put `node` on PATH.
- **`dist/router/main.js is missing`.** Run `npm run build` in the repo, then `service install` again.
- **Plugin not found.** Run `/plugin install stolik@indicozy` again after the marketplace add. The plugin's paths
  point at `../dist` and `../bin`, so keep the built repo where it is (not verified from a marketplace cache).
- **Service fails at start.** `journalctl --user -u stolik -n 100` (Linux) or `~/Library/Logs/stolik.log` (macOS).
  Run `stolik doctor` first; it names the check that fails.
- **A session did not start.** The message names a forensics file (`~/.local/state/stolik/forensics/`): the start's
  command line, the environment variable names, the PATH, the pane's last lines and `claude --version`. The same name is in
  the Logs topic. `stolik logs --level warn --since 1h` shows the surrounding lines.
- **Something went wrong on one message.** Reply to it with `/trace`, or run `stolik trace <message id>`.
