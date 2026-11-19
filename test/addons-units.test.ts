import './helpers/isolate.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { LineFramer, MAX_LINE_CHARS, encodeRequest, parseReply } from '../src/addons-host/protocol.ts'
import { filterPayload } from '../src/addons-host/access.ts'
import { KEY_ACCESS, ManifestSchema, RESERVED_OPS, consentHash, parseManifest, readManifest } from '../src/addons-host/manifest.ts'
import { consentGiven, describeAccess, listenerWarning } from '../src/addons-host/consent.ts'
import { parseCommand, parsePrefix, dueSchedules } from '../src/addons-host/points.ts'
import { JsonAddonSettings } from '../src/addons-host/settings.ts'
import { addonsMenuRows, addonsMenuText, parseAddonCallback } from '../src/addons-host/menu.ts'
import { tmpDir } from './helpers/addon-fakes.ts'

const GOOD = {
  name: 'voice-thing',
  version: '1.2.0',
  protocol: 2,
  command: ['node', 'index.mjs'],
  provides: [{ point: 'media', kinds: ['voice'] }, { point: 'prefix', words: ['note'] }],
  access: ['message.audio', 'message.text'],
  requires: ['ml-worker'],
}

// ---------- framing ----------

test('LineFramer: a line split over chunks comes out once it is complete', () => {
  const f = new LineFramer()
  assert.deepEqual(f.push('{"id":1,"res'), [])
  assert.deepEqual(f.push('ult":2}\n'), ['{"id":1,"result":2}'])
})

test('LineFramer: several lines in one chunk all come out, blank lines are skipped', () => {
  const f = new LineFramer()
  assert.deepEqual(f.push('a\n\n b \nc'), ['a', ' b ']) // "c" waits for its newline
  assert.deepEqual(f.push('\n'), ['c'])
})

test('LineFramer: an unfinished line past the limit is an error', () => {
  const f = new LineFramer()
  assert.throws(() => f.push('x'.repeat(MAX_LINE_CHARS + 1)), /longer than 1 MB/)
})

test('parseReply: result, error, null result, and the rejects', () => {
  assert.deepEqual(parseReply('{"id":4,"result":{"text":"hi"}}'), { id: 4, ok: true, result: { text: 'hi' } })
  assert.deepEqual(parseReply('{"id":5,"error":"nope"}'), { id: 5, ok: false, error: 'nope' })
  assert.deepEqual(parseReply('{"id":6}'), null)
  assert.deepEqual(parseReply('{"id":6,"result":null}'), { id: 6, ok: true, result: null })
  assert.equal(parseReply('not json'), null)
  assert.equal(parseReply('{"id":"7","result":1}'), null)
  assert.equal(parseReply('{"id":1.5,"result":1}'), null)
  assert.equal(parseReply('null'), null)
})

test('encodeRequest: one JSON line with id, op and payload', () => {
  const line = encodeRequest(3, 'media', { kind: 'voice' })
  assert.equal(line, '{"id":3,"op":"media","payload":{"kind":"voice"}}\n')
})

// ---------- access filter ----------

test('filterPayload: undeclared fields are removed, declared ones kept, metadata always kept', () => {
  const payload = { op: 'media', kind: 'voice', audioPath: '/a.ogg', filePath: '/b.jpg', text: 'secret', sessionNames: ['x'] }
  const r = filterPayload(payload, { access: ['message.audio'] })
  assert.deepEqual(r.payload, { op: 'media', kind: 'voice', audioPath: '/a.ogg' })
  assert.deepEqual(r.dropped.sort(), ['filePath', 'sessionNames', 'text'])
})

test('filterPayload: a key nobody listed is never sent, even when the manifest asks for everything', () => {
  const all = ['message.text', 'message.audio', 'message.files', 'sessions.names', 'chatlog.read'] as const
  const r = filterPayload({ op: 'x', token: 'abc', sneaky: 1, text: 't' }, { access: [...all] })
  assert.deepEqual(r.payload, { op: 'x', text: 't' })
  assert.deepEqual(r.dropped.sort(), ['sneaky', 'token'])
})

// ---------- manifest ----------

test('manifest: a valid manifest parses', () => {
  const m = parseManifest(GOOD)
  assert.equal(m.name, 'voice-thing')
  assert.deepEqual(m.requires, ['ml-worker'])
})

test('manifest: access and requires default to empty', () => {
  const { access: _a, requires: _r, ...rest } = GOOD
  const m = parseManifest(rest)
  assert.deepEqual(m.access, [])
  assert.deepEqual(m.requires, [])
})

test('manifest: a protocol 1 manifest is refused with that one message', () => {
  const msg = 'written for addon protocol 1; this stolik speaks protocol 2 (ids are strings, point "thread" is now "reply"). Update the addon.'
  assert.throws(() => parseManifest({ ...GOOD, protocol: 1, provides: [{ point: 'thread' }] }), (e: Error) => e.message === msg)
  const dir = tmpDir('manifest-protocol-1')
  try {
    writeFileSync(join(dir, 'stolik-addon.json'), JSON.stringify({ ...GOOD, protocol: 1 }))
    assert.deepEqual(readManifest(dir), { error: msg })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
  assert.equal(parseManifest(GOOD).protocol, 2)
})

test('manifest: each bad field is refused and the error names it', () => {
  const cases: Array<[string, Record<string, unknown>, RegExp]> = [
    ['protocol float', { protocol: 2.5 }, /protocol/],
    ['empty command', { command: [] }, /command/],
    ['unknown point', { provides: [{ point: 'teleport' }] }, /provides/],
    ['unknown access field', { access: ['message.video'] }, /access/],
    ['duplicate access field', { access: ['message.text', 'message.text'] }, /listed twice/],
    ['bad name', { name: 'Voice Thing' }, /name/],
    ['unknown top-level key', { acess: ['message.text'] }, /(root)|unrecognized/i],
    ['unknown key in a provide', { provides: [{ point: 'listener', extra: 1 }] }, /provides/],
    ['media with no kinds', { provides: [{ point: 'media', kinds: [] }] }, /provides/],
    ['prefix word with a space', { provides: [{ point: 'prefix', words: ['two words'] }] }, /provides/],
    ['command name uppercase', { provides: [{ point: 'command', name: 'Echo' }] }, /provides/],
    ['schedule zero minutes', { provides: [{ point: 'schedule', everyMinutes: 0 }] }, /provides/],
    ['requires a bad name', { requires: ['Bad Name'] }, /requires/],
  ]
  for (const [label, patch, re] of cases) {
    assert.throws(() => parseManifest({ ...GOOD, ...patch }), re, label)
  }
})

test('manifest: the schema is strict about every point parameter', () => {
  assert.equal(ManifestSchema.safeParse({ ...GOOD, provides: [{ point: 'router' }] }).success, true)
  // A service addon provides nothing (the ml-worker addon).
  assert.equal(ManifestSchema.safeParse({ ...GOOD, provides: [] }).success, true)
  assert.equal(ManifestSchema.safeParse({ ...GOOD, provides: [{ point: 'router', words: ['x'] }] }).success, false)
})

test('readManifest: missing file, invalid JSON and a good file', () => {
  const dir = tmpDir('manifest')
  try {
    assert.match(readManifest(join(dir, 'nope')).error ?? '', /not found/)
    mkdirSync(join(dir, 'bad'))
    writeFileSync(join(dir, 'bad', 'stolik-addon.json'), '{ nope')
    assert.match(readManifest(join(dir, 'bad')).error ?? '', /not valid JSON/)
    mkdirSync(join(dir, 'good'))
    writeFileSync(join(dir, 'good', 'stolik-addon.json'), JSON.stringify(GOOD))
    const r = readManifest(join(dir, 'good'))
    assert.ok('manifest' in r)
    assert.equal(r.manifest.version, '1.2.0')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------- consent text and gate ----------

test('describeAccess: each declared field is named in plain words, and the run line is shown', () => {
  const lines = describeAccess(parseManifest(GOOD)).join('\n')
  assert.match(lines, /voice-thing 1\.2\.0 asks for:/)
  assert.match(lines, /audio of your voice notes/)
  assert.match(lines, /read the text of your messages/)
  assert.doesNotMatch(lines, /chat log/)
  assert.match(lines, /runs|node index\.mjs/)
  assert.match(lines, /needs these addons installed and enabled: ml-worker/)
})

test('describeAccess: an addon with no access says so', () => {
  const { access: _a, ...rest } = GOOD
  const lines = describeAccess(parseManifest({ ...rest, access: [] })).join('\n')
  assert.match(lines, /nothing beyond its own requests/)
})

test('listenerWarning: loud for listeners only', () => {
  const l = parseManifest({ ...GOOD, provides: [{ point: 'listener' }] })
  assert.match(listenerWarning(l) ?? '', /WARNING.*LISTENER/)
  assert.equal(listenerWarning(parseManifest(GOOD)), null)
})

test('consentGiven: only the typed word yes, surrounding spaces ignored', () => {
  assert.equal(consentGiven('yes'), true)
  assert.equal(consentGiven('  yes \n'), true)
  for (const no of ['', 'y', 'Yes', 'YES', 'yes please', 'no', 'ye']) assert.equal(consentGiven(no), false, no)
})

// ---------- points: prefix, command and schedules ----------

test('parsePrefix: a prefix word followed by a colon, comma or dash, any case, Russian included', () => {
  assert.deepEqual(parsePrefix('note: buy milk'), { word: 'note', rest: 'buy milk' })
  assert.deepEqual(parsePrefix('NOTE - buy milk'), { word: 'note', rest: 'buy milk' })
  assert.deepEqual(parsePrefix('заметка, купить хлеб'), { word: 'заметка', rest: 'купить хлеб' })
  assert.deepEqual(parsePrefix('Заметка – купить'), { word: 'заметка', rest: 'купить' })
})

test('parsePrefix: no separator means no prefix', () => {
  assert.equal(parsePrefix('note buy milk'), null)
  assert.equal(parsePrefix('just text'), null)
  assert.equal(parsePrefix(''), null)
})

test('parseCommand: /word, /word@bot and the argument', () => {
  assert.deepEqual(parseCommand('/echo one two'), { command: 'echo', arg: 'one two' })
  assert.deepEqual(parseCommand('/Echo@tg_bot'), { command: 'echo', arg: '' })
  assert.equal(parseCommand('echo one'), null)
  // protocol 2: `!word` is the same command; the addon gets the bare word.
  assert.deepEqual(parseCommand('!echo one'), { command: 'echo', arg: 'one' })
  assert.deepEqual(parseCommand('!Echo@tg_bot two'), { command: 'echo', arg: 'two' })
  assert.equal(parseCommand('/ echo'), null)
})

test('dueSchedules: a schedule is due when first seen and again after its interval', () => {
  const host = {
    running: () => [{ name: 'digest', manifest: { provides: [{ point: 'schedule', everyMinutes: 10 }] } as never }],
  }
  const last = new Map<string, number>()
  const t0 = 1_000_000
  assert.deepEqual(dueSchedules(host, t0, last), ['digest#0'])
  last.set('digest#0', t0)
  assert.deepEqual(dueSchedules(host, t0 + 9 * 60_000, last), [])
  assert.deepEqual(dueSchedules(host, t0 + 10 * 60_000, last), ['digest#0'])
})

// ---------- settings ----------

test('JsonAddonSettings: round trip, a corrupt file reads as off, and the write is atomic', () => {
  const dir = tmpDir('settings')
  try {
    const path = join(dir, 'addons.json')
    const s = new JsonAddonSettings(path)
    assert.equal(s.isEnabled('a'), false)
    s.setEnabled('a', true)
    s.setEnabled('b', false)
    assert.equal(s.isEnabled('a'), true)
    assert.equal(new JsonAddonSettings(path).isEnabled('a'), true)
    assert.equal(new JsonAddonSettings(path).isEnabled('b'), false)
    writeFileSync(path, '[1, 2')
    assert.equal(s.isEnabled('a'), false)
    s.setEnabled('c', true)
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { c: true })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------- /addons menu text and buttons ----------

test('addons menu: text, one on/off button per addon, and the callback round trip', () => {
  const list = [
    { name: 'voice', version: '1.0.0', enabled: false, running: false, status: 'off', provides: ['media'] },
    { name: 'notes', version: '0.2.0', enabled: true, running: true, status: 'running', provides: ['prefix'] },
  ]
  assert.match(addonsMenuText(list), /voice 1\.0\.0: off, off \(media\)/)
  const rows = addonsMenuRows(list)
  assert.deepEqual(rows, [
    [{ text: 'Turn on voice', data: 'ad:voice:on' }],
    [{ text: 'Turn off notes', data: 'ad:notes:off' }],
  ])
  for (const row of rows) for (const b of row) assert.ok(Buffer.byteLength(b.data) <= 64)
  assert.deepEqual(parseAddonCallback('ad:notes:off'), { name: 'notes', on: false })
  assert.equal(parseAddonCallback('ad:Notes:off'), null)
  assert.equal(parseAddonCallback('ad:notes:maybe'), null)
  assert.match(addonsMenuText([]), /No addons installed/)
})

// Review finding 4: a dash directly after a word is not a prefix separator (points.ts), only a colon, a comma, or a
// dash with spaces around it.
test('points parsePrefix: a dash directly after the word is not a separator', () => {
  for (const text of ['quick-fix the bug', 'read-only audit', 'web-based tool', 'sto-lik: hi', 'note-to-self']) {
    assert.equal(parsePrefix(text), null, text)
  }
  assert.deepEqual(parsePrefix('note - buy milk'), { word: 'note', rest: 'buy milk' })
  assert.deepEqual(parsePrefix('note: buy milk'), { word: 'note', rest: 'buy milk' })
  assert.deepEqual(parsePrefix('read, the docs'), { word: 'read', rest: 'the docs' })
})

// ---------- serves, deadlines, consent hash ----------

test('manifest: serves defaults to none; served ops parse; a host op in serves is a manifest error that names it', () => {
  assert.deepEqual(parseManifest(GOOD).serves, [])
  assert.deepEqual(parseManifest({ ...GOOD, serves: ['generate', 'transcribe', 'clean'] }).serves, ['generate', 'transcribe', 'clean'])
  for (const op of RESERVED_OPS) {
    assert.throws(() => parseManifest({ ...GOOD, serves: [op] }), new RegExp(`serves.*${op} is a host op`))
  }
  assert.throws(() => parseManifest({ ...GOOD, serves: ['Generate'] }), /serves\.0/)
  assert.throws(() => parseManifest({ ...GOOD, serves: ['a'] }), /serves\.0/)
  assert.throws(() => parseManifest({ ...GOOD, serves: ['generate', 'generate'] }), /listed twice/)
  assert.ok(RESERVED_OPS.includes('text-filter') && RESERVED_OPS.includes('router') && RESERVED_OPS.includes('event'))
})

test('manifest: the deadline is a key every call may carry, and the access filter lets it through', () => {
  assert.equal(KEY_ACCESS.deadline, null)
  const r = filterPayload({ op: 'x', deadline: 123 }, { access: [] })
  assert.deepEqual(r.payload, { op: 'x', deadline: 123 })
  assert.deepEqual(r.dropped, [])
})

test('consentHash: stable for the same manifest, whatever the key order, and changed by any field the owner agrees to', () => {
  const a = parseManifest(GOOD)
  const reordered = parseManifest(Object.fromEntries(Object.entries(GOOD).reverse()))
  assert.equal(consentHash(a), consentHash(reordered))
  assert.match(consentHash(a), /^[0-9a-f]{64}$/)
  const changes: Array<Partial<typeof GOOD> & Record<string, unknown>> = [
    { version: '1.2.1' },
    { command: ['node', 'other.js'] },
    { provides: [{ point: 'media', kinds: ['voice'] }] },
    { access: ['message.audio'] },
    { requires: [] },
    { serves: ['generate'] },
  ]
  for (const change of changes) {
    assert.notEqual(consentHash(parseManifest({ ...GOOD, ...change })), consentHash(a), JSON.stringify(change))
  }
  // A field outside the consent set (the defaults are the same as the explicit empty lists) does not change it.
  assert.equal(consentHash(parseManifest({ ...GOOD, access: [...GOOD.access], serves: [] })), consentHash(a))
})

test('describeAccess: the ops an addon serves for others are named, and an addon that serves nothing says nothing about it', () => {
  const ml = parseManifest({ ...GOOD, serves: ['generate', 'transcribe'] })
  assert.ok(describeAccess(ml).includes('It answers these ops for the addons that require it: generate, transcribe'))
  assert.ok(!describeAccess(parseManifest(GOOD)).some((l) => /answers these ops/.test(l)))
})
