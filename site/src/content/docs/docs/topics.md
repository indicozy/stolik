---
title: Topics and sessions
description: How stolik lays out your Telegram group or Discord server, and where each message goes.
---

## The layout

Your group has one **General** topic and one topic **per project folder**.

| Place | What you see there |
|---|---|
| A folder's topic | Answers, permission prompts, questions and plan approvals from the sessions in that folder |
| General | `/list`, the `/resume` picker, note confirmations, `quick` / `read` / `web` answers, alerts |
| The bot's private chat | A fallback only. Once the group is bound, messages there are not routed |

The bot creates a topic when the first session in a folder connects, from your terminal or from the phone. It names the topic after the folder. Sessions in the same folder share the topic. Each answer, approval and question names its session.

## Writing to a session

- **In a folder topic**, a plain message goes to the session that wrote there last. Swipe-reply to a message to pick that message's session instead.
- **In General**, a plain message goes to the session that was active in the last 30 minutes, with a "wrong one?" button. If there is no such session you get buttons: each live session, New, quick, read, web.
- `to orbit-api: run the tests again` in General names the session outright. It also works by voice.

The bot delivers a message to a busy session at once. Claude Code queues it, and the bot marks it "⏳ queued".

Photos and files you send arrive in the session as files on your PC.

## Starting a session from the phone

- `/list` shows live sessions and the folders you can start one in.
- `new orbit-api: fix the flaky test` asks **Read-only** or **Full**, then starts Claude Code in a tmux session on your PC with that first message. Read-only starts in plan mode. If you approve its plan, it becomes a full session.
- `/new` inside a folder topic starts another session in that folder.
- `/model sonnet` sets the model that new sessions start with. Running sessions keep theirs.

You can start a session from Telegram only in a folder that you already **trusted in Claude Code**. If the bot says a folder "hasn't been trusted yet", open it once in Claude Code at the desk and accept the trust dialog.

Sessions started from the phone are ordinary tmux sessions: `tmux ls`, then `tmux attach -t <name>` at the desk. stolik starts at most three at a time.

## Ending and resuming

A folder has one topic. It stays open. When a session ends, nothing changes in the topic, and stolik never closes or deletes it. The next session in that folder writes to the same topic. If you delete a topic by hand, the next session in that folder gets a new one.

stolik closes a session that sits idle for 60 minutes. It warns you 5 minutes before, with a **Keep open** button. The session's terminal closes too. The topic stays open.

`/resume` lists ended sessions, newest first. Pick one and stolik runs `claude --resume` for it in tmux, in its original folder, with its history. stolik does not restore the flags that you launched it with. Live sessions appear in the list too. If you pick one, stolik routes to it.

## The chat log

stolik writes every message in and out to plain files on your PC: `~/Documents/notes/telegram/log/YYYY-MM.jsonl` and a readable `YYYY-MM-DD.md` per day. Change the folder with `logRoot` in `config.json`.

## On Discord

On Discord, each folder is a channel instead of a topic. The lobby is the channel where you sent `!bind`. For the layout and its limits, see [Discord instead of Telegram](../install/#discord-instead-of-telegram).
