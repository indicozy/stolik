// Idle close through the router: the warning at idle minus 5 minutes, the close at the limit, Keep open, every busy
// check that keeps a session open, and how a process, a tmux session and a terminal window are stopped. Fake ports and a
// fake clock; the transcript is a real file in a temp home, with its mtime set on the fake clock.
import './helpers/isolate.ts'
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { projectFolder } from '../src/adapters/transcripts.ts'
import { MINUTE } from '../src/brain/common.ts'
import { closeSession } from '../src/router/close.ts'
import { FakeConn, OWNER, flush, harness } from './helpers/fakes.ts'

const HOME_DIR = mkdtempSync(join(tmpdir(), 'idle-close-'))
after(() => rmSync(HOME_DIR, { recursive: true, force: true }))

const PROJ = '/work/proj'
const PID = 4242
const SHELL = 4000
const TERM = 555
const CHILD = 4343
const SID = 'idle-sess-1'
const TRANSCRIPT = join(HOME_DIR, '.claude', 'projects', projectFolder(PROJ), `${SID}.jsonl`)
const BASH_ARGV = ['/usr/bin/zsh', '-c', 'source /home/u/.claude/shell-snapshots/snapshot-zsh-1.sh 2>/dev/null || true && ls']
const WAKEUP_LINE = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'ScheduleWakeup', input: { delaySeconds: 1800, stop: false } }] } })

// A DM-mode router with one channel session (pid 4242) in PROJ, started and registered. The transcript (default: an
// ordinary line) is written with an mtime two hours before the session started, so it never counts as activity.
// `transcript: null` leaves no file.
async function session(opts: { minutes?: number; transcript?: string | null } = {}) {
  const h = harness({ home: HOME_DIR, idleCloseMinutes: opts.minutes })
  await h.router.start()
  h.platform.dirs.add(PROJ)
  const conn = new FakeConn()
  h.agent.receive(conn, { t: 'register', claudePid: PID, cwd: PROJ })
  await flush()
  const s = h.router.registry.list()[0]
  s.backendSessionId = SID
  rmSync(TRANSCRIPT, { force: true })
  if (opts.transcript !== null) {
    mkdirSync(join(HOME_DIR, '.claude', 'projects', projectFolder(PROJ)), { recursive: true })
    writeFileSync(TRANSCRIPT, opts.transcript ?? '{"type":"user","message":{"content":"hi"}}\n')
    const t = (h.clock.now() - 2 * 60 * MINUTE) / 1000
    utimesSync(TRANSCRIPT, t, t)
  }
  return { ...h, s, conn }
}

// The fake process exits when it gets SIGTERM (the registry sweep then drops the session, as it does for a real exit).
function exitOnTerm(h: { platform: { signal: (pid: number, sig: 'SIGTERM' | 'SIGKILL') => boolean; dead: Set<number> } }): void {
  const signal = h.platform.signal.bind(h.platform)
  h.platform.signal = (pid, sig) => {
    const ok = signal(pid, sig)
    if (sig === 'SIGTERM' && pid === PID) h.platform.dead.add(PID)
    return ok
  }
}

const sentWith = (h: { chat: { sent: Array<{ text: string; opts?: any }> } }, prefix: string) =>
  h.chat.sent.filter((m) => m.text.startsWith(prefix))
const warnings = (h: Parameters<typeof sentWith>[0]) => sentWith(h, '💤 Closing this session')
const closeNotices = (h: Parameters<typeof sentWith>[0]) => sentWith(h, 'Closed ')
const signalsTo = (h: { platform: { signals: Array<{ pid: number; sig: string }> } }, pid: number) =>
  h.platform.signals.filter((x) => x.pid === pid)

// Warn at 55 min, let the warning reach Telegram (it arms the close only once sent), then reach 60 min.
async function toClose(h: { clock: { advance: (ms: number) => void } }): Promise<void> {
  h.clock.advance(55 * MINUTE)
  await flush()
  h.clock.advance(5 * MINUTE)
}

test('a session gets the warning at 55 minutes idle and is closed at 60', async () => {
  const h = await session()
  h.clock.advance(54 * MINUTE)
  assert.equal(warnings(h).length, 0)
  h.clock.advance(MINUTE)
  await flush()
  assert.equal(warnings(h).length, 1)
  const rows = warnings(h)[0].opts.rows
  assert.deepEqual(rows, [[{ text: 'Keep open', data: `ic:k:${h.s.key}` }]])
  h.clock.advance(4 * MINUTE)
  assert.equal(signalsTo(h, PID).length, 0, 'not closed at 59 minutes')
  h.clock.advance(MINUTE)
  assert.deepEqual(signalsTo(h, PID).map((x) => x.sig), ['SIGTERM'])
  assert.equal(closeNotices(h).length, 1)
  assert.match(closeNotices(h)[0].text, /^Closed after 60 min idle\./)
})

test('Keep open restarts the idle time and takes the button off', async () => {
  const h = await session()
  h.clock.advance(55 * MINUTE)
  const warning = warnings(h)[0]
  await h.chat.callback({ pressId: 'cb-1', data: `ic:k:${h.s.key}`, message: warning.id, from: OWNER, chat: undefined })
  assert.ok(h.chat.answers.some((a) => a.id === 'cb-1' && a.text === 'Kept open'))
  assert.ok(h.chat.rowEdits.some((e) => e.messageId === warning.id && e.rows.length === 0))
  h.clock.advance(50 * MINUTE)
  assert.equal(signalsTo(h, PID).length, 0, 'no close 50 minutes after Keep open')
  assert.equal(warnings(h).length, 1, 'no second warning yet')
  h.clock.advance(5 * MINUTE)
  assert.equal(warnings(h).length, 2, 'warned again 55 minutes after Keep open')
})

test('activity after the warning removes its button and cancels the close', async () => {
  const h = await session()
  h.clock.advance(55 * MINUTE)
  await flush()
  const warning = warnings(h)[0]
  h.s.lastActive = h.clock.now()
  h.clock.advance(MINUTE)
  await flush()
  assert.ok(h.chat.rowEdits.some((e) => e.messageId === warning.id && e.rows.length === 0))
  h.clock.advance(4 * MINUTE)
  assert.equal(signalsTo(h, PID).length, 0)
})

// Each busy reason keeps the session open for as long as it holds: no warning, no close.
const busyCases: Array<{ name: string; transcript?: string | null; setup: (h: any) => void }> = [
  { name: 'a Bash tool command running', setup: (h) => { h.platform.children.set(PID, [CHILD]); h.platform.argvs.set(CHILD, BASH_ARGV) } },
  { name: 'a turn in progress', setup: (h) => { h.router.registry.list()[0].inTurn = true } },
  { name: 'a wake-up scheduled', transcript: `${WAKEUP_LINE}\n`, setup: () => {} },
  { name: 'an unreadable process tree', setup: (h) => { h.platform.treeUnreadable = true } },
  { name: 'a missing transcript', transcript: null, setup: () => {} },
]
for (const c of busyCases) {
  test(`a session with ${c.name} is never closed`, async () => {
    const h = await session({ transcript: c.transcript })
    c.setup(h)
    h.clock.advance(70 * MINUTE)
    assert.equal(warnings(h).length, 0)
    assert.equal(signalsTo(h, PID).length, 0)
    assert.equal(closeNotices(h).length, 0)
  })
}

test('a tmux session is closed through stopSession, not by signal', async () => {
  const h = await session()
  const stopped: string[] = []
  h.router.stopSession = async (name) => {
    stopped.push(name)
    return true
  }
  h.router.tmuxBySession.set(h.s.key, 'tg-proj')
  await toClose(h)
  assert.deepEqual(stopped, ['tg-proj'])
  assert.equal(signalsTo(h, PID).length, 0)
})

test('a plain claude process gets SIGTERM, then SIGKILL 10 seconds later if still alive', async () => {
  const h = await session()
  await toClose(h)
  assert.deepEqual(signalsTo(h, PID).map((x) => x.sig), ['SIGTERM'])
  h.clock.advance(9_000)
  assert.deepEqual(signalsTo(h, PID).map((x) => x.sig), ['SIGTERM'], 'no SIGKILL before 10 seconds')
  h.clock.advance(1_000)
  assert.deepEqual(signalsTo(h, PID).map((x) => x.sig), ['SIGTERM', 'SIGKILL'])
})

test('no SIGKILL when the process exits on SIGTERM', async () => {
  const h = await session()
  exitOnTerm(h)
  await toClose(h)
  h.clock.advance(10 * 1000)
  assert.deepEqual(signalsTo(h, PID).map((x) => x.sig), ['SIGTERM'])
})

test('the terminal window is closed after the claude process, when its shell has no children left', async () => {
  const h = await session()
  h.platform.terminalWindow = TERM
  h.platform.parents.set(PID, SHELL)
  exitOnTerm(h)
  await toClose(h)
  h.clock.advance(10 * 1000)
  assert.deepEqual(h.platform.signals.map((x) => `${x.pid}:${x.sig}`), [`${PID}:SIGTERM`, `${TERM}:SIGTERM`])
})

test('the terminal window stays open while its shell still has a child', async () => {
  const h = await session()
  h.platform.terminalWindow = TERM
  h.platform.parents.set(PID, SHELL)
  h.platform.children.set(SHELL, [CHILD])
  exitOnTerm(h)
  await toClose(h)
  h.clock.advance(10 * 1000)
  assert.equal(signalsTo(h, TERM).length, 0)
})

test('no terminal window is signalled when terminalWindowPid finds none', async () => {
  const h = await session()
  h.platform.parents.set(PID, SHELL)
  exitOnTerm(h)
  await toClose(h)
  h.clock.advance(10 * 1000)
  assert.equal(signalsTo(h, TERM).length, 0)
})

test('idleCloseMinutes 0 turns the idle close off', async () => {
  const h = await session({ minutes: 0 })
  h.clock.advance(3 * 60 * MINUTE)
  assert.equal(warnings(h).length, 0)
  assert.equal(h.platform.signals.length, 0)
})

test('a second close of the same session is refused while the first is under way', async () => {
  const h = await session()
  const first = await closeSession(h.router, h.s, 'request')
  const second = await closeSession(h.router, h.s, 'request')
  assert.equal(first, true)
  assert.equal(second, false)
  assert.equal(signalsTo(h, PID).filter((x) => x.sig === 'SIGTERM').length, 1)
  assert.equal(closeNotices(h).length, 1)
  await toClose(h)
  assert.equal(signalsTo(h, PID).filter((x) => x.sig === 'SIGTERM').length, 1, 'the sweep does not close it again')
  assert.equal(warnings(h).length, 0, 'nor warns about it again')
})

// The router's idle sweep reads the transcript only when the session is otherwise idle; a wake-up that is still pending
// keeps it busy. The verdict is kept per transcript mtime, so an unchanged file is not read again on the next sweep.
test('a pending wake-up keeps the session busy; the transcript is read once while its mtime is unchanged', async () => {
  const h = await session({ transcript: `${WAKEUP_LINE}\n` })
  h.clock.advance(70 * MINUTE)
  assert.equal(warnings(h).length, 0)
  const before = statSync(TRANSCRIPT)
  // Same mtime, different content: a read would now find no wake-up and warn. The kept verdict must answer instead.
  writeFileSync(TRANSCRIPT, '{"type":"user","message":{"content":"hi"}}\n')
  utimesSync(TRANSCRIPT, before.atime, before.mtime)
  h.clock.advance(MINUTE)
  assert.equal(warnings(h).length, 0, 'the unchanged mtime keeps the earlier verdict')
  // A new mtime is read again: the file now says idle, so the warning comes.
  const later = (h.clock.now() - 3 * 60 * MINUTE) / 1000
  utimesSync(TRANSCRIPT, later, later)
  h.clock.advance(MINUTE)
  assert.equal(warnings(h).length, 1, 'a changed mtime is read again')
})

test('close_session: the router answers ok, then the session is closed 2 s later (SIGTERM)', async () => {
  const h = await session()
  h.agent.receive(h.conn, { t: 'close', reqId: 'c1' })
  assert.deepEqual(h.conn.sent.filter((m) => m.t === 'close_result'), [{ t: 'close_result', reqId: 'c1', ok: true }])
  assert.equal(signalsTo(h, PID).length, 0, 'not closed before the answer has gone out')
  h.clock.advance(1999)
  assert.equal(signalsTo(h, PID).length, 0)
  h.clock.advance(1)
  assert.deepEqual(signalsTo(h, PID).map((x) => x.sig), ['SIGTERM'])
  assert.equal(closeNotices(h).length, 1)
  assert.match(closeNotices(h)[0].text, /^Closed on request\./)
})

test('close_session from a channel that is not registered: ok false, nothing closes', async () => {
  const h = await session()
  const stray = new FakeConn()
  h.agent.receive(stray, { t: 'close', reqId: 'c2' })
  assert.deepEqual(stray.sent, [{ t: 'close_result', reqId: 'c2', ok: false, error: 'channel not registered with the router' }])
  h.clock.advance(5000)
  assert.equal(signalsTo(h, PID).length, 0)
})
