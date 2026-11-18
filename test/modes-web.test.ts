// Web mode URL checks (design §4.10, finding 7): decideWebFetch, the host helpers and the audit line. Pure functions.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { auditLine, decideWebFetch, hostsFromToolResponse, hostsInText, type HookPolicy } from '../src/brain/hook-policy.ts'

const POLICY: HookPolicy = {
  mode: 'web',
  home: '/home/test',
  cwd: '/home/test/Documents/projects/master',
  roots: ['/home/test/Documents/projects/master'],
  webHosts: ['docs.example.org'],
  webLog: null,
  auditFile: null,
  deniedLog: null,
}
const SEEN = new Set(['news.example.net'])

test('WebFetch to a host named in the question is allowed', () => {
  const d = decideWebFetch('https://docs.example.org/guide/intro', POLICY, new Set())
  assert.equal(d.allow, true)
})

test('WebFetch to a host from a prior WebSearch result of this run is allowed', () => {
  const d = decideWebFetch('https://news.example.net/story-1', POLICY, SEEN)
  assert.equal(d.allow, true)
})

test('WebFetch to an unknown host is denied', () => {
  const d = decideWebFetch('https://evil.test/page', POLICY, SEEN)
  assert.equal(d.allow, false)
  assert.match(d.reason, /evil\.test/)
})

test('host match is case-insensitive', () => {
  assert.equal(decideWebFetch('https://DOCS.Example.ORG/x', POLICY, new Set()).allow, true)
})

test('a query string longer than 100 characters is denied; 100 is allowed', () => {
  const long = 'https://docs.example.org/search?q=' + 'a'.repeat(100)
  assert.equal(decideWebFetch(long, POLICY, new Set()).allow, false)
  const exact = 'https://docs.example.org/search?q=' + 'a'.repeat(100 - 2)
  assert.equal(new URL(exact).search.length - 1, 100)
  assert.equal(decideWebFetch(exact, POLICY, new Set()).allow, true)
})

test('a path segment of 65 characters is denied; 64 is allowed', () => {
  const seg65 = 'a'.repeat(65)
  assert.equal(decideWebFetch(`https://docs.example.org/${seg65}`, POLICY, new Set()).allow, false)
  const seg64 = 'a'.repeat(64)
  assert.equal(decideWebFetch(`https://docs.example.org/${seg64}`, POLICY, new Set()).allow, true)
})

test('a base64-looking path segment is denied', () => {
  const b64 = 'QWxhZGRpbjpvcGVuIHNlc2FtZVNlY3JldFBhc3N3b3JkMTIz'
  const d = decideWebFetch(`https://docs.example.org/${b64}`, POLICY, new Set())
  assert.equal(d.allow, false)
  assert.match(d.reason, /encoded/)
})

test('a long plain-words path segment with no digits or mixed case is allowed', () => {
  const slug = 'how-to-configure-the-reverse-proxy-for-a-small-site'
  assert.equal(decideWebFetch(`https://docs.example.org/${slug}`, POLICY, new Set()).allow, true)
})

test('ftp:// and other non-http schemes are denied', () => {
  assert.equal(decideWebFetch('ftp://docs.example.org/file', POLICY, new Set()).allow, false)
  assert.equal(decideWebFetch('file:///etc/hosts', POLICY, new Set()).allow, false)
  assert.equal(decideWebFetch('javascript:alert(1)', POLICY, new Set()).allow, false)
})

test('a URL with user:pass@ is denied even for a named host', () => {
  const d = decideWebFetch('https://user:pass@docs.example.org/x', POLICY, new Set())
  assert.equal(d.allow, false)
  assert.match(d.reason, /user:pass/)
  assert.equal(decideWebFetch('https://user@docs.example.org/x', POLICY, new Set()).allow, false)
})

test('an unparseable URL is denied', () => {
  assert.equal(decideWebFetch('not a url', POLICY, new Set()).allow, false)
  assert.equal(decideWebFetch('', POLICY, new Set()).allow, false)
})

test('hostsInText finds the lower-case hosts of http(s) URLs, each once', () => {
  const text = 'See https://Docs.Example.org/a, and (http://news.example.net/b). Again https://docs.example.org/c.'
  assert.deepEqual(hostsInText(text).sort(), ['docs.example.org', 'news.example.net'])
  assert.deepEqual(hostsInText('no links here, example.com only'), [])
})

test('hostsFromToolResponse reads the hosts out of a WebSearch response object', () => {
  const response = {
    query: 'q',
    results: [
      { title: 'A', url: 'https://one.example.com/post?x=1' },
      { title: 'B', url: 'http://two.example.net/\nhttps://three.example.io/x' },
    ],
  }
  assert.deepEqual(hostsFromToolResponse(response).sort(), ['one.example.com', 'three.example.io', 'two.example.net'])
  assert.deepEqual(hostsFromToolResponse('plain text https://plain.example.org/a'), ['plain.example.org'])
  assert.deepEqual(hostsFromToolResponse(undefined), [])
})

test('auditLine is one tab-separated line: ts, mode, verdict, URL, reason', () => {
  const line = auditLine('2026-11-14T10:00:00.000Z', 'web', 'https://a.example.com/x', true, 'host named in the question')
  assert.equal(line, '2026-11-14T10:00:00.000Z\tweb\tallow\thttps://a.example.com/x\thost named in the question')
  assert.equal(line.split('\t').length, 5)
  const denied = auditLine('t', 'web', 'https://a.example.com/x', false, 'nope')
  assert.equal(denied.split('\t')[2], 'deny')
})

test('auditLine caps the URL at 500 characters and keeps the line to one line', () => {
  const url = 'https://a.example.com/' + 'x'.repeat(600)
  const line = auditLine('t', 'web', url, false, 'too long\nwith a break')
  const fields = line.split('\t')
  assert.equal(fields[3].length, 500)
  assert.equal(fields[4], 'too long with a break')
  assert.equal(line.includes('\n'), false)
})
