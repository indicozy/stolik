---
title: Approvals and away
description: What stolik sends to your phone, when, and how approvals time out.
---

## Away and at the desk

stolik sends to your chat app (Telegram or Discord) when you are **away**, and stays quiet when you are at the desk. You are away when any of these is true:

- the screen is locked
- there has been no keyboard or mouse input for 5 minutes
- nobody is logged in to the desktop
- you sent `/away`.


Three commands override it:

| Command | Effect |
|---|---|
| `/away` | Send everything, even while you type at the desk |
| `/here` | Stop messages until you next touch the keyboard or mouse |
| `/lock` | Ignore every incoming message until you run `stolik-ctl unlock` at the desk |

Idle and lock state come from logind. On X11 without logind, set `"presence": "x11"` in `config.json`.

## Permission prompts

While you are away, stolik forwards every Claude Code permission prompt to the session's topic, for any tool. You see the tool name and a summary of the call, with **Allow** and **Deny**.

- Tap one and the bot edits the message to **Sent: allow** or **Sent: deny**. It says "sent" on purpose: it reports what it passed to Claude Code, not what happened in the terminal.
- Only your taps count. The bot ignores anyone else's.
- Questions the agent asks (AskUserQuestion) and plan approvals arrive the same way, as a question with options and as a plan to approve.
- Prompts jump the send queue, so a long answer never delays one.

## If you don't answer

| After | What happens |
|---|---|
| 15 minutes | One reminder in the topic |
| 30 minutes | The bot marks the message "expired, answer at the desk or /resume". The prompt keeps waiting in the terminal |

stolik never denies or allows for you on a timeout.

If you answer **yes at the desk** first, the bot replaces the buttons in the chat with "✅ Answered at the desk". A "no" at the desk leaves the buttons until they expire. A tap on them then does nothing.

## Muting

`/silent 2h` in a folder topic mutes that topic's answers and "finished" pings for two hours. The durations are `30m`, `2h`, `1d` and `1w`, and a bare `/silent` lasts until `/silent off`. Approvals and questions still ping, because a session is waiting on you.
