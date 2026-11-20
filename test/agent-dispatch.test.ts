// The router holds one backend per agent kind and sends each session-keyed call to the backend of the session's kind.
import './helpers/isolate.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sweep } from '../src/router/handlers/timers.ts'
import { FakeAgent, FakeConn, HOME, harness, textFrom } from './helpers/fakes.ts'

test('agentFor routes sends: a session of kind opencode gets its messages from the opencode backend', async () => {
  const opencode = new FakeAgent()
  const h = harness({ opencodeAgent: opencode })
  await h.router.start()
  const s = h.router.registry.registerChannel({ pid: 5150, start: 'start-5150' }, `${HOME}/proj`, h.clock.now())
  s.agent = 'opencode'
  opencode.attachSession(s.key, new FakeConn())

  await h.chat.inbound(textFrom('hello'))

  assert.equal(opencode.sent.length, 1)
  assert.equal(opencode.sent[0].content, 'hello')
  assert.equal(h.agent.sent.length, 0)
})

test('sweep keeps an opencode session whose pid the Claude backend calls non-interactive', async () => {
  const opencode = new FakeAgent()
  const h = harness({ opencodeAgent: opencode })
  await h.router.start()
  const pid = 5151
  h.agent.nonInteractive.add(pid)
  const s = h.router.registry.registerChannel({ pid, start: `start-${pid}` }, HOME, h.clock.now())
  s.agent = 'opencode'
  opencode.attachSession(s.key, new FakeConn())

  sweep(h.router)

  assert.ok(h.router.registry.get(s.key), 'the session is still registered')
})

test('a Claude session still gets its messages from the Claude backend when an opencode backend is registered', async () => {
  const opencode = new FakeAgent()
  const h = harness({ opencodeAgent: opencode })
  await h.router.start()
  h.platform.dirs.add(`${HOME}/proj`)
  h.agent.receive(new FakeConn(), { t: 'register', claudePid: 4242, cwd: `${HOME}/proj` })

  await h.chat.inbound(textFrom('hi'))

  assert.equal(h.agent.sent.length, 1)
  assert.equal(opencode.sent.length, 0)
})

test('agentOf throws for a kind with no backend; agentFor of an unknown key is the Claude backend', () => {
  const h = harness()
  assert.throws(() => h.router.agentOf('opencode'), /no backend for opencode/)
  assert.equal(h.router.agentFor('9999:none' as never), h.agent)
})
