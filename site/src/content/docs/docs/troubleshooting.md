---
title: Troubleshooting
description: Fix a stolik install, read its logs, or remove it.
---

Start here:

```sh
stolik doctor
stolik logs --level warn --since 1h
```

Doctor names the failing check. In Telegram, reply to any message with `/trace` to see what the router did with it. Warnings also land in a "🛠 Logs" topic in your group (turn that off with `"logsTopic": false`).

## Common problems

**`/bind` does nothing.** Send it in the group, not in the bot's private chat. The bot must be an admin with "Manage topics", and you must be the account you paired with (`stolik setup`).

**Setup says the code expired or the bot is locked.** A code lasts 5 minutes and stops after 5 wrong tries. Run `stolik setup --pair` for a new code.

**The bot answers nothing after setup.** Until you pair, the router answers nobody. Run `stolik doctor`. "not paired yet" means pairing did not finish.

**"409 Conflict (another poller holds this token)".** Another program polls the same bot token. Stop it, then restart the router.

**No topic appears when I start a session.** Start it with `STOLIK_PLUGIN=1 tg-claude`, not plain `claude`, and confirm the warning screen. Check that the plugin is installed (`/plugin` in Claude Code) and that `stolik service status` shows the router running.

**The bot says a folder "hasn't been trusted yet".** Open that folder once in Claude Code at the desk and accept the trust dialog. stolik never accepts it for you.

**The warning screen appears every time.** That is Claude Code's behaviour for the development flag. See [Why the flag?](../why-the-flag/).

**Nothing reaches my phone.** You are probably at the desk: stolik stays quiet while you use the PC. Send `/away` to get everything, or lock the screen.

**A session did not start from Telegram.** The bot's message names a forensics file under `~/.local/state/stolik/forensics/` with the command line, the PATH and the last lines of the tmux pane.

**"another router is running" (exit 75).** A second router holds the lock. Stop it with `systemctl --user stop stolik`, then start this one.

**"config error" (exit 78).** `config.json` or the token file is wrong, and the message names the key. The router refuses unknown keys on purpose. Fix it, then `systemctl --user start stolik`.

**`no node found` from the plugin.** Run `stolik setup` again so it records your Node path, or put `node` on PATH.

**The service fails at start.** `journalctl --user -u stolik -n 100`. On macOS, read `~/Library/Logs/stolik.log`.

**Voice notes are ignored.** The `voice` addon is off or the model worker is not installed. Check `/addons`, then see [Install](../install/#optional-voice-and-digest-models).

**Answers arrive slowly in bursts.** Telegram allows a bot about 20 messages a minute per group. stolik queues the rest and keeps their order.

## Uninstall

There is no single command. In this order:

1. Stop and remove the service: `stolik service uninstall --stop`.
2. In Claude Code: `/plugin uninstall stolik@indicozy`.
3. Remove the package: `npm uninstall -g stolik`. Remove your `alias claude=tg-claude` if you added one.
4. Delete the files, if you want them gone: `~/.config/stolik/`, `~/.config/stolik.env`, `~/.local/state/stolik/`. The chat log (`~/Documents/notes/telegram/` by default) is yours. Keep it or delete it.
5. In Telegram: remove the bot from the group, and delete the bot in @BotFather (`/deletebot`) to kill its token.

None of these steps touches the sessions that run in tmux.
