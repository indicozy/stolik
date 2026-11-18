// Request shape for reading whole days of the chat log (the `chatlog` addon request, plan 3.4). Pure.

export const MAX_CHAT_DAYS = 7

// `{from: "YYYY-MM-DD", days: 1..7}`, or null when either is missing or wrong.
export function parseDayRequest(payload: Record<string, unknown>): { from: string; days: number } | null {
  const from = payload.from
  const days = payload.days
  if (typeof from !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(from)) return null
  if (typeof days !== 'number' || !Number.isInteger(days) || days < 1 || days > MAX_CHAT_DAYS) return null
  const [y, m, d] = from.split('-').map(Number)
  const real = new Date(y, m - 1, d)
  if (real.getFullYear() !== y || real.getMonth() !== m - 1 || real.getDate() !== d) return null
  return { from, days }
}
