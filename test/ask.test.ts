import './helpers/isolate.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseAskInput, answersDecision, approveDecision, denyDecision, feedbackMessage, cutLabel, questionText, questionRows,
  toggleSelected, selectedLabels, parseAskCallback, planMessages, planRows, findTextTarget,
  ASK_MAX_OPTIONS, PLAN_FOOTER, ASK_TTL_MS, type AskQuestion,
  permissionDetail, permissionMessage, permRows, denyFeedbackMessage, askToolName, PERM_DETAIL_CHARS, PERM_DENY_MESSAGE,
} from '../src/router/ask.ts'
import { isCommandText, TG_TEXT_LIMIT, MINUTE, approvalReminderDue } from '../src/router/state.ts'

const single: AskQuestion = {
  question: 'Which db?',
  header: 'Database',
  options: [
    { label: 'Postgres', description: 'relational' },
    { label: 'SQLite', description: '' },
  ],
  multiSelect: false,
}

test('parseAskInput: AskUserQuestion keeps questions, options and multiSelect', () => {
  const input = parseAskInput('AskUserQuestion', {
    questions: [{ question: 'Which db?', header: 'Database', multiSelect: false, options: [{ label: 'Postgres', description: 'relational' }, { label: 'SQLite' }] }],
  })
  assert.deepEqual(input, {
    tool: 'AskUserQuestion',
    questions: [{
      question: 'Which db?', header: 'Database', multiSelect: false,
      options: [{ label: 'Postgres', description: 'relational' }, { label: 'SQLite', description: '' }],
    }],
  })
})

test('parseAskInput: options are optional (free text only), and unusable options are skipped', () => {
  const input = parseAskInput('AskUserQuestion', {
    questions: [
      { question: 'Name?' },
      { question: 'Pick', options: [{ label: '' }, 'x', { label: 'Only' }, null] },
    ],
  })
  assert.ok(input && input.tool === 'AskUserQuestion')
  assert.deepEqual(input.questions[0], { question: 'Name?', header: '', options: [], multiSelect: false })
  assert.deepEqual(input.questions[1].options, [{ label: 'Only', description: '' }])
})

test('parseAskInput: options beyond the limit are dropped', () => {
  const many = Array.from({ length: ASK_MAX_OPTIONS + 5 }, (_, i) => ({ label: `o${i}` }))
  const input = parseAskInput('AskUserQuestion', { questions: [{ question: 'q', options: many }] })
  assert.ok(input && input.tool === 'AskUserQuestion')
  assert.equal(input.questions[0].options.length, ASK_MAX_OPTIONS)
})

test('parseAskInput: malformed AskUserQuestion input is null', () => {
  assert.equal(parseAskInput('AskUserQuestion', {}), null)
  assert.equal(parseAskInput('AskUserQuestion', { questions: [] }), null)
  assert.equal(parseAskInput('AskUserQuestion', { questions: 'x' }), null)
  assert.equal(parseAskInput('AskUserQuestion', { questions: [{ header: 'no question' }] }), null)
  assert.equal(parseAskInput('AskUserQuestion', null), null)
  assert.equal(parseAskInput('AskUserQuestion', ['x']), null)
})

test('parseAskInput: ExitPlanMode needs a non-empty plan string; other tools are null', () => {
  assert.deepEqual(parseAskInput('ExitPlanMode', { plan: '# Plan', planFilePath: '/x.md' }), { tool: 'ExitPlanMode', plan: '# Plan' })
  assert.equal(parseAskInput('ExitPlanMode', { plan: '   ' }), null)
  assert.equal(parseAskInput('ExitPlanMode', {}), null)
  assert.equal(parseAskInput('', { plan: 'x' }), null, 'no tool name')
})

test('parseAskInput: any other tool is a Permission prompt with its name and a detail', () => {
  assert.deepEqual(parseAskInput('Bash', { command: 'ls -la' }), { tool: 'Permission', toolName: 'Bash', detail: 'ls -la' })
  assert.deepEqual(parseAskInput('Edit', { file_path: '/p/a.ts', old_string: 'x', new_string: 'y' }), { tool: 'Permission', toolName: 'Edit', detail: '/p/a.ts' })
  const mcp = parseAskInput('mcp__github__create_issue', { title: 'T', body: 'B' })
  assert.deepEqual(mcp, { tool: 'Permission', toolName: 'mcp__github__create_issue', detail: JSON.stringify({ title: 'T', body: 'B' }, null, 1) })
})

test('parseAskInput: malformed permission input (not an object, or no tool name) is null', () => {
  assert.equal(parseAskInput('Bash', 'ls'), null)
  assert.equal(parseAskInput('Bash', null), null)
  assert.equal(parseAskInput('Bash', ['ls']), null)
  assert.equal(parseAskInput('Bash', undefined), null)
  assert.equal(parseAskInput('', { command: 'ls' }), null)
})

test('permissionDetail: Bash shows the description above the command; file and web tools show their key field', () => {
  assert.equal(permissionDetail('Bash', { command: 'npm test', description: 'Run the tests' }), 'Run the tests\nnpm test')
  assert.equal(permissionDetail('Bash', { command: 'npm test' }), 'npm test')
  assert.equal(permissionDetail('Write', { file_path: '/x.md', content: 'big' }), '/x.md')
  assert.equal(permissionDetail('Read', { file_path: '/x.md' }), '/x.md')
  assert.equal(permissionDetail('NotebookEdit', { file_path: '/n.ipynb' }), '/n.ipynb')
  assert.equal(permissionDetail('WebFetch', { url: 'https://example.com', prompt: 'p' }), 'https://example.com')
  assert.equal(permissionDetail('WebSearch', { query: 'tg bridge' }), 'tg bridge')
  // Without the key field the tool falls back to its JSON input.
  assert.equal(permissionDetail('Bash', { timeout: 5 }), JSON.stringify({ timeout: 5 }, null, 1))
  assert.equal(permissionDetail('Edit', { old_string: 'a' }), JSON.stringify({ old_string: 'a' }, null, 1))
})

test('askToolName: the real tool name for a permission prompt, the variant name otherwise', () => {
  assert.equal(askToolName({ tool: 'Permission', toolName: 'Bash', detail: 'ls' }), 'Bash')
  assert.equal(askToolName({ tool: 'ExitPlanMode', plan: 'p' }), 'ExitPlanMode')
  assert.equal(askToolName({ tool: 'AskUserQuestion', questions: [] }), 'AskUserQuestion')
})

test('permissionMessage: heading with the session and tool, the detail below; long detail is cut to the limit', () => {
  assert.equal(permissionMessage('proj', 'Bash', 'npm test'), '🔐 [proj] wants to run Bash\n\nnpm test')
  const long = permissionMessage('proj', 'Bash', 'x'.repeat(PERM_DETAIL_CHARS + 500))
  assert.equal(Array.from(long.split('\n\n')[1]).length, PERM_DETAIL_CHARS)
  assert.ok(long.endsWith('…'))
})

test('permissionMessage: secrets are redacted before the detail is cut, so none leaks across the cut', () => {
  const secret = 'sk-' + 'A'.repeat(30)
  // The secret starts just before the cut: redacted first, so neither the secret nor its head survives the cut.
  const straddle = 'x'.repeat(PERM_DETAIL_CHARS - 10) + ' ' + secret + ' tail'
  const out = permissionMessage('p', 'Bash', straddle, [])
  assert.ok(!out.includes(secret))
  assert.ok(!out.includes('sk-AAAA'), 'no head of the secret either')
  // Within the limit, the marker is shown in place of the secret.
  const shortOut = permissionMessage('p', 'Bash', `echo ${secret}`, [])
  assert.ok(!shortOut.includes(secret))
  assert.ok(shortOut.includes('[REDACTED]'))
})

test('permRows: Allow and Deny on one row, with the ask id', () => {
  assert.deepEqual(permRows('abcd1234'), [[
    { text: '✅ Allow', data: 'apm:abcd1234:y' },
    { text: '❌ Deny', data: 'apm:abcd1234:n' },
  ]])
})

test('deny messages: the plain denial, and the denial with the reply as feedback', () => {
  assert.equal(PERM_DENY_MESSAGE, 'The user denied this tool call from Telegram.')
  assert.equal(denyFeedbackMessage('use rg'), 'The user denied this tool call from Telegram with this feedback: use rg')
})

test('decisions: answers are added to the original input; approve keeps it; deny carries a message', () => {
  const input = { questions: [{ question: 'Which db?' }], extra: 1 }
  assert.deepEqual(answersDecision(input, { 'Which db?': 'Postgres' }), {
    behavior: 'allow',
    updatedInput: { questions: [{ question: 'Which db?' }], extra: 1, answers: { 'Which db?': 'Postgres' } },
  })
  assert.deepEqual(approveDecision({ plan: 'p' }), { behavior: 'allow', updatedInput: { plan: 'p' } })
  assert.deepEqual(denyDecision('nope'), { behavior: 'deny', message: 'nope' })
  assert.equal(feedbackMessage('use sqlite'), 'The user rejected the plan from Telegram with this feedback: use sqlite')
})

test('cutLabel: at most 40 characters, code points kept whole', () => {
  assert.equal(cutLabel('short'), 'short')
  const long = 'a'.repeat(41)
  assert.equal(cutLabel(long), 'a'.repeat(39) + '…')
  assert.equal(Array.from(cutLabel(long)).length, 40)
  const emoji = '🙂'.repeat(41)
  assert.equal(cutLabel(emoji), '🙂'.repeat(39) + '…')
})

test('questionText: header, question, numbered options with descriptions, and the hint', () => {
  assert.equal(
    questionText('proj', single),
    [
      '❓ [proj] Database',
      'Which db?',
      '1. Postgres — relational',
      '2. SQLite',
      '(tap an option, or reply with your own answer)',
    ].join('\n'),
  )
})

test('questionText: no header, no options, and multi-select hints', () => {
  assert.equal(questionText('p', { question: 'Name?', header: '  ', options: [], multiSelect: false }), '❓ [p]\nName?\n\n(reply with your answer)')
  const multi = { ...single, multiSelect: true }
  assert.ok(questionText('p', multi).endsWith('(tap options to pick several, then ✅ Done)'))
})

test('questionRows: one button per option, in order, with callback data', () => {
  const id = 'abcd1234'
  assert.deepEqual(questionRows(id, 0, single, new Set()), [
    [{ text: 'Postgres', data: 'aq:abcd1234:0:0' }],
    [{ text: 'SQLite', data: 'aq:abcd1234:0:1' }],
  ])
  assert.deepEqual(questionRows(id, 2, { ...single, options: [] }, new Set()), [])
})

test('questionRows: multi-select shows the pick state and a Done button; long labels are cut', () => {
  const longLabel = 'x'.repeat(50)
  const multi: AskQuestion = { ...single, multiSelect: true, options: [{ label: 'A', description: '' }, { label: longLabel, description: '' }] }
  const rows = questionRows('abcd1234', 1, multi, new Set([1]))
  assert.deepEqual(rows, [
    [{ text: '☐ A', data: 'aq:abcd1234:1:0' }],
    [{ text: '☑ ' + 'x'.repeat(39) + '…', data: 'aq:abcd1234:1:1' }],
    [{ text: '✅ Done', data: 'aq:abcd1234:1:d' }],
  ])
})

test('toggleSelected returns a new set; selectedLabels follows option order', () => {
  const start = new Set<number>([2])
  const on = toggleSelected(start, 0)
  assert.deepEqual([...on].sort(), [0, 2])
  assert.deepEqual([...start], [2], 'the input set is not changed')
  assert.deepEqual([...toggleSelected(on, 2)], [0])
  const three: AskQuestion = { ...single, multiSelect: true, options: [{ label: 'A', description: '' }, { label: 'B', description: '' }, { label: 'C', description: '' }] }
  assert.deepEqual(selectedLabels(three, new Set([2, 0])), ['A', 'C'])
  assert.deepEqual(selectedLabels(three, new Set()), [])
})

test('parseAskCallback: question, Done and plan callbacks', () => {
  assert.deepEqual(parseAskCallback('aq:0a1b2c3d:0:2'), { kind: 'question', askId: '0a1b2c3d', qIdx: 0, opt: 2 })
  assert.deepEqual(parseAskCallback('aq:0a1b2c3d:12:d'), { kind: 'question', askId: '0a1b2c3d', qIdx: 12, opt: 'done' })
  assert.deepEqual(parseAskCallback('ap:0a1b2c3d:y'), { kind: 'plan', askId: '0a1b2c3d', approve: true })
  assert.deepEqual(parseAskCallback('ap:0a1b2c3d:n'), { kind: 'plan', askId: '0a1b2c3d', approve: false })
})

test('parseAskCallback: permission Allow and Deny (apm), and no confusion with the plan prefix', () => {
  assert.deepEqual(parseAskCallback('apm:0a1b2c3d:y'), { kind: 'perm', askId: '0a1b2c3d', allow: true })
  assert.deepEqual(parseAskCallback('apm:0a1b2c3d:n'), { kind: 'perm', askId: '0a1b2c3d', allow: false })
  for (const bad of ['apm:0a1b2c3:y', 'apm:0a1b2c3d:x', 'apm:0a1b2c3d', 'apm:0A1B2C3D:y']) {
    assert.equal(parseAskCallback(bad), null, bad)
  }
})

test('parseAskCallback: anything else is null (wrong id length, case, index size, other prefixes)', () => {
  for (const bad of ['aq:0a1b2c3:0:0', 'aq:0A1B2C3D:0:0', 'aq:0a1b2c3d:100:0', 'aq:0a1b2c3d:0:x', 'ap:0a1b2c3d:x', 'ap:0a1b2c3d:yes', 'perm:allow:abcde', 'rt:w:0a1b2c3d', '']) {
    assert.equal(parseAskCallback(bad), null, bad)
  }
})

test('planMessages: a short plan is one message with the heading and the footer', () => {
  const out = planMessages('proj', '# Plan\n- step')
  assert.deepEqual(out, [`📋 [proj] plan ready for approval\n\n# Plan\n- step\n\n${PLAN_FOOTER}`])
})

test('planMessages: a long plan is split within the Telegram limit, footer on the last one, nothing lost', () => {
  const plan = Array.from({ length: 900 }, (_, i) => `line ${i} of the plan`).join('\n')
  const out = planMessages('proj', plan)
  assert.ok(out.length > 1)
  for (const chunk of out) assert.ok(chunk.length <= TG_TEXT_LIMIT, `chunk of ${chunk.length} chars`)
  assert.ok(out[out.length - 1].endsWith(PLAN_FOOTER))
  for (const chunk of out.slice(0, -1)) assert.ok(!chunk.includes(PLAN_FOOTER))
  const joined = out.join('\n')
  for (let i = 0; i < 900; i += 97) assert.ok(joined.includes(`line ${i} of the plan`))
})

test('planMessages: a full last chunk pushes the footer into its own message', () => {
  const plan = 'x'.repeat(TG_TEXT_LIMIT - 60)
  const out = planMessages('p', plan)
  assert.equal(out[out.length - 1], PLAN_FOOTER)
  assert.ok(out.slice(0, -1).every((c) => c.length <= TG_TEXT_LIMIT))
})

test('planMessages: secrets are redacted before splitting', () => {
  const secret = 'sk-' + 'A'.repeat(30)
  const out = planMessages('p', `use key ${secret} here`, [])
  assert.ok(!out.join('\n').includes(secret))
  assert.ok(out.join('\n').includes('[REDACTED]'))
})

test('planRows: Approve and Reject on one row, with the ask id', () => {
  assert.deepEqual(planRows('abcd1234'), [[
    { text: '✅ Approve', data: 'ap:abcd1234:y' },
    { text: '❌ Reject', data: 'ap:abcd1234:n' },
  ]])
})

test('findTextTarget: a reply targets the ask whose message it replies to, of any of its messages', () => {
  const asks = [
    { id: 'a', messageIds: [10] },
    { id: 'b', messageIds: [20, 21, 22] },
  ]
  assert.equal(findTextTarget(asks, 10)?.id, 'a')
  assert.equal(findTextTarget(asks, 21)?.id, 'b')
  assert.equal(findTextTarget(asks, 99), null, 'a reply to something else is not an answer')
})

test('findTextTarget: a plain message answers only when exactly one ask is pending', () => {
  assert.equal(findTextTarget([{ id: 'a', messageIds: [10] }], null)?.id, 'a')
  assert.equal(findTextTarget([{ id: 'a', messageIds: [10] }, { id: 'b', messageIds: [20] }], null), null)
  assert.equal(findTextTarget([], null), null)
})

test('isCommandText: router commands and /to, with or without arguments; other text is not a command', () => {
  for (const t of ['/list', '/to proj hi', '/LIST', '/help', '/lock', '/away@mybot', '  /here  ', '/to\nproj']) {
    assert.equal(isCommandText(t), true, t)
  }
  for (const t of ['list', 'note /list', 'hello /to x', '/unknowncmd', '/', '/listing']) {
    assert.equal(isCommandText(t), false, t)
  }
})

test('ASK_TTL_MS is 55 minutes; the ask reminder is due at half of it (27.5 min), once, never after expiry', () => {
  assert.equal(ASK_TTL_MS, 55 * MINUTE)
  const a = { createdAt: 0, reminded: false }
  assert.equal(approvalReminderDue(a, 27 * MINUTE + 29_000, ASK_TTL_MS), false)
  assert.equal(approvalReminderDue(a, 27.5 * MINUTE, ASK_TTL_MS), true)
  assert.equal(approvalReminderDue(a, 40 * MINUTE, ASK_TTL_MS), true)
  a.reminded = true
  assert.equal(approvalReminderDue(a, 40 * MINUTE, ASK_TTL_MS), false)
  assert.equal(approvalReminderDue({ createdAt: 0, reminded: false }, 55 * MINUTE + 1, ASK_TTL_MS), false)
})
