import test from 'node:test'
import assert from 'node:assert/strict'
import { startServer } from '../../build/service/main.js'
import { fixture } from './helpers.mjs'

test('TC23 sign-in distinguishes missing, invalid and expired codes while retaining session and origin boundaries', async t => {
  let running, service
  t.after(async () => {
    if (!service) return
    await fetch(service.url + '/stop', { method: 'POST', headers: { authorization: 'Bearer ' + service.token } })
    await running
  })
  const f = await fixture(t, 'harnessl3-session-recovery-')
  service = await new Promise((resolve, reject) => { running = startServer(f.dataRoot, 0, resolve); running.catch(reject) })
  const issue = () => fetch(service.url + '/browser-session', { method: 'POST', headers: { authorization: 'Bearer ' + service.token } }).then(value => value.json())
  const login = (value, cookie, origin = service.url) => fetch(service.url + '/session', { method: 'POST', headers: { origin, 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: JSON.stringify(value) })
  const rejected = async (value, reason) => {
    const result = await login(value)
    assert.equal(result.status, 401)
    const error = (await result.json()).error
    assert.equal(error.code, 'AUTH_REQUIRED')
    assert.equal(error.details.reason, reason)
    assert.ok(!JSON.stringify(error).includes(value.code || 'impossible-sensitive-code'))
  }
  await rejected({}, 'session-missing')
  await rejected({ code: 'unknown-code' }, 'code-invalid-or-used')
  const fresh = await issue()
  const signedIn = await login({ code: fresh.code })
  assert.equal(signedIn.status, 200)
  const cookie = signedIn.headers.get('set-cookie').split(';')[0]
  await rejected({ code: fresh.code }, 'code-invalid-or-used')
  const expired = await issue()
  const clock = t.mock.method(Date, 'now', () => Date.parse(expired.expiresAt) + 1)
  try {
    await rejected({ code: expired.code }, 'code-expired')
    const reused = await login({ code: expired.code }, cookie)
    assert.equal(reused.status, 200, 'a valid browser session still works after code expiry')
    assert.equal(reused.headers.get('set-cookie'), null, 'checking sign-in must not rotate or extend the session')
  } finally { clock.mock.restore() }
  assert.equal((await login({}, cookie)).status, 200)
  assert.equal((await login({}, cookie, 'https://example.invalid')).status, 403)
})
