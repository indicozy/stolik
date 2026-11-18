// logind session selection with fake loginctl output: the caller's graphical session, never `self`.
import './helpers/isolate.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  lookupGraphicalSession, parseSessionList, parseSessionProps, pickGraphicalSession, resolveGraphicalSession,
  type LoginctlRun,
} from '../src/adapters/platform/linux-logind.ts'

// Output of `loginctl list-sessions --no-legend --no-pager` on a desktop with a tty login and a Wayland session.
const LIST = [
  '      3 1000 indicozy seat0 tty2',
  '      5 1000 indicozy seat0 ',
  '     17 0 root pts/0',
  '',
].join('\n')

// A fake loginctl: answers from a table keyed by the argument list, and records every call.
function fakeLoginctl(table: Record<string, string | null>) {
  const calls: string[][] = []
  const run: LoginctlRun = async (args) => {
    calls.push(args)
    const key = args.join(' ')
    if (!(key in table)) throw new Error(`unexpected loginctl call: ${key}`)
    return table[key] ?? null
  }
  return { run, calls }
}

test('parseSessionList: id and uid per row, blank lines and junk skipped', () => {
  assert.deepEqual(parseSessionList(LIST), [
    { id: '3', uid: 1000 },
    { id: '5', uid: 1000 },
    { id: '17', uid: 0 },
  ])
  assert.deepEqual(parseSessionList('garbage\n  x y z\n'), [])
})

test('parseSessionProps: Type and Active, missing values null', () => {
  assert.deepEqual(parseSessionProps('Type=wayland\nActive=yes\n'), { type: 'wayland', active: true })
  assert.deepEqual(parseSessionProps('Type=tty\nActive=no\n'), { type: 'tty', active: false })
  assert.deepEqual(parseSessionProps(''), { type: null, active: null })
})

test('pickGraphicalSession: the first active x11 or wayland session of the uid; tty and other uids do not count', () => {
  const rows = [
    { id: '3', uid: 1000, type: 'tty', active: true },
    { id: '4', uid: 1000, type: 'x11', active: false },
    { id: '5', uid: 1000, type: 'wayland', active: true },
    { id: '9', uid: 0, type: 'x11', active: true },
  ]
  assert.equal(pickGraphicalSession(rows, 1000), '5')
  assert.equal(pickGraphicalSession(rows, 0), '9')
  assert.equal(pickGraphicalSession([{ id: '3', uid: 1000, type: 'tty', active: true }], 1000), null)
  assert.equal(pickGraphicalSession([], 1000), null)
})

test('resolveGraphicalSession: a user service (no XDG_SESSION_ID) finds the wayland session, never self', async () => {
  const { run, calls } = fakeLoginctl({
    'list-sessions --no-legend --no-pager': LIST,
    'show-session 3 -p Type -p Active': 'Type=tty\nActive=yes\n',
    'show-session 5 -p Type -p Active': 'Type=wayland\nActive=yes\n',
    'show-session 17 -p Type -p Active': 'Type=x11\nActive=yes\n', // root's session: not ours
  })
  assert.equal(await resolveGraphicalSession(1000, run), '5')
  assert.ok(calls.every((c) => !c.includes('self')), 'self is never asked for')
  assert.ok(!calls.some((c) => c[1] === '17'), 'sessions of other uids are not even asked about')
})

test('resolveGraphicalSession: an x11 session of the uid that is active is picked', async () => {
  const { run } = fakeLoginctl({
    'list-sessions --no-legend --no-pager': '   8 1000 indicozy seat0 :0\n',
    'show-session 8 -p Type -p Active': 'Type=x11\nActive=yes\n',
  })
  assert.equal(await resolveGraphicalSession(1000, run), '8')
})

test('resolveGraphicalSession: a session whose show fails is skipped; no active graphical session gives null', async () => {
  const failing = fakeLoginctl({
    'list-sessions --no-legend --no-pager': LIST,
    'show-session 3 -p Type -p Active': null,
    'show-session 5 -p Type -p Active': 'Type=wayland\nActive=no\n',
  })
  assert.equal(await resolveGraphicalSession(1000, failing.run), null)
})

test('resolveGraphicalSession: loginctl itself failing gives null (the away rule then reads unknown)', async () => {
  const { run } = fakeLoginctl({ 'list-sessions --no-legend --no-pager': null })
  assert.equal(await resolveGraphicalSession(1000, run), null)
})

test('lookupGraphicalSession: an active graphical session of the uid is a session', async () => {
  const { run } = fakeLoginctl({
    'list-sessions --no-legend --no-pager': LIST,
    'show-session 3 -p Type -p Active': 'Type=tty\nActive=yes\n',
    'show-session 5 -p Type -p Active': 'Type=wayland\nActive=yes\n',
  })
  assert.deepEqual(await lookupGraphicalSession(1000, run), { kind: 'session', id: '5' })
})

test('lookupGraphicalSession: only a tty for the uid (greeter and root sessions aside) is none; an inactive wayland is unknown', async () => {
  // The PC sits at the LightDM greeter: uid 1000 has only its tty, the greeter belongs to another uid.
  const onlyTty = fakeLoginctl({
    'list-sessions --no-legend --no-pager': '      3 1000 indicozy seat0 tty2\n     17 0 root pts/0\n     9 118 lightdm seat0 \n',
    'show-session 3 -p Type -p Active': 'Type=tty\nActive=yes\n',
  })
  assert.deepEqual(await lookupGraphicalSession(1000, onlyTty.run), { kind: 'none' })
  const inactive = fakeLoginctl({
    'list-sessions --no-legend --no-pager': LIST,
    'show-session 3 -p Type -p Active': 'Type=tty\nActive=yes\n',
    'show-session 5 -p Type -p Active': 'Type=wayland\nActive=no\n',
  })
  assert.deepEqual(await lookupGraphicalSession(1000, inactive.run), { kind: 'unknown' }, 'a graphical session exists')
})

test('lookupGraphicalSession: no sessions at all is none', async () => {
  const { run } = fakeLoginctl({ 'list-sessions --no-legend --no-pager': '\n' })
  assert.deepEqual(await lookupGraphicalSession(1000, run), { kind: 'none' })
})

test('lookupGraphicalSession: loginctl failing is unknown, never none', async () => {
  const { run } = fakeLoginctl({ 'list-sessions --no-legend --no-pager': null })
  assert.deepEqual(await lookupGraphicalSession(1000, run), { kind: 'unknown' })
})

test('lookupGraphicalSession: a uid session whose show fails is unknown, not none', async () => {
  const { run } = fakeLoginctl({
    'list-sessions --no-legend --no-pager': LIST,
    'show-session 3 -p Type -p Active': null,
    'show-session 5 -p Type -p Active': 'Type=tty\nActive=yes\n',
  })
  assert.deepEqual(await lookupGraphicalSession(1000, run), { kind: 'unknown' })
})
