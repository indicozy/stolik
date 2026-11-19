// tmux adapter with a fake runner: exact session targets, the development-channels dialog (matcher, bounded retries,
// the miss report), and the startup watch outcomes. Time is a fake clock advanced by the fake sleep.
import './helpers/isolate.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DIALOG_ENTER_MAX, DIALOG_RETRY_MS, exactTarget, paneTail, startTmux, watchDevChannelsDialog, type Run, type TmuxRun } from '../src/adapters/tmux.ts'
import { isAcceptedChannelsBanner, isDevChannelsDialog, mentionsDevChannels } from '../src/router/state.ts'

const DIALOG = [
  'WARNING: Loading development channels',
  '--dangerously-load-development-channels is for local development only.',
  '',
  '❯ 1. I am using this for local development',
  '  2. Exit',
].join('\n')

// A fake tmux: `pane` is what capture-pane returns (a string, or a function of the call count), `gone` makes capture-pane
// fail. Every call is recorded as its argv.
function fakeTmux(opts: { pane?: string | (() => string); gone?: boolean } = {}) {
  const calls: string[][] = []
  let captures = 0
  const run: TmuxRun = async (cmd, args): Promise<Run> => {
    calls.push([cmd, ...args])
    if (args[0] === 'capture-pane') {
      captures++
      if (opts.gone) return { code: 1, stdout: '', stderr: "can't find session" }
      const pane = typeof opts.pane === 'function' ? opts.pane() : (opts.pane ?? '')
      return { code: 0, stdout: pane, stderr: '' }
    }
    return { code: 0, stdout: '', stderr: '' }
  }
  return { run, calls, captures: () => captures }
}

// A fake clock: sleep advances it by the requested time. Returns the sleep, the now and the time elapsed getter.
function fakeTime() {
  let t = 1_000_000
  return {
    sleep: async (ms: number) => {
      t += ms
    },
    now: () => t,
  }
}

const enters = (calls: string[][]) => calls.filter((c) => c[1] === 'send-keys')

test('exact targets: capture-pane and send-keys name the session exactly (=name:), so a prefix never matches', async () => {
  assert.equal(exactTarget('tg-alpha'), '=tg-alpha:')
  const tmux = fakeTmux({ pane: DIALOG })
  const time = fakeTime()
  await watchDevChannelsDialog('tg-alpha', 2_000, () => false, { run: tmux.run, ...time })
  const captures = tmux.calls.filter((c) => c[1] === 'capture-pane')
  assert.ok(captures.length > 0)
  for (const c of captures) assert.deepEqual(c, ['tmux', 'capture-pane', '-p', '-t', '=tg-alpha:'])
  for (const c of enters(tmux.calls)) assert.deepEqual(c, ['tmux', 'send-keys', '-t', '=tg-alpha:', 'Enter'])
})

test('paneTail uses the exact target too', async () => {
  const tmux = fakeTmux({ pane: 'line one\n\nline two\n' })
  assert.deepEqual(await paneTail('tg-alpha', tmux.run), ['line one', 'line two'])
  assert.deepEqual(tmux.calls[0], ['tmux', 'capture-pane', '-p', '-t', '=tg-alpha:'])
})

test('startTmux: the has-session probe uses the exact name, and a taken name gets a numbered suffix', async () => {
  const seen: string[][] = []
  let probes = 0
  const run: TmuxRun = async (cmd, args) => {
    seen.push([cmd, ...args])
    if (args[0] === 'has-session') {
      probes++
      return { code: probes <= 1 ? 0 : 1, stdout: '', stderr: '' } // the first name is taken
    }
    return { code: 0, stdout: '', stderr: '' }
  }
  const name = await startTmux('alpha', '/home/u/alpha', [], run)
  assert.equal(name, 'tg-alpha-2')
  assert.deepEqual(seen[0], ['tmux', 'has-session', '-t', '=tg-alpha'])
  // The start goes through the launcher (`env PATH=… [systemd-run …] tmux new-session …`), see tmux.ts.
  assert.ok(seen[seen.length - 1].includes('new-session'))
})

test('dialog matcher: case-insensitive, by flag name or by the channel phrases', () => {
  assert.equal(isDevChannelsDialog(DIALOG), true)
  assert.equal(isDevChannelsDialog(DIALOG.toUpperCase()), true)
  assert.equal(isDevChannelsDialog('Loading development channels\nI AM USING THIS FOR LOCAL DEVELOPMENT'), true)
  assert.equal(isDevChannelsDialog('dev channels\n1. I am using this for testing'), true)
  assert.equal(isDevChannelsDialog('--dangerously-load-development-channels\nlocal development'), true)
  // Not the dialog: folder trust, and channel names without a confirmation.
  assert.equal(isDevChannelsDialog('Do you trust the files in this folder?\n❯ 1. Yes, proceed'), false)
  assert.equal(isDevChannelsDialog('development channels mentioned, no confirmation'), false)
})

test('mentionsDevChannels: any channel mention, the dialog or not', () => {
  assert.equal(mentionsDevChannels('Some Development-Channels banner'), true)
  assert.equal(mentionsDevChannels('Do you trust the files in this folder?'), false)
})

test('the dialog is answered at once, then retried every DIALOG_RETRY_MS while it stays, at most DIALOG_ENTER_MAX times', async () => {
  const time = fakeTime()
  const pressedAt: number[] = []
  const tmux = fakeTmux({ pane: DIALOG })
  const run: TmuxRun = async (cmd, args) => {
    if (args[0] === 'send-keys') pressedAt.push(time.now())
    return tmux.run(cmd, args)
  }
  const outcome = await watchDevChannelsDialog('tg-alpha', 60_000, () => false, { run, ...time })
  assert.equal(outcome.kind, 'timeout')
  assert.equal(DIALOG_ENTER_MAX, 5)
  assert.equal(pressedAt.length, DIALOG_ENTER_MAX, 'bounded: exactly the cap while the dialog stays')
  for (let i = 1; i < pressedAt.length; i++) {
    assert.ok(pressedAt[i] - pressedAt[i - 1] >= DIALOG_RETRY_MS, `press ${i} is at least ${DIALOG_RETRY_MS} ms after the one before`)
  }
})

test('the dialog gets one Enter when it goes away after the first press (no retries once it is gone)', async () => {
  let shown = true
  const tmux = fakeTmux({ pane: () => (shown ? DIALOG : '$ ') })
  const time = fakeTime()
  const realSleep = time.sleep
  const sleep = async (ms: number) => {
    await realSleep(ms)
    if (tmux.calls.some((c) => c[1] === 'send-keys')) shown = false
  }
  const outcome = await watchDevChannelsDialog('tg-alpha', 20_000, () => false, { run: tmux.run, sleep, now: time.now })
  assert.equal(enters(tmux.calls).length, 1)
  assert.equal(outcome.kind, 'timeout')
})

test('a pane that names the channels without the dialog is reported once, and no key is pressed', async () => {
  const misses: string[][] = []
  const tmux = fakeTmux({ pane: 'WARNING: development channels are loading\nstill starting' })
  const time = fakeTime()
  await watchDevChannelsDialog('tg-alpha', 10_000, () => false, { run: tmux.run, ...time, onMiss: (pane) => misses.push(pane) })
  assert.equal(misses.length, 1)
  assert.deepEqual(misses[0], ['WARNING: development channels are loading', 'still starting'])
  assert.equal(enters(tmux.calls).length, 0)
})

test('the accepted-channels banner of a session that is starting fine is not reported as a dialog', async () => {
  const misses: string[][] = []
  const banner = 'Channels (experimental) messages from server:stolik inject directly in\nthis session · restart without --dangerously-load-development-channels to stop'
  assert.equal(isAcceptedChannelsBanner(banner), true)
  assert.equal(isAcceptedChannelsBanner('WARNING: development channels are loading'), false)
  const tmux = fakeTmux({ pane: banner })
  let polls = 0
  const outcome = await watchDevChannelsDialog('tg-alpha', 60_000, () => ++polls >= 3, { run: tmux.run, ...fakeTime(), onMiss: (p) => misses.push(p) })
  assert.equal(outcome.kind, 'done')
  assert.equal(misses.length, 0)
  assert.equal(enters(tmux.calls).length, 0)
})

test('a pane without any channel mention is not reported', async () => {
  const misses: string[][] = []
  const tmux = fakeTmux({ pane: 'Do you trust the files in this folder?' })
  await watchDevChannelsDialog('tg-alpha', 5_000, () => false, { run: tmux.run, ...fakeTime(), onMiss: (p) => misses.push(p) })
  assert.equal(misses.length, 0)
})

test('the watch returns done once the session registers, and gone when its tmux session disappears', async () => {
  const tmux = fakeTmux({ pane: DIALOG })
  let polls = 0
  const done = await watchDevChannelsDialog('tg-alpha', 60_000, () => ++polls >= 3, { run: tmux.run, ...fakeTime() })
  assert.deepEqual(done, { kind: 'done' })

  const vanished = fakeTmux({ pane: '$ claude starting', gone: true })
  const gone = await watchDevChannelsDialog('tg-alpha', 60_000, () => false, { run: vanished.run, ...fakeTime() })
  assert.deepEqual(gone, { kind: 'gone', pane: [] })
})

test('a session that vanishes after a capture reports the last pane it showed', async () => {
  let n = 0
  const calls: string[][] = []
  const run: TmuxRun = async (cmd, args) => {
    calls.push([cmd, ...args])
    if (args[0] !== 'capture-pane') return { code: 0, stdout: '', stderr: '' }
    n++
    if (n === 1) return { code: 0, stdout: 'Thinking about the plan\n', stderr: '' }
    return { code: 1, stdout: '', stderr: 'gone' }
  }
  const out = await watchDevChannelsDialog('tg-alpha', 60_000, () => false, { run, ...fakeTime() })
  assert.deepEqual(out, { kind: 'gone', pane: ['Thinking about the plan'] })
})

test('the startup watch passes a miss to the caller through the adapter (claude-code watchStartup shape)', async () => {
  const misses: string[][] = []
  const tmux = fakeTmux({ pane: 'development channels are loading\nstill starting' })
  await watchDevChannelsDialog('tg-alpha', 5_000, () => false, { run: tmux.run, ...fakeTime(), onMiss: (p) => misses.push(p) })
  assert.equal(misses.length, 1)
  assert.equal(enters(tmux.calls).length, 0)
})
