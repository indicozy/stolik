# tg-bridge-dialogs

Forwards mod dialogs (`$.ui.ask`, as an AskUserQuestion `tool.call`) to Telegram while the owner is away.
It reuses the tg-bridge PermissionRequest hook (`dist/hook.js`): the terminal dialog and Telegram race, and the first answer wins.
Loaded via `CLAUDE_CODE_PLUGIN_DIRS` in the `env` block of `~/.claude/settings.json`, pointing at this `mod/` folder.
Needs `npm run build` in the repo first, since it runs `dist/hook.js`.
The model's own AskUserQuestion and subagent questions are left to the normal path.
