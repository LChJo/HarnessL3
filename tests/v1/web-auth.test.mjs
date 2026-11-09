import test from 'node:test'
import assert from 'node:assert/strict'
import { session, rpc } from '../../web/api.ts'

const original = 'http://127.0.0.1:12345/?history=1#code=fresh-code&worktree=worktree-id&task=task-id&batch=batch-id'
const target = { worktree: 'worktree-id', task: 'task-id', batch: 'batch-id' }
const response = (value, status = 200) => new Response(JSON.stringify(value), { status })
const authenticated = () => response({ authenticated: true })

function browser(t, href = original) {
  const location = { href }
  for (const [name, value] of Object.entries({ location, history: { replaceState(_state, _title, url) { location.href = new URL(url, location.href).href } } })) {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, name)
    Object.defineProperty(globalThis, name, { configurable: true, value })
    t.after(() => { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete globalThis[name] })
  }
  return location
}

test('TC23 interrupted sign-in retains the original code and retries it after reload', async t => {
  const location = browser(t), requests = []
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    requests.push(JSON.parse(options.body))
    if (requests.length === 1) throw new TypeError('fetch failed')
    return authenticated()
  })
  await assert.rejects(session(), { code: 'SIGN_IN_RETRY' })
  assert.equal(location.href, original, 'an unsuccessful sign-in must not discard its only retry credential')
  assert.deepEqual(await session(), target)
  assert.deepEqual(requests, [{ code: 'fresh-code' }, { code: 'fresh-code' }, {}])
  assert.equal(new URL(location.href).hash, '')
  assert.equal(new URL(location.href).searchParams.get('history'), '1')
  for (const [key, value] of Object.entries(target)) assert.equal(new URL(location.href).searchParams.get(key), value)
})

test('TC23 sign-in only clears the code after the browser session has been confirmed', async t => {
  const location = browser(t)
  let release
  const requested = []
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    requested.push(JSON.parse(options.body))
    return new Promise(resolve => { release = resolve })
  })
  const pending = session()
  assert.equal(location.href, original)
  release(authenticated())
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(requested, [{ code: 'fresh-code' }, {}])
  assert.equal(location.href, original, 'issuing a cookie is not proof that the browser accepted it')
  release(authenticated())
  assert.deepEqual(await pending, target)
  assert.equal(new URL(location.href).hash, '')
})

test('TC23 missing browser cookies are reported without claiming a fresh link expired', async t => {
  const location = browser(t)
  let calls = 0
  t.mock.method(globalThis, 'fetch', async () => ++calls === 1 ? authenticated() : response({ error: { code: 'AUTH_REQUIRED', message: 'No browser session', details: { reason: 'session-missing' } } }, 401))
  await assert.rejects(session(), error => error.code === 'AUTH_REQUIRED' && error.details.reason === 'cookie-not-retained' && /Cookie/.test(error.message))
  assert.equal(new URL(location.href).hash, '', 'a consumed code without a browser session cannot be retried')
  assert.equal(new URL(location.href).searchParams.get('task'), target.task)
})

test('TC23 rejected codes retain their target and actual authentication reason', async t => {
  const location = browser(t)
  t.mock.method(globalThis, 'fetch', async () => response({ error: { code: 'AUTH_REQUIRED', message: '登录链接已超过有效期，请重新生成。', details: { reason: 'code-expired' } } }, 401))
  await assert.rejects(session(), error => error.code === 'AUTH_REQUIRED' && error.details.reason === 'code-expired' && /超过有效期/.test(error.message))
  assert.equal(new URL(location.href).hash, '', 'definitively rejected credentials must not remain in the address bar')
  for (const [key, value] of Object.entries(target)) assert.equal(new URL(location.href).searchParams.get(key), value)
})

test('TC23 reopening a cleaned URL checks the existing session without inventing a login code', async t => {
  const location = browser(t, 'http://127.0.0.1:12345/?worktree=worktree-id&task=task-id&batch=batch-id&directory=context')
  const requests = []
  t.mock.method(globalThis, 'fetch', async (_url, options) => { requests.push(JSON.parse(options.body)); return authenticated() })
  assert.deepEqual(await session(), target)
  assert.deepEqual(requests, [{}])
  assert.equal(new URL(location.href).searchParams.get('directory'), 'context')
})

test('TC23 malformed or temporary sign-in responses retain the credential for a user retry', async t => {
  const location = browser(t)
  for (const value of [response({ authenticated: false }), new Response('Unavailable', { status: 503 }), new Response('broken JSON')]) {
    t.mock.method(globalThis, 'fetch', async () => value)
    await assert.rejects(session(), { code: 'SIGN_IN_RETRY' })
    assert.equal(location.href, original)
  }
})

test('TC23 unstructured or unreadable legacy 401 responses remain authentication failures', async t => {
  for (const value of [response({ error: 'Unauthorized' }, 401), new Response('Unauthorized', { status: 401 })]) {
    t.mock.method(globalThis, 'fetch', async () => value)
    await assert.rejects(rpc('project list'), error => error.code === 'AUTH_REQUIRED' && !/访问凭证已失效|登录链接已超过/.test(error.message))
  }
})
