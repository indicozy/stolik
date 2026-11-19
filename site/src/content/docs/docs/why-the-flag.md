---
title: Why the flag?
description: Why stolik sessions start with --dangerously-load-development-channels, and what that flag does.
---

Claude Code only loads channel plugins from a list Anthropic maintains. stolik is not on that list, so it has to be loaded with Claude Code's development flag. You should know what that means before you use it.

## What a channel is

A channel is how a message from outside (here, Telegram) gets into a running Claude Code session. Channels are a research preview in Claude Code. By default, `--channels` accepts only channel plugins from Anthropic's official marketplace.

## What the flag does

```sh
claude --dangerously-load-development-channels plugin:tg-bridge@indicozy
```

- It tells Claude Code to load **this one named plugin** as a channel although it is not on the list. It does not open the door to other plugins.
- Claude Code shows a full-screen warning at every start and waits for Enter.
- It works only in interactive sessions. Claude Code ignores it with `claude -p`.
- It does **not** bypass an organisation's settings. If your org has Channels turned off, the flag does nothing.

`tg-claude` is a small shell script that runs `claude` with this flag. It is short enough to read.

## The Enter press

When you start a session from your phone (`new orbit-api: …` or `/resume`), nobody is at the keyboard to confirm the warning. So for sessions **the router starts**, the router presses Enter on that screen through tmux.

That is the only key stolik presses on a dialog for you. Sessions you start yourself show the warning and wait. stolik never answers a permission prompt for you, and it never accepts the folder trust dialog. A folder that you have not trusted cannot start from Telegram at all.

## Why "dangerously"

A channel puts text from outside into your session, and a session can run commands. The name is a fair warning. What stolik does about it:

- The router checks every message and button tap against your Telegram user id, not only the chat id.
- The router marks forwarded messages as someone else's words and tells the session to treat them as data.
- `/lock` makes the bot ignore everything until you unlock it at the desk.

What it cannot do: protect you if someone else gets into your Telegram account. Use Telegram's two-step verification.

## Will the flag go away?

stolik is not on Anthropic's channel list, and it needs the flag until that changes. We have no date and make no promise.

## Who cannot use stolik today

- **Team and Enterprise** users whose org Owner has not turned Channels on.
- Claude Code on **Amazon Bedrock, Google Cloud or Microsoft Foundry**: channels need claude.ai or Console API key sign-in.

