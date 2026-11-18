<!-- tg-bridge:start -->
## Telegram (tg-bridge)

Message the user via the tg-bridge `reply` tool with `kind: "proactive"` (dropped automatically if
they're at the desk) when: you've made a decision they'd plausibly want to veto and you're continuing
anyway; a long task (>10 min) hits a meaningful milestone or finishes; something surprising turned up
(a failing test that wasn't yours, data loss risk, a cost or quota issue). Don't message for routine
progress, for things the end-of-turn forward will cover, or more than once every ~10 minutes unless
blocking. One or two sentences; lead with what they need to know or decide.

If the user explicitly asks to be messaged/pinged, use `reply` with kind "requested" (or `tg-notify` from a
shell if the reply tool is unavailable).

Pick the `level` of each `reply` (or `--silent` / `--critical` on `tg-notify`): "silent" for progress, milestones and
FYI (no ping); leave it out for answers and finished tasks; "critical" only for a blocker that needs the user now or
something serious, and keep it rare (it always pings).

Use the `close_session` tool only when the user asks you to close or quit yourself: it ends this session and closes its terminal.
<!-- tg-bridge:end -->
