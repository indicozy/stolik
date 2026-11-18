// Markdown to Telegram HTML (src/markdown.ts) and the fence-aware chunking of session text.
import './helpers/isolate.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mdToTelegramHtml as md, reopenFences, prefixLine } from '../src/markdown.ts'
import { chunkMarkdown, formatForSession, TG_TEXT_LIMIT } from '../src/router/state.ts'

test('escapes &, < and > in all text', () => {
  assert.equal(md('a & b'), 'a &amp; b')
  assert.equal(md('x < y'), 'x &lt; y')
  assert.equal(md('<script>alert(1)</script>'), '&lt;script&gt;alert(1)&lt;/script&gt;')
})

test('fenced code: language class, escaped content, no inline parsing inside', () => {
  assert.equal(md('```ts\nconst x = 1 < 2 **no**\n```'), '<pre><code class="language-ts">const x = 1 &lt; 2 **no**</code></pre>')
  assert.equal(md('```\nplain & simple\n```'), '<pre>plain &amp; simple</pre>')
  assert.equal(md('```ts\n[a](https://x.y)\n```'), '<pre><code class="language-ts">[a](https://x.y)</code></pre>')
})

test('an unclosed fence runs to the end and is closed', () => {
  assert.equal(md('before\n```js\nlet a = 1\nlet b = 2'), 'before\n<pre><code class="language-js">let a = 1\nlet b = 2</code></pre>')
})

test('inline code is escaped and holds no markers', () => {
  assert.equal(md('use `a <b> **c**` now'), 'use <code>a &lt;b&gt; **c**</code> now')
})

test('bold, italic, strike', () => {
  assert.equal(md('**bold** and __also__'), '<b>bold</b> and <b>also</b>')
  assert.equal(md('*it* and _this_'), '<i>it</i> and <i>this</i>')
  assert.equal(md('~~gone~~'), '<s>gone</s>')
})

test('nested emphasis stays balanced', () => {
  assert.equal(md('**bold *it***'), '<b>bold <i>it</i></b>')
  assert.equal(md('*a **b** c*'), '<i>a <b>b</b> c</i>')
  // Crossing spans: the unbalanced strike stays literal instead of emitting a stray </s>.
  assert.equal(md('**a ~~b** c~~'), '<b>a ~~b</b> c~~')
})

test('unmatched markers stay literal', () => {
  assert.equal(md('a * b'), 'a * b')
  assert.equal(md('**open only'), '**open only')
  assert.equal(md('x ** y ** z'), 'x ** y ** z')
  assert.equal(md('~~nope'), '~~nope')
})

test('underscore italics only at word boundaries: snake_case and a_b stay as they are', () => {
  assert.equal(md('snake_case_name'), 'snake_case_name')
  assert.equal(md('a_b'), 'a_b')
  assert.equal(md('call my_func_x and _this_ one'), 'call my_func_x and <i>this</i> one')
})

test('links: http, https, mailto and tg only; others stay literal text', () => {
  assert.equal(md('[docs](https://example.com/a?b=1&c=2)'), '<a href="https://example.com/a?b=1&amp;c=2">docs</a>')
  assert.equal(md('[mail](mailto:a@b.c)'), '<a href="mailto:a@b.c">mail</a>')
  assert.equal(md('[tg](tg://user?id=1)'), '<a href="tg://user?id=1">tg</a>')
  assert.equal(md('[x](javascript:alert)'), '[x](javascript:alert)')
  assert.equal(md('[x](data:text/html,hi)'), '[x](data:text/html,hi)')
  assert.equal(md('[bold **link**](https://a.b)'), '<a href="https://a.b">bold <b>link</b></a>')
})

test('a quote in a link URL is escaped in the attribute', () => {
  assert.equal(md('[q](https://a.b/"x")'), '<a href="https://a.b/&quot;x&quot;">q</a>')
})

test('headings become bold lines, with bold markers inside stripped', () => {
  assert.equal(md('# Title'), '<b>Title</b>')
  assert.equal(md('### Deep **x**'), '<b>Deep x</b>')
  assert.equal(md('###### Six'), '<b>Six</b>')
  assert.equal(md('#hashtag'), '#hashtag')
})

test('consecutive quote lines form one blockquote', () => {
  assert.equal(md('> one\n> two & three\nafter'), '<blockquote>one\ntwo &amp; three</blockquote>\nafter')
})

test('list markers become bullets, indentation kept; numbered lists unchanged', () => {
  assert.equal(md('- a\n  * b\n+ c'), '• a\n  • b\n• c')
  assert.equal(md('1. first\n2. second'), '1. first\n2. second')
})

test('horizontal rules become a rule line', () => {
  assert.equal(md('---'), '──────────')
  assert.equal(md('***'), '──────────')
})

test('tables: aligned columns in a pre block, separator replaced by a rule, markers stripped', () => {
  const out = md('| name | n |\n|---|---|\n| **alpha** | 1 |\n| `b` | 22 |')
  assert.equal(out, '<pre>name  | n\n──────────\nalpha | 1\nb     | 22</pre>')
})

test('tables: escaped pipes and cell text are escaped', () => {
  const out = md('| a | b |\n|:--|--:|\n| x\\|y | <i> |')
  assert.equal(out, '<pre>a   | b\n─────────\nx|y | &lt;i&gt;</pre>')
})

test('a lone pipe line without a separator row is not boxed', () => {
  assert.equal(md('| grep foo'), '| grep foo')
})

test('blank lines and plain text are kept', () => {
  assert.equal(md('one\n\ntwo'), 'one\n\ntwo')
})

test('sentinel characters in the input cannot break the placeholders', () => {
  assert.equal(md('a0b'), 'a0b')
})

test('the output never has unbalanced b/i/s tags', () => {
  const samples = [
    '**a *b ~~c** d~~ e*', '*x **y* z**', '__a _b__ c_', '~~**x~~ y**', '***a* b**', '**[l **m**](https://z.z)**',
  ]
  for (const s of samples) {
    const out = md(s)
    const stack: string[] = []
    for (const m of out.matchAll(/<(\/?)([bis])>/g)) {
      if (m[1]) assert.equal(stack.pop(), m[2], `unbalanced in ${JSON.stringify(out)}`)
      else stack.push(m[2]!)
    }
    assert.deepEqual(stack, [], `unclosed in ${JSON.stringify(out)}`)
  }
})

test('reopenFences: a chunk ending in a fence is closed and the next re-opens it, same language', () => {
  assert.deepEqual(reopenFences(['text\n```ts\nline1', 'line2\n```\nend']), ['text\n```ts\nline1\n```', '```ts\nline2\n```\nend'])
  assert.deepEqual(reopenFences(['a', 'b']), ['a', 'b'])
})

test('chunkMarkdown: chunks that split a fence are closed and re-opened, each one converts to valid HTML', () => {
  const body = ['intro', '```py', ...Array.from({ length: 40 }, (_, i) => `x = ${i}  # ${'z'.repeat(20)}`), '```', 'outro'].join('\n')
  const chunks = chunkMarkdown(body, 300)
  assert.ok(chunks.length > 2)
  assert.ok(chunks.every((c) => c.length <= 300 + 12), 'each chunk fits the limit plus the fence markers')
  for (const c of chunks.slice(0, -1)) assert.equal(md(c).match(/<pre>/g)?.length, md(c).match(/<\/pre>/g)?.length)
  assert.ok(chunks.slice(1).every((c) => c.startsWith('```py\n')), 'later chunks re-open the fence')
  assert.equal(md(chunks.join('\n')).includes('<pre><code class="language-py">'), true)
})

test('formatForSession (markdown): the prefix stays plain; a block body starts its own line', () => {
  assert.deepEqual(formatForSession('proj', 'hello'), ['[proj] hello'])
  assert.deepEqual(formatForSession('proj', '```ts\nx\n```'), ['[proj]\n```ts\nx\n```'])
  assert.equal(prefixLine('[p]', '# T'), '[p]\n# T')
  assert.equal(prefixLine('[p]', '- a'), '[p]\n- a')
  assert.equal(prefixLine('[p]', '(x)'), '[p] (x)')
  const parts = formatForSession('proj#2', 'y'.repeat(TG_TEXT_LIMIT * 2))
  assert.ok(parts.every((p) => p.startsWith('[proj#2] ') && p.length <= TG_TEXT_LIMIT - 500))
})

test('formatForSession (plain) keeps the old behaviour', () => {
  assert.deepEqual(formatForSession('proj', '```ts', [], 'plain'), ['[proj] ```ts'])
})
