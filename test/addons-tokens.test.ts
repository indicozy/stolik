// The host's button token table (src/addons-host/tokens.ts): tokens are issued per button, looked up on a tap, expire
// after a day, and the table keeps at most its cap (the oldest goes first). The clock is injected.
import './helpers/isolate.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ButtonTokens, TOKEN_CAP, TOKEN_LENGTH, TOKEN_RE, TOKEN_TTL_MS } from '../src/addons-host/tokens.ts'

function clockAt(start = 1_000_000) {
  let t = start
  return { now: () => t, advance: (ms: number) => (t += ms) }
}

test('tokens: ten base62 characters, unique, and resolved to the addon and its data', () => {
  const c = clockAt()
  const tokens = new ButtonTokens(c.now)
  const seen = new Set<string>()
  for (let i = 0; i < 500; i++) {
    const t = tokens.issue('modes', `c:${i}`)
    assert.equal(t.length, TOKEN_LENGTH)
    assert.match(t, TOKEN_RE)
    seen.add(t)
  }
  assert.equal(seen.size, 500)
  const first = [...seen][0]
  assert.ok(first)
  assert.ok(tokens.resolve(first) !== null)
})

test('tokens: a token resolves to its own addon and data', () => {
  const tokens = new ButtonTokens(clockAt().now)
  const a = tokens.issue('modes', 'p:abcd0123:2')
  const b = tokens.issue('cost-guard', 'release:7')
  assert.deepEqual(tokens.resolve(a), { addon: 'modes', data: 'p:abcd0123:2' })
  assert.deepEqual(tokens.resolve(b), { addon: 'cost-guard', data: 'release:7' })
  assert.equal(tokens.resolve('Zzzzzzzzzz'), null)
})

test('tokens: a token expires after a day, and the entry is dropped', () => {
  const c = clockAt()
  const tokens = new ButtonTokens(c.now)
  const t = tokens.issue('modes', 'c:abcd0123')
  c.advance(TOKEN_TTL_MS - 1)
  assert.ok(tokens.resolve(t))
  c.advance(1)
  assert.equal(tokens.resolve(t), null)
  assert.equal(tokens.size, 0)
})

test('tokens: past the cap the oldest entry is evicted, the newest stay', () => {
  const tokens = new ButtonTokens(clockAt().now, TOKEN_TTL_MS, 3)
  const [a, b, c, d] = ['a', 'b', 'c', 'd'].map((x) => tokens.issue('modes', x))
  assert.equal(tokens.size, 3)
  assert.equal(tokens.resolve(a!), null)
  assert.equal(tokens.resolve(b!)?.data, 'b')
  assert.equal(tokens.resolve(c!)?.data, 'c')
  assert.equal(tokens.resolve(d!)?.data, 'd')
})

test('tokens: the default cap is 2000 entries', () => {
  const tokens = new ButtonTokens(clockAt().now)
  for (let i = 0; i < TOKEN_CAP + 10; i++) tokens.issue('modes', `c:${i}`)
  assert.equal(tokens.size, TOKEN_CAP)
})

test('tokens: an expired entry makes room before the cap evicts a live one', () => {
  const c = clockAt()
  const tokens = new ButtonTokens(c.now, 100, 2)
  const old = tokens.issue('modes', 'old')
  c.advance(60)
  const live = tokens.issue('modes', 'live')
  c.advance(60) // `old` is now expired, `live` is not
  const fresh = tokens.issue('modes', 'fresh')
  assert.equal(tokens.resolve(old), null)
  assert.equal(tokens.resolve(live)?.data, 'live')
  assert.equal(tokens.resolve(fresh)?.data, 'fresh')
})
