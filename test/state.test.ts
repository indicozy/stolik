import './helpers/isolate.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  assignName, Registry, MsgMap, loadMsgMap, resolveMsgRef, routeInbound, shouldDeliverReply,
  stopForwardText, notificationText, markPrompt, markStop, markInbound, markSent,
  isOwnerUser, verdictLabel, hasDeliverableBody, SPAWN_FLUSH_DELAY_MS,
  evaluateAway, permissionVerdict, parseCallbackData, chunkText, formatForSession, formatList,
  formatIdle, expandedPermissionText, permissionPromptText, PERMISSION_DESC_LIMIT, PERMISSION_INPUT_LIMIT,
  PERMISSION_INPUT_MORE, redact, fileAllowed, isInsideDir, RateLimiter, sanitizeFileName,
  isImagePath, hasTrustAccepted, isDevChannelsDialog, MINUTE, STOP_MIN_TURN_MS, PROACTIVE_GAP_MS, TG_TEXT_LIMIT, AWAY_IDLE_MS,
  TG_PERMISSION_EXPAND_LIMIT, PERMISSION_REDACTED_NOTE, PERMISSION_REDACTED_REFUSAL,
  permissionRedacted, permissionRefusal, permissionButtons,
  approvalReminderDue, approvalReminderText, APPROVAL_EXPIRED_TEXT, PERMISSION_TTL_MS,
  newSession, ROUTE_PENDING_TTL_MS,
  isInteractiveClaude, detachedSession, parseProjectRef, resolveProject, trustedDirs, startableFolders,
  askOrder, routeRows, folderPageRows, idleRows, folderLabels, launchRows, parseRouteCallback, pushHistory, displayFolder,
  findImagePaths, AUTO_IMAGE_MAX, shouldAnnounceBoot, bootAnnouncementText, BOOT_ANNOUNCE_RETRY_MS,
  plainTarget, activeSessions, ACTIVE_WINDOW_MS, ROUTE_MODES, NEW_LABEL,
  HISTORY_LEN, HISTORY_CHARS, type Session, type RouteCtx, type ProjectResolution,
} from '../src/router/state.ts'
import { OutboundLedger, outboundKeys } from '../src/router/outbound.ts'
import { tgMsg, tgUser } from '../src/adapters/chat/tg-ids.ts'

const T0 = 1_000_000_000_000
const HOME = '/home/u'

function sess(over: Partial<Session> = {}): Session {
  return {
    key: 1, name: 'proj', project: 'proj', cwd: '/home/u/Documents/projects/proj', pid: 1, start: 's1',
    hasChannel: true, connected: true, spawned: false, lastActive: T0, turnStart: T0, inTurn: false,
    outbound: new OutboundLedger(), lastSentAt: 0, lastProactiveAt: 0, waiting: false, history: [], backendSessionId: null, pendingTg: null, ...over,
  }
}

function ctx(over: Partial<RouteCtx> = {}): RouteCtx {
  return { live: [], replyTo: null, attachment: false, forwarded: false, resolveProject: () => ({ status: 'none' }), ...over }
}

test('assignName uses the project name, then #2, #3, reusing the lowest free number', () => {
  assert.equal(assignName('foo', new Set()), 'foo')
  assert.equal(assignName('foo', new Set(['foo'])), 'foo#2')
  assert.equal(assignName('foo', new Set(['foo', 'foo#2'])), 'foo#3')
  assert.equal(assignName('foo', new Set(['foo', 'foo#3'])), 'foo#2')
})

const P = (pid: number) => ({ pid, start: `s${pid}` })

test('Registry names duplicate projects #2 and #3 and reuses a freed number', () => {
  const r = new Registry()
  const a = r.registerChannel(P(100), '/x/foo', T0)
  const b = r.registerChannel(P(101), '/y/foo', T0)
  const c = r.registerChannel(P(102), '/z/foo', T0)
  assert.deepEqual([a.name, b.name, c.name], ['foo', 'foo#2', 'foo#3'])
  r.sweep(T0, (pid) => pid !== 101)
  const d = r.registerChannel(P(103), '/w/foo', T0)
  assert.equal(d.name, 'foo#2')
})

test('Registry adopts a pid-less hook session when its pid shows up, keeping its name', () => {
  const r = new Registry()
  const h = r.upsertFromHook(null, '/x/foo', T0)
  assert.equal(h.key, 'cwd:/x/foo')
  assert.equal(h.hasChannel, false)
  const ch = r.registerChannel(P(200), '/x/foo', T0 + 1)
  assert.equal(ch, h)
  assert.equal(ch.key, 'cwd:/x/foo', 'a adopted session keeps its key')
  assert.equal(ch.pid, 200)
  assert.equal(ch.name, 'foo')
  assert.equal(ch.hasChannel, true)
  assert.equal(r.list().length, 1)
})

test('Registry sweep drops dead-pid sessions and pid-less sessions only after TTL without a channel', () => {
  const r = new Registry()
  r.registerChannel(P(300), '/a/one', T0)
  r.upsertFromHook(null, '/a/two', T0)
  const later = T0 + 3 * 60 * MINUTE
  const removed = r.sweep(later, () => false)
  assert.deepEqual(removed.map((s) => s.name).sort(), ['one', 'two'])
  assert.equal(r.list().length, 0)
})

test('Registry keeps a pid-less session that is still connected', () => {
  const r = new Registry()
  const s = r.registerChannel(null, '/a/c', T0)
  assert.equal(s.connected, true)
  assert.equal(r.sweep(T0 + 3 * 60 * MINUTE, () => true).length, 0)
})

test('MsgMap caps at the newest entries and survives a round trip', () => {
  const m = new MsgMap(3)
  for (let i = 1; i <= 5; i++) m.record(tgMsg(i), { key: `${i}:s`, name: `n${i}`, cwd: '/c' })
  assert.equal(m.size(), 3)
  assert.equal(m.get(tgMsg(1)), undefined)
  assert.equal(m.get(tgMsg(5))?.name, 'n5')
  const back = loadMsgMap(m.serialize(), 3)
  assert.equal(back.get(tgMsg(4))?.name, 'n4')
  assert.equal(loadMsgMap('not json').size(), 0)
  assert.equal(loadMsgMap('[[1,{"key":true}]]').size(), 0)
})

test('resolveMsgRef finds a live session by key, falls back to name+cwd, else dead', () => {
  const live = [sess({ key: 500, name: 'proj', cwd: '/c' })]
  const byKey = resolveMsgRef({ key: 500, name: 'proj', cwd: '/c' }, live)
  assert.equal(byKey?.status, 'live')
  const byName = resolveMsgRef({ key: 9, name: 'proj', cwd: '/c' }, live)
  assert.equal(byName?.status, 'live')
  const dead = resolveMsgRef({ key: 9, name: 'gone', cwd: '/c' }, live)
  assert.deepEqual(dead, { status: 'dead', name: 'gone' })
  assert.equal(resolveMsgRef(undefined, live), null)
})

test('routeInbound: reply to a live session routes to it; dead reply says so', () => {
  const s = sess({ name: 'alpha' })
  const r1 = routeInbound('hi', T0, ctx({ live: [s], replyTo: { status: 'live', session: s } }))
  assert.deepEqual(r1, { type: 'session', session: s, content: 'hi' })
  const r2 = routeInbound('hi', T0, ctx({ live: [s], replyTo: { status: 'dead', name: 'beta' } }))
  assert.equal(r2.type, 'error')
  assert.match((r2 as { text: string }).text, /^\[beta\] is no longer running\. Live: alpha\./)
})

test('routeInbound: /to by exact name, then by project (most recently active), then spawn, then error', () => {
  const older = sess({ key: 1, name: 'app#2', project: 'app', lastActive: T0 })
  const fresh = sess({ key: 2, name: 'app#3', project: 'app', lastActive: T0 + 10 })
  const live = [older, fresh]
  const exact = routeInbound('/to app#2 do it', T0, ctx({ live }))
  assert.deepEqual(exact, { type: 'session', session: older, content: 'do it' })
  const proj = routeInbound('/to app go', T0, ctx({ live }))
  assert.equal((proj as { session: Session }).session, fresh)
  const named = routeInbound('/to app#2 x', T0, ctx({ live: [sess({ name: 'app', project: 'app' }), older] }))
  assert.equal((named as { session: Session }).session, older)
  const onlyNew = (r: string): ProjectResolution =>
    r === 'newproj' ? { status: 'found', name: 'newproj', dir: '/p/newproj' } : { status: 'none' }
  const spawn = routeInbound('/to newproj hello there', T0, ctx({ live, resolveProject: onlyNew }))
  assert.deepEqual(spawn, { type: 'spawn', project: 'newproj', dir: '/p/newproj', content: 'hello there' })
  const spawnEmpty = routeInbound('/to newproj', T0, ctx({ live, resolveProject: onlyNew }))
  assert.deepEqual(spawnEmpty, { type: 'spawn', project: 'newproj', dir: '/p/newproj', content: '' })
  const none = routeInbound('/to nothing hi', T0, ctx({ live }))
  assert.equal(none.type, 'error')
  assert.match((none as { text: string }).text, /No session or project named "nothing"/)
})

test('routeInbound: /to to an existing session without content is a usage error', () => {
  const s = sess({ name: 'alpha' })
  const r = routeInbound('/to alpha', T0, ctx({ live: [s] }))
  assert.equal(r.type, 'error')
  assert.match((r as { text: string }).text, /^Usage: \/to/)
  const media = routeInbound('/to alpha', T0, ctx({ live: [s], attachment: true }))
  assert.deepEqual(media, { type: 'session', session: s, content: '' })
})

test('routeInbound: a session without a channel cannot receive replies', () => {
  const s = sess({ name: 'quiet', hasChannel: false })
  const r = routeInbound('hi', T0, ctx({ live: [s], replyTo: { status: 'live', session: s } }))
  assert.equal(r.type, 'error')
  assert.match((r as { text: string }).text, /can't receive replies/)
})

test('routeInbound: commands, including /lock; attachments and forwards do not run commands', () => {
  assert.deepEqual(routeInbound('/list', T0, ctx()), { type: 'command', cmd: 'list', arg: '' })
  assert.deepEqual(routeInbound('/lock', T0, ctx()), { type: 'command', cmd: 'lock', arg: '' })
  assert.deepEqual(routeInbound('/away@mybot', T0, ctx()), { type: 'command', cmd: 'away', arg: '' })
  const s = sess({ name: 'alpha', lastSentAt: T0 })
  const media = routeInbound('/lock', T0, ctx({ live: [s], attachment: true, replyTo: { status: 'live', session: s } }))
  assert.deepEqual(media, { type: 'session', session: s, content: '/lock' })
  const fwd = routeInbound('/to newproj x', T0, ctx({ live: [s], forwarded: true, resolveProject: () => ({ status: 'found', name: 'newproj', dir: '/p/newproj' }) }))
  assert.deepEqual(fwd, { type: 'general', candidates: [s], content: '/to newproj x' }, 'a forwarded /to is plain text')
})

test('routeInbound: a plain message is a general route; the candidates are the sessions with a channel', () => {
  assert.deepEqual(routeInbound('yo', T0, ctx()), { type: 'general', candidates: [], content: 'yo' })
  const a = sess({ key: 1, name: 'a', lastSentAt: T0 - 60 * MINUTE })
  const quiet = sess({ key: 3, name: 'quiet', hasChannel: false })
  assert.deepEqual(routeInbound('  how is it?  ', T0, ctx({ live: [a, quiet] })), {
    type: 'general', candidates: [a], content: 'how is it?',
  })
})

test('routeInbound: a media caption is a general route too (the caption is the content)', () => {
  const a = sess({ key: 1, name: 'a' })
  assert.deepEqual(routeInbound('', T0, ctx({ live: [a], attachment: true })), { type: 'general', candidates: [a], content: '' })
})

// ---------- plain messages: the 30-minute rule, the buttons, the callbacks ----------

// A session whose last activity was `min` minutes and `sec` seconds before T0.
function agoBy(min: number, sec: number, over: Partial<Session> = {}): Session {
  return sess({ name: 'x', lastActive: T0 - (min * 60 + sec) * 1000, ...over })
}

test('ACTIVE_WINDOW_MS: 30 minutes', () => {
  assert.equal(ACTIVE_WINDOW_MS, 30 * MINUTE)
})

test('plainTarget: the one session active in the last 30 minutes, with the boundary at 29:59, 30:00 and 30:01', () => {
  const a29 = agoBy(29, 59)
  const a30 = agoBy(30, 0)
  const a301 = agoBy(30, 1)
  assert.equal(plainTarget([a29], T0), a29, '29:59 is active')
  assert.equal(plainTarget([a30], T0), a30, '30:00 is still active')
  assert.equal(plainTarget([a301], T0), null, '30:01 is not')
  assert.deepEqual(activeSessions([a29, a30, a301], T0), [a29, a30])
})

test('plainTarget: zero, one and many sessions', () => {
  assert.equal(plainTarget([], T0), null, 'zero sessions: buttons')
  const quietOne = agoBy(40, 0)
  assert.equal(plainTarget([quietOne], T0), null, 'one session that is not active: buttons')
  const x = agoBy(1, 0, { key: 1, name: 'x' })
  const y = agoBy(2, 0, { key: 2, name: 'y' })
  assert.equal(plainTarget([x, y], T0), null, 'two active sessions: buttons')
  assert.equal(plainTarget([x, quietOne], T0), x, 'one active among several: that one')
})

test('plainTarget: outbound activity counts as activity (lastSentAt), the later of the two', () => {
  const sentRecently = agoBy(40, 0, { lastSentAt: T0 - 10 * MINUTE })
  assert.equal(plainTarget([sentRecently], T0), sentRecently)
  const inboundRecently = agoBy(40, 0, { lastSentAt: T0 - 50 * MINUTE })
  assert.equal(plainTarget([inboundRecently], T0), null)
})

test('askOrder: the most recently active session first, by the later of lastActive and lastSentAt', () => {
  const a = sess({ key: 1, name: 'a', lastActive: T0 })
  const b = sess({ key: 2, name: 'b', lastActive: T0 + 5 })
  const c = sess({ key: 3, name: 'c', lastActive: T0 + 1, lastSentAt: T0 + 20 })
  assert.deepEqual(askOrder([a, b, c]).map((s) => s.name), ['c', 'b', 'a'])
})

test('routeRows: one button per session (index into the order), New, then quick, read and web', () => {
  const ordered = [sess({ key: 1, name: 's1' }), sess({ key: 2, name: 'w', waiting: true })]
  assert.deepEqual(routeRows('0a1b2c3d', ordered), [
    [{ text: 's1', data: 'rt:s:0a1b2c3d:0' }],
    [{ text: 'w ⏳', data: 'rt:s:0a1b2c3d:1' }],
    [{ text: NEW_LABEL, data: 'rt:n:0a1b2c3d' }],
    [
      { text: 'quick', data: 'rt:m:0a1b2c3d:quick' },
      { text: 'read', data: 'rt:m:0a1b2c3d:read' },
      { text: 'web', data: 'rt:m:0a1b2c3d:web' },
    ],
  ])
  // No session at all: New and the modes still show.
  assert.equal(routeRows('0a1b2c3d', []).length, 2)
  assert.deepEqual(ROUTE_MODES, ['quick', 'read', 'web'])
})

test('folderPageRows: one row per folder on the page (＋ and 👁), the index is the whole-list index, ◀ ▶ between pages', () => {
  const dirs = Array.from({ length: 10 }, (_, i) => `/home/u/p${i}`)
  const labels = folderLabels(dirs)
  const first = folderPageRows('0a1b2c3d', dirs, 0, labels)
  assert.equal(first.length, 9, '8 folders and the nav row')
  assert.deepEqual(first[0], [{ text: '＋ p0', data: 'rt:f:0a1b2c3d:0' }, { text: '👁', data: 'rt:r:0a1b2c3d:0' }])
  assert.deepEqual(first[7], [{ text: '＋ p7', data: 'rt:f:0a1b2c3d:7' }, { text: '👁', data: 'rt:r:0a1b2c3d:7' }])
  assert.deepEqual(first[8], [{ text: '▶', data: 'rt:p:0a1b2c3d:1' }], 'no ◀ on the first page')
  const last = folderPageRows('0a1b2c3d', dirs, 1, labels)
  assert.deepEqual(last[0], [{ text: '＋ p8', data: 'rt:f:0a1b2c3d:8' }, { text: '👁', data: 'rt:r:0a1b2c3d:8' }])
  assert.deepEqual(last[2], [{ text: '◀', data: 'rt:p:0a1b2c3d:0' }], 'no ▶ on the last page')
  assert.deepEqual(folderPageRows('0a1b2c3d', dirs, 99, labels)[0][0].data, 'rt:f:0a1b2c3d:8', 'a page past the end is the last one')
  for (const row of [...first, ...last]) for (const b of row) assert.ok(Buffer.byteLength(b.data) <= 64, b.data)
})

test('launchRows: Read-only and Full (the new-prefix question)', () => {
  assert.deepEqual(launchRows('0a1b2c3d'), [[
    { text: 'Read-only', data: 'rt:l:0a1b2c3d:ro' },
    { text: 'Full', data: 'rt:l:0a1b2c3d:full' },
  ]])
})

test('folderLabels: the basename, and parent/basename where two folders share one', () => {
  const labels = folderLabels(['/home/u/bikerepair/sales', '/home/u/shop/sales', '/home/u/razdor'])
  assert.equal(labels.get('/home/u/bikerepair/sales'), 'bikerepair/sales')
  assert.equal(labels.get('/home/u/shop/sales'), 'shop/sales')
  assert.equal(labels.get('/home/u/razdor'), 'razdor')
})

test('idleRows: New… and the modes, nothing else', () => {
  assert.deepEqual(idleRows('0a1b2c3d'), [
    [{ text: 'New…', data: 'rt:n:0a1b2c3d' }],
    [{ text: 'quick', data: 'rt:m:0a1b2c3d:quick' }, { text: 'read', data: 'rt:m:0a1b2c3d:read' }, { text: 'web', data: 'rt:m:0a1b2c3d:web' }],
  ])
})

test('parseRouteCallback: the forms of the buttons, and nothing else', () => {
  assert.deepEqual(parseRouteCallback('rt:w:0a1b2c3d'), { kind: 'w', pendingId: '0a1b2c3d' })
  assert.deepEqual(parseRouteCallback('rt:n:0a1b2c3d'), { kind: 'n', pendingId: '0a1b2c3d' })
  assert.deepEqual(parseRouteCallback('rt:s:0a1b2c3d:2'), { kind: 's', pendingId: '0a1b2c3d', idx: 2 })
  assert.deepEqual(parseRouteCallback('rt:f:0a1b2c3d:0'), { kind: 'f', pendingId: '0a1b2c3d', idx: 0 })
  assert.deepEqual(parseRouteCallback('rt:r:0a1b2c3d:12'), { kind: 'r', pendingId: '0a1b2c3d', idx: 12 })
  assert.deepEqual(parseRouteCallback('rt:p:0a1b2c3d:3'), { kind: 'p', pendingId: '0a1b2c3d', page: 3 })
  assert.deepEqual(parseRouteCallback('rt:m:0a1b2c3d:web'), { kind: 'm', pendingId: '0a1b2c3d', mode: 'web' })
  assert.deepEqual(parseRouteCallback('rt:l:0a1b2c3d:ro'), { kind: 'l', pendingId: '0a1b2c3d', readOnly: true })
  assert.deepEqual(parseRouteCallback('rt:l:0a1b2c3d:full'), { kind: 'l', pendingId: '0a1b2c3d', readOnly: false })
  for (const bad of ['rt:s:XYZ:1', 'rt:x:0a1b2c3d', 'perm:allow:abcde', 'rt:s:0a1b2c3d:1000', 'rt:p:0a1b2c3d', 'rt:w:0a1b2c3d:1', '', 'rt:m:0a1b2c3d:btw', 'rt:l:0a1b2c3d:x']) {
    assert.equal(parseRouteCallback(bad), null, bad)
  }
})

test('pushHistory keeps the last HISTORY_LEN messages, oldest first', () => {
  const s = sess()
  for (let i = 1; i <= HISTORY_LEN + 2; i++) pushHistory(s, i % 2 ? 'user' : 'agent', `msg ${i}`, [])
  assert.equal(s.history.length, HISTORY_LEN)
  assert.equal(s.history[0].text, 'msg 3')
  assert.equal(s.history[HISTORY_LEN - 1].text, `msg ${HISTORY_LEN + 2}`)
  pushHistory(s, 'user', '   ', [])
  assert.equal(s.history.length, HISTORY_LEN, 'blank text is not stored')
})

test('pushHistory redacts before it truncates: a secret straddling the limit does not leak', () => {
  const s = sess()
  const secret = 'SUPERSECRETTOKEN123'
  pushHistory(s, 'agent', 'x'.repeat(HISTORY_CHARS - 5) + secret + ' tail', [secret])
  const text = s.history[0].text
  assert.ok(text.length <= HISTORY_CHARS, `length ${text.length}`)
  assert.ok(!text.includes('SUPER'), 'no part of the secret survives')
  assert.ok(text.endsWith('…'))
})

test('displayFolder: home shown as ~, a sibling with the same prefix is not inside home', () => {
  assert.equal(displayFolder('/home/u', HOME), '~')
  assert.equal(displayFolder('/home/u/Documents/projects/proga/cat-garden', HOME), '~/Documents/projects/proga/cat-garden')
  assert.equal(displayFolder('/home/uu/x', HOME), '/home/uu/x', 'a sibling with the same prefix is not inside home')
  assert.equal(displayFolder('/srv/app', HOME), '/srv/app')
})

test('shouldDeliverReply: response and requested always; proactive only when away and rate limit passed', () => {
  const s = sess({ lastProactiveAt: 0 })
  assert.equal(shouldDeliverReply('response', s, false, T0), true)
  assert.equal(shouldDeliverReply('requested', s, false, T0), true)
  assert.equal(shouldDeliverReply('proactive', s, false, T0), false)
  assert.equal(shouldDeliverReply('proactive', s, true, T0), true)
  const recent = sess({ lastProactiveAt: T0 })
  assert.equal(shouldDeliverReply('proactive', recent, true, T0 + PROACTIVE_GAP_MS - 1), false)
  assert.equal(shouldDeliverReply('proactive', recent, true, T0 + PROACTIVE_GAP_MS), true)
})

test('shouldDeliverReply: a critical proactive reply is delivered at the desk and inside the gap; silent and default are not', () => {
  const s = sess({ lastProactiveAt: T0 })
  assert.equal(shouldDeliverReply('proactive', s, false, T0, 'critical'), true, 'at the desk')
  assert.equal(shouldDeliverReply('proactive', s, false, T0 + 1, 'critical'), true, 'inside the proactive gap')
  assert.equal(shouldDeliverReply('proactive', s, false, T0, 'default'), false, 'default proactive still dropped at the desk')
  assert.equal(shouldDeliverReply('proactive', s, false, T0, 'silent'), false, 'silent proactive still dropped at the desk')
  assert.equal(shouldDeliverReply('response', s, false, T0, 'critical'), true)
})

test('stopForwardText: rules for stop_hook_active, presence, replies, turn length and question marks', async () => {
  const fresh = sess({ turnStart: T0 })
  const longAgo = T0 + STOP_MIN_TURN_MS
  assert.equal(stopForwardText(fresh, { stop_hook_active: true, last_assistant_message: 'x?' }, true, longAgo), null)
  assert.equal(stopForwardText(fresh, { last_assistant_message: 'done.' }, false, longAgo), null)
  const replied = sess({ turnStart: T0 })
  await replied.outbound.send({ keys: outboundKeys('response', 'sent already', []), source: 'reply', parts: [{ kind: 'text', value: 'sent already' }], now: T0, deliver: async () => 7 })
  assert.equal(stopForwardText(replied, { last_assistant_message: 'done.' }, true, longAgo), null)
  assert.equal(stopForwardText(fresh, { last_assistant_message: '   ' }, true, longAgo), null)
  assert.equal(stopForwardText(fresh, { last_assistant_message: 'quick done.' }, true, T0 + 1000), null)
  assert.equal(stopForwardText(fresh, { last_assistant_message: 'quick, ok?  ' }, true, T0 + 1000), 'quick, ok?')
  assert.equal(stopForwardText(fresh, { last_assistant_message: 'long done.' }, true, longAgo), 'long done.')
})

test('notificationText: permission prompts only without a channel; waiting prompts rate limited', () => {
  const withCh = sess({ hasChannel: true })
  const noCh = sess({ hasChannel: false })
  const perm = { notification_type: 'permission_prompt', message: 'Allow rm?' }
  assert.equal(notificationText(withCh, perm, true, T0), null)
  assert.equal(notificationText(noCh, perm, true, T0), '🔐 Allow rm?')
  assert.equal(notificationText(noCh, perm, false, T0), null)
  const ask = { notification_type: 'elicitation_dialog', message: 'Waiting' }
  const justSent = sess({ lastSentAt: T0 })
  assert.equal(notificationText(justSent, ask, true, T0 + 9 * MINUTE), null)
  assert.equal(notificationText(justSent, ask, true, T0 + 11 * MINUTE), 'is waiting for you: Waiting')
  assert.equal(notificationText(justSent, { notification_type: 'idle_prompt', message: 'Waiting' }, true, T0 + 11 * MINUTE), null)
  assert.equal(notificationText(justSent, { notification_type: 'other' }, true, T0 + 11 * MINUTE), null)
})

test('state transitions follow the prompt / stop / inbound / reply rules', async () => {
  const s = sess({ waiting: true, inTurn: false })
  await s.outbound.send({ keys: outboundKeys('response', 'hi', []), source: 'reply', parts: [{ kind: 'text', value: 'hi' }], now: T0, deliver: async () => 1 })
  assert.equal(s.outbound.repliedThisTurn(T0), true)
  markPrompt(s, T0 + 100)
  assert.equal(s.turnStart, T0 + 100)
  assert.equal(s.outbound.repliedThisTurn(T0 + 100), false)
  assert.equal(s.waiting, false)
  assert.equal(s.inTurn, true)
  await s.outbound.send({ keys: outboundKeys('response', 'hi', []), source: 'reply', parts: [{ kind: 'text', value: 'hi' }], now: T0 + 150, deliver: async () => 2 })
  assert.equal(s.outbound.repliedThisTurn(T0 + 150), true)
  markStop(s, true, T0 + 200)
  assert.equal(s.outbound.repliedThisTurn(T0 + 200), true, 'a Stop keeps the turn ledger for the grace period')
  assert.equal(s.inTurn, false)
  assert.equal(s.waiting, true)
  markInbound(s, T0 + 300)
  assert.equal(s.waiting, false)
  assert.equal(s.turnStart, T0 + 300)
  markSent(s, 'proactive', T0 + 400)
  assert.equal(s.lastSentAt, T0 + 400)
  assert.equal(s.lastProactiveAt, T0 + 400)
})

test('evaluateAway: override, lock, idle threshold, and /here suppression until a keypress', () => {
  const base = { overrideAway: false, hereSetAt: null, idleMs: 0, locked: false }
  assert.equal(evaluateAway({ ...base, overrideAway: true }, T0).away, true)
  assert.equal(evaluateAway({ ...base, locked: true }, T0).away, true)
  assert.equal(evaluateAway({ ...base, idleMs: AWAY_IDLE_MS - 1 }, T0).away, false)
  assert.equal(evaluateAway({ ...base, idleMs: AWAY_IDLE_MS }, T0).away, true)
  // /here set at T0, idle 10 min (no keypress since): suppressed.
  const sup = evaluateAway({ ...base, hereSetAt: T0, idleMs: 10 * MINUTE }, T0)
  assert.deepEqual(sup, { away: false, hereSetAt: T0 })
  // Keypress 1 min after /here (idle 1 min < now - hereSetAt): suppression cleared, normal rules apply.
  const touched = evaluateAway({ ...base, hereSetAt: T0, idleMs: 1 * MINUTE }, T0 + 2 * MINUTE)
  assert.deepEqual(touched, { away: false, hereSetAt: null })
  const idleAgain = evaluateAway({ ...base, hereSetAt: T0, idleMs: 6 * MINUTE }, T0 + 7 * MINUTE)
  assert.deepEqual(idleAgain, { away: true, hereSetAt: null })
})

test('evaluateAway: unknown idle time (no X display) counts as away, /here does not hide it', () => {
  const base = { overrideAway: false, hereSetAt: null, idleMs: null, locked: false }
  assert.deepEqual(evaluateAway(base, T0), { away: true, hereSetAt: null })
  assert.deepEqual(evaluateAway({ ...base, hereSetAt: T0 }, T0 + MINUTE), { away: true, hereSetAt: T0 })
  // Override and lock are still reported as away without touching hereSetAt rules.
  assert.equal(evaluateAway({ ...base, overrideAway: true }, T0).away, true)
  assert.equal(evaluateAway({ ...base, locked: true }, T0).away, true)
  // Known idle time takes over again as soon as it is readable.
  assert.equal(evaluateAway({ ...base, idleMs: 0 }, T0).away, false)
})

test('permissionVerdict and parseCallbackData', () => {
  assert.deepEqual(permissionVerdict('yes abcde'), { requestId: 'abcde', behavior: 'allow' })
  assert.deepEqual(permissionVerdict('  N  abcdf '), { requestId: 'abcdf', behavior: 'deny' })
  assert.equal(permissionVerdict('yes'), null)
  assert.equal(permissionVerdict('yes abcdl'), null) // 'l' is excluded from request ids
  assert.deepEqual(parseCallbackData('perm:allow:abcde'), { behavior: 'allow', requestId: 'abcde' })
  assert.deepEqual(parseCallbackData('perm:more:abcde'), { behavior: 'more', requestId: 'abcde' })
  assert.equal(parseCallbackData('perm:allow:abcdl'), null)
  assert.equal(parseCallbackData('other'), null)
})

test('chunkText splits on newlines, hard-cuts otherwise, and never exceeds the limit', () => {
  assert.deepEqual(chunkText('abc', 10), ['abc'])
  assert.deepEqual(chunkText('aaaa\nbbbb\ncccc', 9), ['aaaa\nbbbb', 'cccc'])
  assert.deepEqual(chunkText('aaaa\nbbbb\ncccc', 5), ['aaaa', 'bbbb', 'cccc'])
  const long = 'x'.repeat(25)
  const hard = chunkText(long, 10)
  assert.equal(hard.join(''), long)
  assert.ok(hard.every((c) => c.length <= 10))
  const emoji = '😀'.repeat(5) // 10 UTF-16 units
  const cut = chunkText(emoji, 5)
  assert.equal(cut.join(''), emoji)
  assert.ok(cut.every((c) => c.length <= 5))
})

test('formatForSession prefixes every chunk and stays within the Telegram limit', () => {
  const text = 'y'.repeat(TG_TEXT_LIMIT * 2)
  const parts = formatForSession('proj#2', text)
  assert.ok(parts.length >= 2)
  assert.ok(parts.every((p) => p.startsWith('[proj#2] ') && p.length <= TG_TEXT_LIMIT))
  assert.equal(parts.map((p) => p.slice('[proj#2] '.length)).join(''), text)
  assert.deepEqual(formatForSession('a', 'hi'), ['[a] hi'])
})

test('formatIdle and formatList', () => {
  assert.equal(formatIdle(30_000), '<1m')
  assert.equal(formatIdle(3 * MINUTE), '3m')
  assert.equal(formatIdle(65 * MINUTE), '1h 5m')
  assert.equal(formatList([], T0), 'No live sessions.')
  const a = sess({ name: 'a', lastActive: T0 - 3 * MINUTE, waiting: true })
  const b = sess({ name: 'b', lastActive: T0 - MINUTE, hasChannel: false })
  assert.equal(formatList([a, b], T0), 'b — idle 1m — 🛠 working (no channel)\na — idle 3m — ⏳ waiting on you')
})

test('formatList: startable folders are grouped by parent folder, sorted, with duplicate names qualified', () => {
  const dirs = [
    `${H}/Documents/projects/stolik`,
    `${H}/Documents/projects/bikerepair`,
    `${H}/Documents/projects/razdor`,
    `${H}/Documents/projects/bikerepair/cyclesync`,
    `${H}/Documents/projects/bikerepair/generator`,
    `${H}/Downloads/git/telegram-delete-all-messages`,
  ]
  assert.equal(formatList([], T0, dirs, H), [
    'No live sessions.',
    '',
    'Can start with /to <name> <text>:',
    '~/Documents/projects: bikerepair, razdor, stolik',
    '~/Documents/projects/bikerepair: cyclesync, generator',
    '~/Downloads/git: telegram-delete-all-messages',
    'New folder? Run claude there once at the desk to trust it.',
  ].join('\n'))
  const live = [sess({ name: 'live1', lastActive: T0 - MINUTE })]
  assert.equal(formatList(live, T0, dirs, H).split('\n\n')[0], 'live1 — idle 1m — 🛠 working')
})

test('formatList: a basename shared by two startable folders is shown as parent/name, and each form resolves', () => {
  const dirs = [`${R1}/foo`, `${R2}/foo`, `${R1}/bar`]
  assert.equal(formatList([], T0, dirs, H), [
    'No live sessions.',
    '',
    'Can start with /to <name> <text>:',
    '~/Documents/projects: bar, projects/foo',
    '~/Documents/projects/proga: proga/foo',
    'New folder? Run claude there once at the desk to trust it.',
  ].join('\n'))
  assert.deepEqual(startableFolders(dirs).map((f) => f.ref), ['projects/foo', 'proga/foo', 'bar'])
  // Each qualified form the list shows resolves to its own folder.
  assert.deepEqual(resolveProject('projects/foo', dirs, H), { status: 'found', name: 'foo', dir: `${R1}/foo` })
  assert.deepEqual(resolveProject('proga/foo', dirs, H), { status: 'found', name: 'foo', dir: `${R2}/foo` })
})

test('formatList: an empty startable list leaves the output unchanged; names /to cannot take are left out', () => {
  const a = sess({ name: 'a', lastActive: T0 - MINUTE })
  assert.equal(formatList([a], T0, []), formatList([a], T0, [], H))
  assert.equal(formatList([a], T0, []), formatList([a], T0))
  assert.equal(formatList([], T0, []), 'No live sessions.')
  assert.equal(formatList([], T0, [`${H}/Documents/my project`], H), 'No live sessions.')
})

test('expandedPermissionText pretty-prints JSON and truncates to 3500 chars', () => {
  const t = expandedPermissionText({ tool_name: 'Bash', description: 'run', input_preview: '{"a":1}' })
  assert.match(t, /"a": 1/)
  const big = expandedPermissionText({ tool_name: 'Bash', description: 'd', input_preview: 'z'.repeat(10_000) })
  assert.ok(big.length <= 3501)
})

test('permissionPromptText shows pretty-printed JSON input under the description', () => {
  const t = permissionPromptText('proj', { tool_name: 'Bash', description: 'List files', input_preview: '{"command":"ls -la"}' })
  assert.equal(t, '🔐 [proj] Bash\nList files\n\ninput:\n{\n  "command": "ls -la"\n}')
})

test('permissionPromptText passes non-JSON input through unchanged', () => {
  const t = permissionPromptText('proj', { tool_name: 'Bash', description: 'd', input_preview: 'rm -rf build' })
  assert.equal(t, '🔐 [proj] Bash\nd\n\ninput:\nrm -rf build')
})

test('permissionPromptText truncates long input to 600 chars with the See more marker', () => {
  const obj = { content: 'x'.repeat(5_000) }
  const t = permissionPromptText('proj', { tool_name: 'Write', description: 'd', input_preview: JSON.stringify(obj) })
  const pretty = JSON.stringify(obj, null, 2)
  const input = t.slice(t.indexOf('input:\n') + 'input:\n'.length)
  assert.equal(input, pretty.slice(0, PERMISSION_INPUT_LIMIT) + PERMISSION_INPUT_MORE)
  assert.equal(PERMISSION_INPUT_MORE, '… (truncated, tap See more)')
})

test('permissionPromptText does not add the marker when input fits in 600 chars', () => {
  const short = JSON.stringify({ path: 'a.txt' })
  const t = permissionPromptText('proj', { tool_name: 'Read', description: 'd', input_preview: short })
  assert.ok(!t.includes('truncated'))
})

test('permissionPromptText truncates the description to 300 chars', () => {
  const desc = 'a'.repeat(1_000)
  const t = permissionPromptText('proj', { tool_name: 'Bash', description: desc, input_preview: '{}' })
  const line = t.split('\n')[1]
  assert.equal(line, 'a'.repeat(PERMISSION_DESC_LIMIT) + '…')
  const short = permissionPromptText('proj', { tool_name: 'Bash', description: 'short', input_preview: '{}' })
  assert.equal(short.split('\n')[1], 'short')
})

test('permissionPromptText never splits a surrogate pair at the cut', () => {
  const desc = 'a'.repeat(PERMISSION_DESC_LIMIT - 1) + '😀' // emoji is 2 UTF-16 units; cut would land mid-pair
  const t = permissionPromptText('proj', { tool_name: 'Bash', description: desc, input_preview: '{}' })
  const line = t.split('\n')[1]
  assert.equal(line, 'a'.repeat(PERMISSION_DESC_LIMIT - 1) + '…')
})

test('redact replaces literal tokens and secret-shaped strings', () => {
  const token = '123456789:AAHabcdefghijklmnopqrstuvwxyz12345'
  assert.equal(redact(`token is ${token} ok`, [token]), 'token is [REDACTED] ok')
  assert.equal(redact('key 987654321:' + 'A'.repeat(35), []), 'key [REDACTED]')
  assert.equal(redact('sk-abcdefghijklmnopqrstuvwxyz', []), '[REDACTED]')
  assert.equal(redact('ghp_' + 'a'.repeat(36), []), '[REDACTED]')
  assert.equal(redact('AKIA' + 'A'.repeat(16), []), '[REDACTED]')
  assert.equal(redact('xoxb-1234567890-abcdef', []), '[REDACTED]')
  const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----'
  assert.equal(redact(`before ${pem} after`, []), 'before [REDACTED] after')
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWJqZWN0IjoxfQ.abcdefghijk_-'
  assert.equal(redact(`jwt ${jwt}`, []), 'jwt [REDACTED]')
  assert.equal(redact('plain text 12', ['short']), 'plain text 12')
})

test('redact covers an unterminated PEM block through the end of the text', () => {
  assert.equal(redact('x -----BEGIN RSA PRIVATE KEY-----\nMIIabcdef', []), 'x [REDACTED]')
  assert.equal(redact('-----BEGIN PRIVATE KEY-----', []), '[REDACTED]')
})

test('permissionPromptText redacts a PEM key longer than the input limit before cutting it', () => {
  const pem = '-----BEGIN RSA PRIVATE KEY-----\n' + 'M'.repeat(1_500) + '\n-----END RSA PRIVATE KEY-----'
  const t = permissionPromptText('proj', { tool_name: 'Write', description: 'd', input_preview: JSON.stringify({ content: pem }) })
  assert.ok(!t.includes('MMMM'))
  assert.ok(!t.includes('BEGIN'))
  assert.ok(t.includes('[REDACTED]'))
  // Non-JSON input (raw PEM with real newlines) takes the same path.
  const raw = permissionPromptText('proj', { tool_name: 'Bash', description: 'd', input_preview: pem })
  assert.ok(!raw.includes('MMMM'))
})

test('permissionPromptText cut before the END line still leaks nothing when the key is unterminated', () => {
  const cut = '-----BEGIN OPENSSH PRIVATE KEY-----\n' + 'Q'.repeat(700)
  const t = permissionPromptText('proj', { tool_name: 'Write', description: 'd', input_preview: JSON.stringify({ content: cut }) })
  assert.ok(!t.includes('QQQQ'))
})

test('expandedPermissionText redacts a PEM key longer than the expand limit before cutting it', () => {
  const pem = '-----BEGIN RSA PRIVATE KEY-----\n' + 'M'.repeat(4_000) + '\n-----END RSA PRIVATE KEY-----'
  const t = expandedPermissionText({ tool_name: 'Write', description: 'd', input_preview: JSON.stringify({ content: pem }) })
  assert.ok(!t.includes('MMMM'))
  assert.ok(!t.includes('BEGIN'))
  assert.ok(t.includes('[REDACTED]'))
})

test('a token sitting across the permission input truncation boundary is redacted', () => {
  const token = 'ghp_' + 'a'.repeat(36)
  // The token starts at offset 590, so a 600-unit cut would leave "ghp_aaaaaa" behind.
  const input = 'x'.repeat(589) + ' ' + token
  const t = permissionPromptText('proj', { tool_name: 'Bash', description: 'd', input_preview: input })
  assert.ok(!t.includes('ghp_'))
  assert.ok(!t.includes('aaaa'))
  assert.ok(t.endsWith('[REDACTED]'))
})

test('a literal secret across the description truncation boundary is redacted', () => {
  const secret = 'my-secret-value-123'
  // Raw description is 310 units, so the old cut at 300 would leave "my-secret-v" in view.
  const desc = 'y'.repeat(290) + ' ' + secret
  const t = permissionPromptText('proj', { tool_name: 'Bash', description: desc, input_preview: '{}' }, [secret])
  assert.ok(!t.includes('my-secret'))
  // Redacted it is 301 units; the 300-unit cut lands inside the marker and gets the ellipsis.
  assert.equal(t.split('\n')[1], 'y'.repeat(290) + ' [REDACTED…')
})

test('formatForSession redacts a token before chunking so it cannot split across chunks', () => {
  const token = 'ghp_' + 'a'.repeat(36)
  const text = 'x'.repeat(TG_TEXT_LIMIT - 10) + ' ' + token
  const parts = formatForSession('proj', text)
  assert.ok(parts.every((p) => p.length <= TG_TEXT_LIMIT))
  const body = parts.map((p) => p.slice('[proj] '.length)).join('')
  assert.ok(!body.includes('aaaa'))
  assert.equal(body, 'x'.repeat(TG_TEXT_LIMIT - 10) + ' [REDACTED]')
})

test('fileAllowed refuses credential dirs, exact credential files and secret-looking names', () => {
  assert.equal(fileAllowed(`${HOME}/Documents/x.png`, HOME).ok, true)
  assert.equal(fileAllowed(`${HOME}/.ssh/id_ed25519`, HOME).ok, false)
  assert.equal(fileAllowed(`${HOME}/.aws/credentials`, HOME).ok, false)
  assert.equal(fileAllowed(`${HOME}/.config/gcloud/x.json`, HOME).ok, false)
  assert.equal(fileAllowed(`${HOME}/.claude.json`, HOME).ok, false)
  assert.equal(fileAllowed(`${HOME}/.claude/.credentials.json`, HOME).ok, false)
  assert.equal(fileAllowed(`${HOME}/.claude/settings.json`, HOME).ok, true)
  assert.equal(fileAllowed(`${HOME}/proj/.env.local`, HOME).ok, false)
  assert.equal(fileAllowed(`${HOME}/proj/server.pem`, HOME).ok, false)
  assert.equal(fileAllowed(`${HOME}/proj/a.KEY`, HOME).ok, false)
  assert.equal(fileAllowed(`${HOME}/proj/id_rsa.pub`, HOME).ok, false)
  assert.equal(fileAllowed(`${HOME}/.config/stolik.env`, HOME).ok, false)
  assert.equal(fileAllowed(`${HOME}/.config/telegram-notify.env`, HOME).ok, false)
  assert.equal(fileAllowed(`${HOME}/.sshx/file.txt`, HOME).ok, true)
})

test('isInsideDir requires a path boundary', () => {
  assert.equal(isInsideDir('/p/a/b', '/p/a'), true)
  assert.equal(isInsideDir('/p/a', '/p/a'), true)
  assert.equal(isInsideDir('/p/ab', '/p/a'), false)
  assert.equal(isInsideDir('/p/a/b', '/p/a/'), true)
})

test('RateLimiter allows 3 per window, notifies once on the first drop, then resets', () => {
  const rl = new RateLimiter(3, 1000)
  assert.equal(rl.check(0), 'ok')
  assert.equal(rl.check(1), 'ok')
  assert.equal(rl.check(2), 'ok')
  assert.equal(rl.check(3), 'drop-notify')
  assert.equal(rl.check(4), 'drop')
  assert.equal(rl.check(1500), 'ok')
})

test('sanitizeFileName and isImagePath', () => {
  assert.equal(sanitizeFileName('a/b;c<d>.txt'), 'b_c_d_.txt')
  assert.equal(sanitizeFileName('../../etc/passwd'), 'passwd')
  assert.equal(sanitizeFileName('.hidden'), '_hidden')
  assert.equal(sanitizeFileName(''), 'file')
  assert.equal(isImagePath('/x/A.JPG'), true)
  assert.equal(isImagePath('/x/a.pdf'), false)
})

test('hasTrustAccepted only passes for an exact realpath with hasTrustDialogAccepted === true', () => {
  const dir = '/home/u/Documents/projects/proj'
  const ok = { projects: { [dir]: { hasTrustDialogAccepted: true } } }
  assert.equal(hasTrustAccepted(ok, dir), true)
  assert.equal(hasTrustAccepted({ projects: { [dir]: { hasTrustDialogAccepted: false } } }, dir), false)
  assert.equal(hasTrustAccepted({ projects: { [dir]: { hasTrustDialogAccepted: 'true' } } }, dir), false)
  assert.equal(hasTrustAccepted({ projects: { [dir]: {} } }, dir), false)
  assert.equal(hasTrustAccepted({ projects: { [dir + '/sub']: { hasTrustDialogAccepted: true } } }, dir), false)
  assert.equal(hasTrustAccepted({ projects: { '/home/u': { hasTrustDialogAccepted: true } } }, dir), false)
  assert.equal(hasTrustAccepted({}, dir), false)
  assert.equal(hasTrustAccepted({ projects: null }, dir), false)
  assert.equal(hasTrustAccepted(null, dir), false)
  assert.equal(hasTrustAccepted('x', dir), false)
})

test('isDevChannelsDialog matches only the development-channels confirmation, not folder trust', () => {
  const dev = 'Loading development channels\n  Local development\n  ❯ 1. I am using this for local development\n    2. Exit'
  assert.equal(isDevChannelsDialog(dev), true)
  assert.equal(isDevChannelsDialog('Do you trust the files in this folder?\n❯ 1. Yes, proceed'), false)
  assert.equal(isDevChannelsDialog('Quick safety check: Is this a project you trust? local development'), false)
  assert.equal(isDevChannelsDialog('Local development notes, no option list'), false)
})

test('permissionRedacted is false for clean input and true when redaction changes the description or input', () => {
  const clean = { tool_name: 'Bash', description: 'list', input_preview: '{"command":"ls"}' }
  assert.equal(permissionRedacted(clean, []), false)
  const pem = '-----BEGIN PRIVATE KEY-----\nMIIE'
  assert.equal(permissionRedacted({ tool_name: 'Bash', description: pem, input_preview: '{}' }, []), true)
  const fakeKey = { tool_name: 'Write', description: 'd', input_preview: JSON.stringify({ content: pem + '\nrm -rf ~' }) }
  assert.equal(permissionRedacted(fakeKey, []), true)
  assert.equal(permissionRedacted({ tool_name: 'Bash', description: 'd', input_preview: 'echo sk-' + 'a'.repeat(24) }, []), true)
  // A JSON escape hides the token from the raw pass; only the pretty-printed pass sees it.
  const escaped = { tool_name: 'Bash', description: 'd', input_preview: '{"c":"\\u0073k-' + 'a'.repeat(24) + '"}' }
  assert.equal(permissionRedacted(escaped, []), true)
  assert.equal(permissionRedacted({ tool_name: 'Bash', description: 'use literalsecret1', input_preview: '{}' }, ['literalsecret1']), true)
  assert.equal(permissionRedacted({ tool_name: 'Bash', description: 'use other', input_preview: '{}' }, ['literalsecret1']), false)
})

test('permissionButtons: a redacted request has no Allow button, initial or expanded', () => {
  const labels = (b: { text: string }[]) => b.map((x) => x.text)
  assert.deepEqual(labels(permissionButtons('abcde', { withMore: true, redacted: false })), ['See more', '✅ Allow', '❌ Deny'])
  assert.deepEqual(labels(permissionButtons('abcde', { withMore: false, redacted: false })), ['✅ Allow', '❌ Deny'])
  assert.deepEqual(labels(permissionButtons('abcde', { withMore: true, redacted: true })), ['See more', '❌ Deny'])
  assert.deepEqual(labels(permissionButtons('abcde', { withMore: false, redacted: true })), ['❌ Deny'])
  const redactedAll = permissionButtons('abcde', { withMore: true, redacted: true })
  assert.equal(redactedAll.some((b) => b.data.startsWith('perm:allow:')), false)
  assert.equal(redactedAll.find((b) => b.text === '❌ Deny')?.data, 'perm:deny:abcde')
})

test('permissionRefusal refuses only allow on a redacted request (text yes and callback allow alike)', () => {
  assert.equal(permissionRefusal('allow', true), PERMISSION_REDACTED_REFUSAL)
  assert.equal(PERMISSION_REDACTED_REFUSAL, "Can't allow this one from Telegram — part of it was hidden. Approve at the desk.")
  assert.equal(permissionRefusal('deny', true), null)
  assert.equal(permissionRefusal('allow', false), null)
  assert.equal(permissionRefusal('deny', false), null)
})

test('permission prompt and expanded text end with the hidden-input note only when redacted', () => {
  const d = { tool_name: 'Bash', description: 'd', input_preview: '{"c":"-----BEGIN PRIVATE KEY-----"}' }
  const prompt = permissionPromptText('proj', d, [], true)
  assert.ok(prompt.endsWith(`\n\n${PERMISSION_REDACTED_NOTE}`))
  assert.equal(permissionPromptText('proj', d, [], false).includes('hidden because'), false)
  assert.equal(permissionPromptText('proj', d).includes('hidden because'), false)
  const expanded = expandedPermissionText(d, [], true)
  assert.ok(expanded.endsWith(PERMISSION_REDACTED_NOTE))
  assert.equal(expandedPermissionText(d, [], false).includes('hidden because'), false)
  const big = { tool_name: 'Write', description: 'd', input_preview: JSON.stringify({ content: 'z'.repeat(10_000) }) }
  const bigExpanded = expandedPermissionText(big, [], true)
  assert.ok(bigExpanded.length <= TG_PERMISSION_EXPAND_LIMIT)
  assert.ok(bigExpanded.endsWith(PERMISSION_REDACTED_NOTE))
})

test('isInteractiveClaude is false for print mode and the stream formats, true otherwise', () => {
  const batch = ['claude', '-p', '--output-format', 'json', '--max-turns', '1', '--tools', '', '--model', 'haiku', '--no-session-persistence']
  assert.equal(isInteractiveClaude(batch), false)
  assert.equal(isInteractiveClaude(['claude', '--print', 'hi']), false)
  assert.equal(isInteractiveClaude(['claude', '--print=hi']), false)
  assert.equal(isInteractiveClaude(['claude', '--output-format=stream-json', '-p']), false)
  assert.equal(isInteractiveClaude(['claude', '--output-format', 'stream-json']), false)
  assert.equal(isInteractiveClaude(['claude', '--input-format', 'stream-json']), false)
  assert.equal(isInteractiveClaude(['claude', '--input-format=stream-json']), false)
  assert.equal(isInteractiveClaude(['claude', '--dangerously-load-development-channels', 'server:stolik']), true)
  assert.equal(isInteractiveClaude(['claude', '--dangerously-skip-permissions']), true)
  assert.equal(isInteractiveClaude(['claude', '--resume', 'abc']), true)
  assert.equal(isInteractiveClaude(['claude']), true)
  assert.equal(isInteractiveClaude([]), true)
})

test('isInteractiveClaude matches flags exactly, not as a substring of another argument', () => {
  assert.equal(isInteractiveClaude(['claude', '--resume', 'abc-p']), true)
  assert.equal(isInteractiveClaude(['claude', '--printer']), true)
  assert.equal(isInteractiveClaude(['claude', '--output-format-x']), true)
})

test('detachedSession builds a session that the registry does not hold', () => {
  const d = detachedSession({ pid: 555, start: 's555' }, '/home/u/Documents/projects/foo', T0)
  assert.equal(d.name, 'foo')
  assert.equal(d.key, '555:s555')
  assert.equal(d.hasChannel, false)
  const r = new Registry()
  assert.equal(r.list().length, 0)
})

test('Registry.remove forgets a session by key', () => {
  const r = new Registry()
  const s = r.registerChannel(P(700), '/a/gone', T0)
  assert.equal(r.remove(s.key)?.name, 'gone')
  assert.equal(r.list().length, 0)
  assert.equal(r.remove(s.key), undefined)
})

// ---------- project folders ----------

const H = '/home/u'
const R1 = '/home/u/Documents/projects'
const R2 = '/home/u/Documents/projects/proga'

test('parseProjectRef accepts name and root/name, rejects bad names', () => {
  assert.deepEqual(parseProjectRef('cat-garden'), { qualifier: null, name: 'cat-garden' })
  assert.deepEqual(parseProjectRef('proga/cat-garden'), { qualifier: 'proga', name: 'cat-garden' })
  assert.deepEqual(parseProjectRef('a.b_c-1'), { qualifier: null, name: 'a.b_c-1' })
  for (const bad of ['.', '..', '../x', 'x/..', 'x/.', '/x', 'x/', 'a/b/c', '', 'a b', 'a;b', '~', 'x\\y']) {
    assert.equal(parseProjectRef(bad), null, bad)
  }
})

test('trustedDirs: the folders whose trust dialog is accepted, absolute paths only, sorted', () => {
  const cj = {
    projects: {
      '/home/u/b': { hasTrustDialogAccepted: true },
      '/home/u/a': { hasTrustDialogAccepted: true },
      '/home/u/off': { hasTrustDialogAccepted: false },
      '/home/u/text': { hasTrustDialogAccepted: 'true' },
      '/home/u/empty': {},
      '/home/u/null': null,
      'relative/x': { hasTrustDialogAccepted: true },
    },
  }
  assert.deepEqual(trustedDirs(cj), ['/home/u/a', '/home/u/b'])
})

test('trustedDirs: a missing projects value or non-object input gives no folders', () => {
  assert.deepEqual(trustedDirs({}), [])
  assert.deepEqual(trustedDirs({ projects: null }), [])
  assert.deepEqual(trustedDirs({ projects: 'x' }), [])
  for (const bad of [null, undefined, 'x', 42, true, []]) {
    assert.deepEqual(trustedDirs(bad), [], String(bad))
  }
})

test('resolveProject: a name matching one startable folder resolves to it; qualified form checks the parent', () => {
  const dirs = [`${R1}/stolik`, `${R2}/cat-garden`]
  assert.deepEqual(resolveProject('cat-garden', dirs, H), { status: 'found', name: 'cat-garden', dir: `${R2}/cat-garden` })
  assert.deepEqual(resolveProject('proga/cat-garden', dirs, H), { status: 'found', name: 'cat-garden', dir: `${R2}/cat-garden` })
  assert.equal(resolveProject('projects/cat-garden', dirs, H).status, 'none')
  assert.equal(resolveProject('nothing', dirs, H).status, 'none')
  assert.equal(resolveProject('cat-garden', [], H).status, 'none')
})

test('resolveProject: a name in several folders is ambiguous; the error lists the paths and the qualified forms', () => {
  const dirs = [`${R1}/cat-garden`, `${R2}/cat-garden`]
  assert.deepEqual(resolveProject('cat-garden', dirs, H), {
    status: 'ambiguous',
    error: 'cat-garden exists in several places: ~/Documents/projects/cat-garden, ~/Documents/projects/proga/cat-garden. ' +
      'Use /to projects/cat-garden or /to proga/cat-garden',
  })
})

test('resolveProject: the qualified form picks one of several folders with the same name', () => {
  const dirs = [`${R1}/cat-garden`, `${R2}/cat-garden`]
  assert.deepEqual(resolveProject('proga/cat-garden', dirs, H), { status: 'found', name: 'cat-garden', dir: `${R2}/cat-garden` })
  assert.deepEqual(resolveProject('projects/cat-garden', dirs, H), { status: 'found', name: 'cat-garden', dir: `${R1}/cat-garden` })
})

test('resolveProject: a qualified form that is still ambiguous says so and lists the paths', () => {
  const dirs = [`${H}/a/apps/x`, `${H}/b/apps/x`]
  assert.deepEqual(resolveProject('apps/x', dirs, H), {
    status: 'ambiguous',
    error: 'apps/x is still ambiguous, it matches: ~/a/apps/x, ~/b/apps/x',
  })
  // Bare name: the qualified forms are identical, so no hint is offered.
  assert.deepEqual(resolveProject('x', dirs, H), {
    status: 'ambiguous',
    error: 'x exists in several places: ~/a/apps/x, ~/b/apps/x',
  })
})

test('resolveProject: invalid refs never match, whatever the folders are', () => {
  const dirs = [`${R1}/x`, `${R2}/y`]
  for (const bad of ['..', '.', '../x', 'a/b/c', '', 'x/..', '/x', 'x/', 'x/x']) {
    assert.equal(resolveProject(bad, dirs, H).status, 'none', bad)
  }
})

test('routeInbound: /to proga/cat-garden spawns the root 2 folder, or routes to its live session', () => {
  const found: ProjectResolution = { status: 'found', name: 'cat-garden', dir: `${R2}/cat-garden` }
  const spawn = routeInbound('/to proga/cat-garden hi', T0, ctx({ resolveProject: () => found }))
  assert.deepEqual(spawn, { type: 'spawn', project: 'cat-garden', dir: `${R2}/cat-garden`, content: 'hi' })
  const running = sess({ name: 'cat-garden#2', project: 'cat-garden', cwd: `${R2}/cat-garden` })
  const routed = routeInbound('/to proga/cat-garden hi', T0, ctx({ live: [running], resolveProject: () => found }))
  assert.deepEqual(routed, { type: 'session', session: running, content: 'hi' })
})

test('routeInbound: an ambiguous /to is an error, not a spawn', () => {
  const r = routeInbound('/to cat-garden hi', T0, ctx({ resolveProject: () => ({ status: 'ambiguous', error: 'x in several places' }) }))
  assert.deepEqual(r, { type: 'error', text: 'x in several places' })
})

test('findImagePaths: a backticked path is found without the backticks', () => {
  assert.deepEqual(findImagePaths('Saved to `/home/u/Documents/hero-concepts.png` for you', HOME), ['/home/u/Documents/hero-concepts.png'])
})

test('findImagePaths: a path followed by " — " ends at the extension', () => {
  assert.deepEqual(findImagePaths('/home/u/out/a.jpg — done', HOME), ['/home/u/out/a.jpg'])
})

test('findImagePaths: a trailing period, comma or closing parenthesis is not part of the path', () => {
  assert.deepEqual(findImagePaths('See /home/u/out/a.png.', HOME), ['/home/u/out/a.png'])
  assert.deepEqual(findImagePaths('Files: /home/u/a.webp, /home/u/b.gif.', HOME), ['/home/u/a.webp', '/home/u/b.gif'])
  assert.deepEqual(findImagePaths('(see /home/u/a.jpeg)', HOME), ['/home/u/a.jpeg'])
  assert.deepEqual(findImagePaths('quoted "/home/u/a.PNG"', HOME), ['/home/u/a.PNG'])
})

test('findImagePaths: a ~/ path is expanded with the home dir passed in', () => {
  assert.deepEqual(findImagePaths('Look at ~/pics/x.png', '/srv/home'), ['/srv/home/pics/x.png'])
  assert.deepEqual(findImagePaths('Look at ~/pics/x.png', '/srv/home/'), ['/srv/home/pics/x.png'])
})

test('findImagePaths: duplicates are dropped and the first occurrence keeps its place', () => {
  assert.deepEqual(
    findImagePaths('/home/u/a.png then /home/u/b.png and again `/home/u/a.png`', HOME),
    ['/home/u/a.png', '/home/u/b.png'],
  )
})

test('findImagePaths: at most AUTO_IMAGE_MAX paths, in order', () => {
  assert.equal(AUTO_IMAGE_MAX, 3)
  const text = '/home/u/1.png /home/u/2.png /home/u/3.png /home/u/4.png /home/u/5.jpg'
  assert.deepEqual(findImagePaths(text, HOME), ['/home/u/1.png', '/home/u/2.png', '/home/u/3.png'])
})

test('findImagePaths: non-image paths and relative paths are ignored', () => {
  assert.deepEqual(findImagePaths('/home/u/notes.md and /home/u/data.pdf and relative/x.png', HOME), [])
  assert.deepEqual(findImagePaths('no paths here at all', HOME), [])
})

test('findImagePaths: a path inside a URL is not taken as a local path', () => {
  assert.deepEqual(findImagePaths('see https://cdn.example.com/img/a.png', HOME), [])
})


test('shouldAnnounceBoot: announces when the boot id differs or no boot was saved', () => {
  assert.equal(shouldAnnounceBoot('aaaa-1111', 'bbbb-2222'), true)
  assert.equal(shouldAnnounceBoot('aaaa-1111', null), true)
  assert.equal(shouldAnnounceBoot('aaaa-1111', ''), true)
})

test('shouldAnnounceBoot: same boot id (router restart) does not announce', () => {
  assert.equal(shouldAnnounceBoot('aaaa-1111', 'aaaa-1111'), false)
  assert.equal(shouldAnnounceBoot('aaaa-1111\n', 'aaaa-1111\n'), false)
})

test('shouldAnnounceBoot: an empty or unreadable current boot id never announces', () => {
  assert.equal(shouldAnnounceBoot('', null), false)
  assert.equal(shouldAnnounceBoot('  \n', 'bbbb-2222'), false)
})

test('bootAnnouncementText: boot time is now minus uptime, minutes from uptime', () => {
  const boot = new Date(2026, 10, 2, 9, 5, 0) // local time, so the test does not depend on the zone
  const nowMs = boot.getTime() + 125 * MINUTE
  assert.equal(
    bootAnnouncementText({ nowMs, uptimeSec: 125 * 60, sessions: 0 }),
    '🟢 PC is up — booted 09:05 (125 min ago)',
  )
})

test('bootAnnouncementText: appends the live session count, with plural handling', () => {
  const nowMs = new Date(2026, 10, 2, 9, 5, 0).getTime() + 2 * MINUTE
  const uptimeSec = 120
  assert.equal(
    bootAnnouncementText({ nowMs, uptimeSec, sessions: 1 }),
    '🟢 PC is up — booted 09:05 (2 min ago) · 1 session live',
  )
  assert.equal(
    bootAnnouncementText({ nowMs, uptimeSec, sessions: 3 }),
    '🟢 PC is up — booted 09:05 (2 min ago) · 3 sessions live',
  )
})

test('bootAnnouncementText: uses 24h time, so midnight reads 00:00', () => {
  const nowMs = new Date(2026, 10, 2, 0, 30, 0).getTime()
  assert.equal(
    bootAnnouncementText({ nowMs, uptimeSec: 30 * 60, sessions: 0 }),
    '🟢 PC is up — booted 00:00 (30 min ago)',
  )
})

test('BOOT_ANNOUNCE_RETRY_MS: 5 s, 15 s, 30 s, 60 s', () => {
  assert.deepEqual([...BOOT_ANNOUNCE_RETRY_MS], [5_000, 15_000, 30_000, 60_000])
})

test('isOwnerUser: only the configured owner id passes, a missing id never does', () => {
  assert.equal(isOwnerUser(tgUser(123), tgUser(123)), true)
  assert.equal(isOwnerUser(tgUser(124), tgUser(123)), false)
  assert.equal(isOwnerUser(undefined, tgUser(123)), false)
  assert.equal(isOwnerUser('', tgUser(123)), false)
})

test('verdictLabel says what was sent, never that the action happened', () => {
  assert.equal(verdictLabel('allow'), 'Sent: allow')
  assert.equal(verdictLabel('deny'), 'Sent: deny')
})

test('hasDeliverableBody: empty queued text is skipped, prepared media body decides when present', () => {
  assert.equal(hasDeliverableBody({ content: '' }), false)
  assert.equal(hasDeliverableBody({ content: '   ' }), false)
  assert.equal(hasDeliverableBody({ content: 'hi' }), true)
  assert.equal(hasDeliverableBody({ content: '', prepared: { body: '[photo]' } }), true)
  assert.equal(hasDeliverableBody({ content: 'hi', prepared: { body: '' } }), false)
})

test('SPAWN_FLUSH_DELAY_MS: about one second', () => {
  assert.equal(SPAWN_FLUSH_DELAY_MS, 1000)
})

test('approvalReminderDue: a 30-minute permission is due at 15:00, not at 14:59, and at 15:01', () => {
  const p = { createdAt: T0, reminded: false }
  assert.equal(approvalReminderDue(p, T0 + 14 * MINUTE + 59_000), false)
  assert.equal(approvalReminderDue(p, T0 + 15 * MINUTE), true)
  assert.equal(approvalReminderDue(p, T0 + 15 * MINUTE + 60_000), true)
})

test('approvalReminderDue: repeated calls stay due until the caller marks it reminded, then never again', () => {
  const p = { createdAt: T0, reminded: false }
  assert.equal(approvalReminderDue(p, T0 + 16 * MINUTE), true)
  assert.equal(approvalReminderDue(p, T0 + 16 * MINUTE), true)
  p.reminded = true
  assert.equal(approvalReminderDue(p, T0 + 16 * MINUTE), false)
  assert.equal(approvalReminderDue(p, T0 + 20 * MINUTE), false)
})

test('approvalReminderDue: never due at or after expiry, even when not yet reminded', () => {
  const p = { createdAt: T0, reminded: false }
  assert.equal(approvalReminderDue(p, T0 + PERMISSION_TTL_MS), true)
  assert.equal(approvalReminderDue(p, T0 + PERMISSION_TTL_MS + 1), false)
  assert.equal(approvalReminderDue(p, T0 + PERMISSION_TTL_MS + 5 * MINUTE), false)
})

test('approvalReminderDue: takes the TTL to use (a permission default, or another kind)', () => {
  const p = { createdAt: T0, reminded: false }
  assert.equal(approvalReminderDue(p, T0 + 10 * MINUTE, 20 * MINUTE), true)
  assert.equal(approvalReminderDue(p, T0 + 10 * MINUTE, PERMISSION_TTL_MS), false)
})

test('approvalReminderText: minutes left, rounded up, and the expiry note wording', () => {
  assert.equal(approvalReminderText(15 * MINUTE), '⏰ Still waiting for your answer (expires in 15 min).')
  assert.equal(approvalReminderText(14 * MINUTE + 30_000), '⏰ Still waiting for your answer (expires in 15 min).')
  assert.equal(approvalReminderText(1), '⏰ Still waiting for your answer (expires in 1 min).')
  assert.equal(APPROVAL_EXPIRED_TEXT, '⌛ Expired. Answer at the desk or /resume.')
})

test('evaluateAway: /override clears a pending /here, a lock keeps it (characterization)', () => {
  const base = { overrideAway: false, hereSetAt: T0, idleMs: 10 * MINUTE, locked: false }
  assert.deepEqual(evaluateAway({ ...base, overrideAway: true }, T0 + MINUTE), { away: true, hereSetAt: null })
  assert.deepEqual(evaluateAway({ ...base, locked: true }, T0 + MINUTE), { away: true, hereSetAt: T0 })
})

test('newSession: project is the folder basename, the name is kept as given, nothing is connected yet', () => {
  const s = newSession(7, 'garden', '/home/u/Documents/projects/cat-garden', null, T0)
  assert.equal(s.key, 7)
  assert.equal(s.name, 'garden')
  assert.equal(s.project, 'cat-garden')
  assert.equal(s.cwd, '/home/u/Documents/projects/cat-garden')
  assert.equal(s.pid, null)
  assert.equal(s.hasChannel, false)
  assert.equal(s.connected, false)
  assert.equal(s.lastActive, T0)
  assert.equal(s.turnStart, T0)
  assert.deepEqual(s.history, [])
  assert.equal(newSession(8, 'root', '/', 42, T0).project, '/', 'a root folder has no basename and keeps its path')
})

test('ROUTE_PENDING_TTL_MS: 30 minutes, the same window as an approval prompt', () => {
  assert.equal(ROUTE_PENDING_TTL_MS, 30 * MINUTE)
  assert.equal(ROUTE_PENDING_TTL_MS, PERMISSION_TTL_MS)
})
