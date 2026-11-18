// Voice cleanup, pure parts (plan 3.3): the vocabulary the model is given, and the guard on what it answers.
export const MAX_GROWTH = 1.3
export const VOCAB_MAX = 60

// The words the cleaner should spell as written: session names, trusted project names and prefix words (no repeats).
export function vocabulary(sessionNames: unknown, words: unknown): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const list of [sessionNames, words]) {
    if (!Array.isArray(list)) continue
    for (const v of list) {
      if (typeof v !== 'string') continue
      const t = v.trim()
      if (t === '' || seen.has(t)) continue
      seen.add(t)
      out.push(t)
      if (out.length >= VOCAB_MAX) return out
    }
  }
  return out
}

// The guard (design §4.12): an empty answer, or one longer than 1.3 times the input, is not used. The raw text goes on,
// marked unpolished. Lengths count characters, not bytes, so Cyrillic is measured as written.
export function guardClean(input: string, output: string): { text: string; unpolished: boolean } {
  const raw = input.trim()
  if (raw === '') return { text: input, unpolished: false }
  const out = output.trim()
  if (out === '') return { text: input, unpolished: true }
  if (Array.from(out).length > MAX_GROWTH * Array.from(raw).length) return { text: input, unpolished: true }
  return { text: out, unpolished: false }
}
