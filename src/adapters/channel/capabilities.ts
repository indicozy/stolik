// The MCP capabilities the channel server advertises. Pure, so a test can import it without starting the stdio server
// that channel.ts runs at load. An opencode session takes tools only: its inbound messages and permission relay are
// not claude channel features.
export function channelCapabilities(agent: string | undefined): Record<string, unknown> {
  if (agent === 'opencode') return { tools: {} }
  return {
    tools: {},
    experimental: {
      'claude/channel': {},
      // The router only accepts the configured chat id, so the replier is authenticated upstream.
      'claude/channel/permission': {},
    },
  }
}
