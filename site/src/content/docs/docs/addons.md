---
title: Addons
description: The built-in stolik addons, what each may access, and how to write your own.
---

The core does sessions, topics, approvals, resume and the chat log. Everything else is an addon: a separate program the router starts and talks to over stdin and stdout. If an addon crashes, the router restarts it. After the third crash in 10 minutes, the router turns the addon off and tells you.

**All built-in addons are off until you enable them.** After `/bind` the bot offers the list once, with **Enable all**. Later, use `/addons` in General.

## Built-in addons

| Addon | What you get | Needs |
|---|---|---|
| `voice` | Voice notes become text, on your machine | model worker |
| `voice-cleanup` | Removes the "um"s and fixes punctuation. It never adds content, and it keeps the raw text when its own check fails | model worker |
| `notes` | `note:` saves a message, and its files, to a notes inbox on your PC | none |
| `modes` | `quick:`, `read:` and `web:` answers without a session | none |
| `digest` | `/digest`: what was asked, what was done, what is open | model worker |
| `cost-guard` | Holds a message to a long, cold session and asks first | none |


### Voice

Send a voice note in a topic or in General. The bot answers with `🎙 "<what it heard>"` and a button for the raw transcript, then treats the text like a typed message, prefixes included. Speech never leaves your PC, and there is no hosted fallback: if the model worker is missing, voice stays off.

### Modes: quick, read, web

Each runs a one-off headless Claude Code (`claude -p`) and answers in General as a reply to your question.

| Mode | Model | Tools | Limit |
|---|---|---|---|
| `quick:` | Haiku | none | 60 s |
| `read:` | Sonnet | Read, Grep, Glob and a short list of read-only shell commands | 5 min, 30 steps |
| `web:` | Sonnet | WebSearch, WebFetch | 5 min, 30 steps |

- Swipe-reply to an answer to continue that thread. A new message starts fresh.
- Every answer ends with its cost and time. `/usage` shows the totals. Modes use your Claude plan.
- `read:` can open only your trusted project folders, the chat log, the notes folder and a few system paths, and it refuses anything that looks like a secret (`.env`, keys, credentials, shell history). A hook re-checks every call and can only deny.
- If a run hits its limit you get the partial answer and a **Continue** button. **Upgrade** turns an answer into the first message of a full session.

### Digest

`/digest` summarises yesterday's chat log with the local model. `/digest 2026-11-17` picks a day. Set `digestSchedule` to `daily` or `weekly` to get one at 04:00 without asking. The addon masks secrets before the text reaches the model or a file.

### Cost guard

When a session has been idle for an hour, its prompt cache is gone, and your next message makes Claude Code re-read the whole history at full price. If that history is over 100k tokens, cost guard holds your message and asks: **Send anyway**, **New session** (same folder, with your message) or **Cancel**.

## Trust

- An addon gets only the access its manifest declares (for example `message.text`, `message.audio`, `chatlog.read`, `messages.send`). Install shows the list and needs a typed yes.
- Addons install **from the PC only**: `stolik addon add <git url | npm name | folder>`. Nothing installs from Telegram. `/addons` can only list, enable and disable.
- If an installed addon's manifest changes, the router stops it until you run `stolik addon consent <name>` at the PC.
- **There is no sandbox.** An addon is a program running as your user. Declared access limits what the router hands it, not what its code can do. Read an addon before you install it.

## Write one

An addon is a folder with a `stolik-addon.json` manifest and a program in any language. The router starts the program and exchanges one JSON object per line.

```json
{
  "name": "hello",
  "version": "1.0.0",
  "protocol": 2,
  "command": ["node", "main.js"],
  "provides": [{ "point": "prefix", "words": ["hello"] }],
  "access": ["message.text", "messages.send"],
  "requires": []
}
```

Plug-in points: `prefix` and `command` (new words, and commands in General written with `/` or `!`), `media` (voice, photos, files), `text-filter` (rewrite text before routing), `schedule` (run at a time), `gate` (hold a message before delivery), `listener` (a read-only view of every message, and install warns loudly) and `reply` (answers swipe-replies to its own messages; this was `thread` before protocol 2). The built-ins in the repo's `src/addons/` are the reference.

Protocol 2 is the only protocol this version runs. A manifest with `"protocol": 1` is refused, and the message tells you to update the addon. Ids are strings. The host hands them out, and the addon passes them back unchanged. Button data is any string up to 256 characters. The host swaps it for a short token. A button expires 24 hours after it was sent. A tap after that shows "This button has expired."
