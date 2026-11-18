import './helpers/isolate.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseNote, formatNoteEntry, localStamp, fileStamp, attachmentFileName } from '../src/router/notes.ts'

const when = new Date(2026, 10, 9, 14, 3, 12) // local time, 9 Nov 2026

test('parseNote: a leading "note" as a whole word, any case, with separators; the prefix is stripped', () => {
  assert.equal(parseNote('Note: buy milk'), 'buy milk')
  assert.equal(parseNote('note buy milk'), 'buy milk')
  assert.equal(parseNote('NOTE\nbuy milk'), 'buy milk')
  assert.equal(parseNote('  note, buy milk'), 'buy milk')
  assert.equal(parseNote('note — buy milk'), 'buy milk')
  assert.equal(parseNote('note-to-self'), 'to-self')
})

test('parseNote: a bare note is an empty note (media only, or nothing after the word)', () => {
  assert.equal(parseNote('Note.'), '')
  assert.equal(parseNote('note'), '')
})

test('parseNote: other words, and text that does not start with note, are not notes', () => {
  assert.equal(parseNote('notes are good'), null)
  assert.equal(parseNote('notebook'), null)
  assert.equal(parseNote('take a note'), null)
  assert.equal(parseNote('/note buy milk'), null)
  assert.equal(parseNote(''), null)
  assert.equal(parseNote('no note here'), null)
})

test('formatNoteEntry: heading, blank line, text, no attachment lines for a text note', () => {
  assert.equal(formatNoteEntry(when, 'buy milk', []), '## 2026-11-09 14:03\n\nbuy milk\n')
})

test('formatNoteEntry: photo and file attachments as markdown lines after the text', () => {
  const out = formatNoteEntry(when, 'see this', [
    { path: 'attachments/20261109-140312_photo.jpg', label: 'photo', image: true },
    { path: 'attachments/20261109-140312_report.pdf', label: 'report.pdf', image: false },
  ])
  assert.equal(
    out,
    '## 2026-11-09 14:03\n\nsee this\n![photo](attachments/20261109-140312_photo.jpg)\n[report.pdf](attachments/20261109-140312_report.pdf)\n',
  )
})

test('formatNoteEntry: a media-only note has no text line', () => {
  assert.equal(
    formatNoteEntry(when, '', [{ path: 'attachments/x_photo.jpg', label: 'photo', image: true }]),
    '## 2026-11-09 14:03\n\n![photo](attachments/x_photo.jpg)\n',
  )
})

test('timestamps use local time with zero padding', () => {
  assert.equal(localStamp(when), '2026-11-09 14:03')
  assert.equal(fileStamp(when), '20261109-140312')
  assert.equal(localStamp(new Date(2026, 0, 2, 7, 5)), '2026-01-02 07:05')
})

test('attachmentFileName: timestamp plus a sanitized name', () => {
  assert.equal(attachmentFileName(when, 'photo.jpg'), '20261109-140312_photo.jpg')
  assert.equal(attachmentFileName(when, '../evil[1].pdf'), '20261109-140312_evil_1_.pdf')
})
