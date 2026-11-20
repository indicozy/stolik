![How stolik works](docs/how-stolik-works.png)

# stolik

stolik connects the Claude Code sessions on your machine to Telegram and Discord. Each project gets its own topic, so you can follow several sessions at once. From your phone, you can approve or deny tool calls, send voice notes, and answer questions Claude asks.

One install uses one chat app: Telegram or Discord, chosen at setup with `--chat`.

stolik runs as a router on your machine, next to your sessions. It does not run in the cloud.

## Requirements

- Linux or macOS
- Node.js 22.13 or newer
- tmux
- Claude Code

## Install

See the [install guide](https://indicozy.github.io/stolik/docs/install/).

## opencode

stolik can also run opencode sessions. To start one, send `oc <project>: <message>` in the chat. `oc`, `opencode` and `new oc` work the same way. The new-session buttons then include `opencode` (full access) and `opencode plan` (read-only), next to the Claude Code buttons. Each opencode session runs its own `opencode serve` in tmux. The owner's chat messages go to that server as prompts.

Set the model with `opencodeModel` in the config, as `provider/model`, for example `openrouter/qwen/qwen3-coder`. When it is null, opencode uses its own default. To make opencode the agent of the sessions the bot starts, set `defaultAgent` to `opencode`.

## License

Apache-2.0, see [LICENSE](LICENSE).

Not affiliated with Telegram, Discord or Anthropic.
