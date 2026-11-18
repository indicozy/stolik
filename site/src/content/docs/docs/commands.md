---
title: Commands
description: Every stolik slash command, prefix word and CLI command.
---

## In Telegram: slash commands

Send these in **General** unless noted. `/help` prints this list in the chat.

| Command | Does |
|---|---|
| `/list` | Live sessions, and the folders you can start one in |
| `/to <name> <text>` | Send to a session, or start one in a trusted folder |
| `/resume` | Continue an ended session (live ones are listed too) |
| `/usage` | Mode runs and their cost today and this week |
| `/model [name\|default]` | The model new sessions start with |
| `/addons` | List, enable or disable addons |
| `/digest [YYYY-MM-DD]` | Summary of a day's chat (digest addon) |
| `/away` | Send everything to Telegram, even while you're at the desk |
| `/here` | Stop messages until you next touch the desktop |
| `/lock` | Ignore all messages until unlocked at the desk with `stolik-ctl unlock` |
| `/bind` | Run once in the group to make it the bot's home |
| `/debug` | Router status. `/debug on [minutes]` turns on debug logs, `/debug off` stops them |
| `/trace` | Reply to any message with it to see what the router did with that message |

In a **folder topic**, the bot reads only two commands. Every other message goes to a session:

| Command | Does |
|---|---|
| `/new [text]` | Start another session in this folder. The text is its first message |
| `/silent [30m\|2h\|1d\|1w\|off\|status]` | Mute this topic's answers and "finished" pings. Approvals and questions still ping |

`!list` works the same as `/list`. The tables show `/`, which is what Telegram writes. A forwarded message never runs a `!` command.

## In Telegram: prefix words

A prefix is a word at the start of a message **in General**, followed by a colon, a comma or a spaced dash. "note: buy a longer cable" is a note. "note that the build failed" is an ordinary message.

| Prefix | Does | Also |
|---|---|---|
| `to <name>:` | Send to a session | `send to`, `отправь в` |
| `new <project>:` | Start a session in a folder | `новая`, `новый` |
| `note:` | Save to the notes inbox on your PC. Not sent to any session | `заметка`, `запиши` |
| `quick:` | A question answered with no tools | `question`, `вопрос`, `быстро` |
| `read:` | A read-only look at your files and machine | `check`, `почитай`, `проверь` |
| `web:` | An answer from a web search | `search`, `поиск`, `загугли` |

`note`, `quick`, `read` and `web` come from addons. If the addon is off, the bot says which one to enable. Prefixes work by voice too: say "quick question, …".

## On your PC: the `stolik` command

| Command | Does |
|---|---|
| `stolik setup` | Pair the bot with your Telegram account. Write the config. Offer the model worker. `--pair` pairs again. `--owner-id <n>` sets the owner without pairing. `--chat telegram` is the default |
| `stolik service install [--start] [--name N]` | Write the user service. `--start` starts or restarts it |
| `stolik service status` | Show the service file and state |
| `stolik service uninstall [--stop]` | Remove the service. `--stop` also stops it now |
| `stolik doctor [--json]` | Check the install and name what fails |
| `stolik logs [--level warn] [--since 10m] [--addon NAME] [-f]` | Print the router log or one addon's log |
| `stolik trace <message id>` | The timeline of one message through the router |
| `stolik addon add <git url \| npm name \| folder>` | Install an addon (shows its access, asks for a yes) |
| `stolik addon list` / `remove <name>` / `consent <name>` | Manage installed addons |

And the launcher: `tg-claude [claude args]` starts Claude Code with stolik's channel loaded.
