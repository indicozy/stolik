# E2E driver

Lets a run exercise the real router, the real Telegram group (outbound), real Claude sessions and the real ml-worker
without a person typing. Inbound messages and button taps are injected; everything the router sends goes to Telegram.

## Enable

Only when the router runs with `STOLIK_E2E=1` (exactly `1`). Otherwise the socket refuses every `e2e` message with
"e2e disabled". Nothing else changes.

## Use

`scripts/e2e.ts` talks to the router socket named by `STOLIK_SOCKET`:

    export STOLIK_SOCKET=$XDG_RUNTIME_DIR/stolik.sock
    E2E="node --experimental-strip-types scripts/e2e.ts"
    $E2E send "what is running?"                     # owner text, General
    $E2E send "status?" --topic razdor               # into an open session topic
    $E2E send "/usage" --forwarded                   # forwarded: treated as data, no command runs
    $E2E voice /path/to/note.ogg --topic razdor      # .ogg .oga .opus .wav .mp3 .m4a, transcribed by ml-worker
    $E2E photo /path/to/shot.png                     # or: file <path> for a document
    $E2E sent 5                                      # last 5 outbound messages, with button indices
    $E2E tap 1234 Yes                                # button by text, or by 0-based index: tap 1234 0
    $E2E wait 'answer|done' --timeout 120            # waits for a NEW outbound message that matches

Add `--json` to `sent`, `wait`, `send` or `tap` for machine-readable output. Exit status is 0 on success, 1 on a
failed request or a timeout, 2 on bad usage.

## What the router does with an injected message

It builds the same `Inbound` the Telegram adapter builds for an owner message and calls the same handler. Lock, rate
limit, prefixes, routing, topics and approvals all apply. The chat is the bound group (General, or a topic named by its
open session or by its thread id) or the owner's DM when no group is bound.

- **Message ids** are negative (from -1000000001 down), so they never collide with Telegram's. A reply to a synthetic
  message is sent without a reply link, because Telegram has no such message.
- **Files** are local paths. The router reads them as if it had downloaded them, and they must be absolute regular files.
- **Taps** are dispatched to the same callback handler. Their ids (`e2e-cb-…`) are never answered on Telegram.

## What is recorded

With the driver on, the Telegram adapter records every message it sends (chat, thread, id, text, keyboard with callback
data) in a 200-entry ring buffer, and edits update it. Injected messages are not recorded: the buffer is outbound only.
The buffer lives in memory and is lost on restart.

## Limits

- It runs against a real group: outbound messages are real and count against Telegram's rate limit.
- The socket accepts driver messages from any local process that can reach it, like every other router message. Keep the
  socket owner-only (the default).
- Only one media file per injected message.
