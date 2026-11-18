import './helpers/isolate.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  attachmentRelPath, dayHeader, jsonlLine, localDay, localMonth, markdownLine, mdInline, newChatLine, parseJsonl,
  selectExchanges, type ChatLine,
} from '../src/brain/chatlog.ts'
import { tgMsg } from '../src/adapters/chat/tg-ids.ts'

// Local time, so the expected strings hold in every time zone.
const at = (y: number, mo: number, d: number, h: number, mi: number, s = 0) => new Date(y, mo - 1, d, h, mi, s).getTime()
const when = at(2026, 11, 9, 14, 3, 12)

test('newChatLine: the fields not given take their empty values', () => {
  const l = newChatLine({ ts: when, dir: 'in', kind: 'text', text: 'hi' })
  assert.deepEqual(l, {
    ts: when, dir: 'in', kind: 'text', text: 'hi', raw: null, target: null, topic_id: null, backend: null,
    scores: null, gap: null, attachments: [], tg_message_id: null,
  })
})

test('jsonlLine: one line, the design field order, ts as ISO text', () => {
  const l = newChatLine({
    ts: Date.UTC(2026, 10, 9, 14, 3, 12), dir: 'out', kind: 'response', text: 'done',
    target: { type: 'session', name: 'proj' }, tg_message_id: tgMsg(77), attachments: ['attachments/2026-11-09/140312-a.png'],
  })
  const out = jsonlLine(l)
  assert.equal(out.endsWith('\n'), true)
  assert.equal(out.split('\n').length, 2, 'exactly one line and the trailing newline')
  assert.equal(
    out,
    '{"ts":"2026-11-09T14:03:12.000Z","dir":"out","kind":"response","text":"done","raw":null,' +
      '"target":{"type":"session","name":"proj"},"topic_id":null,"backend":null,"scores":null,"gap":null,' +
      '"attachments":["attachments/2026-11-09/140312-a.png"],"tg_message_id":77}\n',
  )
})

test('parseJsonl: reads back what jsonlLine wrote, and skips lines that do not parse', () => {
  const a = newChatLine({ ts: when, dir: 'in', kind: 'photo', text: 'look', target: { type: 'note', name: 'inbox' }, tg_message_id: tgMsg(5) })
  const b = newChatLine({ ts: when + 1000, dir: 'out', kind: 'notice', text: 'ok' })
  const back = parseJsonl(jsonlLine(a) + '{broken\n\n' + jsonlLine(b) + '{"ts":"x"')
  assert.deepEqual(back, [a, b])
})

test('localDay, localMonth: calendar parts of local time', () => {
  assert.equal(localDay(at(2026, 11, 30, 23, 59, 59)), '2026-11-30')
  assert.equal(localMonth(at(2026, 12, 1, 0, 0, 1)), '2026-12')
})

test('markdownLine: the heading first, then one line per message', () => {
  const l = newChatLine({ ts: when, dir: 'in', kind: 'text', text: 'hello', target: { type: 'session', name: 'proj' } })
  assert.deepEqual(markdownLine(l, null), { text: '# 2026-11-09\n\n- 14:03:12 **in** [session proj] hello\n', day: '2026-11-09' })
})

test('markdownLine: no heading on the same day; non-text kinds and files are shown', () => {
  const l = newChatLine({
    ts: when + 60_000, dir: 'in', kind: 'photo', text: 'see', attachments: ['attachments/2026-11-09/140312-p.jpg'],
  })
  assert.deepEqual(markdownLine(l, '2026-11-09'), {
    text: '- 14:04:12 **in** (photo) see attachments: attachments/2026-11-09/140312-p.jpg\n',
    day: '2026-11-09',
  })
})

test('markdownLine: a message with no text is a line with no body', () => {
  const l = newChatLine({ ts: when, dir: 'out', kind: 'notice', text: '' })
  assert.equal(markdownLine(l, '2026-11-09').text, '- 14:03:12 **out** (notice)\n')
})

test('rollover at midnight: the next day gets its own heading', () => {
  const late = newChatLine({ ts: at(2026, 11, 9, 23, 59, 59), dir: 'in', kind: 'text', text: 'late' })
  const early = newChatLine({ ts: at(2026, 11, 10, 0, 0, 1), dir: 'in', kind: 'text', text: 'early' })
  const first = markdownLine(late, null)
  const second = markdownLine(early, first.day)
  assert.equal(first.day, '2026-11-09')
  assert.equal(second.day, '2026-11-10')
  assert.equal(second.text, dayHeader('2026-11-10') + '- 00:00:01 **in** early\n')
})

test('mdInline: newlines, markup and a leading # cannot add lines or structure', () => {
  const hostile = '# Title\n```js\n<b>x</b>\n[a](javascript:alert(1))\\ end'
  const out = mdInline(hostile)
  assert.equal(out.includes('\n'), false)
  assert.equal(out, '\\# Title ↵ \\`\\`\\`js ↵ \\<b\\>x\\</b\\> ↵ \\[a\\](javascript:alert(1))\\\\ end')
})

test('markdownLine: hostile text stays on one line', () => {
  const l = newChatLine({ ts: when, dir: 'in', kind: 'text', text: '## fake\n- injected\n```\nend', target: { type: 'session', name: 'p' } })
  const { text } = markdownLine(l, '2026-11-09')
  assert.equal(text.split('\n').length, 2, 'the line and the trailing newline only')
  assert.equal(text.startsWith('- 14:03:12 **in** [session p] \\## fake'), true)
})

test('attachmentRelPath: attachments/<day>/<HHMMSS>-<name>, with a counter when the name is taken', () => {
  assert.equal(attachmentRelPath(when, 'photo.jpg', () => false), 'attachments/2026-11-09/140312-photo.jpg')
  const taken = new Set(['attachments/2026-11-09/140312-photo.jpg'])
  assert.equal(attachmentRelPath(when, 'photo.jpg', (r) => taken.has(r)), 'attachments/2026-11-09/140312-2-photo.jpg')
})

test('attachmentRelPath: the name is reduced to a single safe file name', () => {
  assert.equal(attachmentRelPath(when, '../../etc/passwd', () => false), 'attachments/2026-11-09/140312-passwd')
  assert.equal(attachmentRelPath(when, 'a[1].pdf', () => false), 'attachments/2026-11-09/140312-a_1_.pdf')
})

test('selectExchanges: the last n lines of one target, oldest first', () => {
  const mk = (name: string | null, text: string, dt: number): ChatLine =>
    newChatLine({ ts: when + dt, dir: 'in', kind: 'text', text, target: name === null ? null : { type: 'session', name } })
  const lines = [mk('a', '1', 0), mk('b', 'x', 1), mk('a', '2', 2), mk(null, 'n', 3), mk('a', '3', 4)]
  assert.deepEqual(selectExchanges(lines, { type: 'session', name: 'a' }, 2).map((l) => l.text), ['2', '3'])
  assert.deepEqual(selectExchanges(lines, { type: 'session', name: 'a' }, 0), [])
  assert.deepEqual(selectExchanges(lines, { type: 'session', name: 'zzz' }, 5), [])
  assert.deepEqual(selectExchanges(lines, { type: 'mode', name: 'a' }, 5), [], 'type must match too')
})
