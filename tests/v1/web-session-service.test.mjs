import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { startServer } from '../../build/service/main.js'
import { fixture } from './helpers.mjs'

const DAY = 86_400_000

test('TC23 signed links retain their independent 24-hour deadlines across browsers and service restart', async t => {
  const f = await fixture(t, 'harnessl3-web-link-')
  const other = await fixture(t, 'harnessl3-other-web-link-')
  let running, service
  const start = (root = f.dataRoot) => new Promise((resolve, reject) => { running = startServer(root, 0, resolve); running.catch(reject) })
  const stop = async () => {
    if (!service) return
    await fetch(service.url + '/stop', { method: 'POST', headers: { authorization: 'Bearer ' + service.token } })
    await running
    service = undefined
  }
  service = await start()
  const origin = service.url
  const target = { worktree: randomUUID(), task: randomUUID() }
  const issue = async (destination = target) => {
    const result = await fetch(service.url + '/browser-session', {
      method: 'POST', headers: { authorization: 'Bearer ' + service.token, 'content-type': 'application/json' }, body: JSON.stringify(destination),
    })
    assert.equal(result.status, 200)
    return result.json()
  }
  const login = (value, cookie, requestOrigin = service.url) => fetch(service.url + '/session', {
    method: 'POST', headers: { origin: requestOrigin, 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: JSON.stringify(value),
  })
  const rejected = async (value, reason, cookie) => {
    const result = await login(value, cookie)
    assert.equal(result.status, 401)
    const error = (await result.json()).error
    assert.equal(error.code, 'AUTH_REQUIRED')
    assert.equal(error.details.reason, reason)
    assert.ok(!JSON.stringify(error).includes(value.code || 'impossible-sensitive-code'))
  }
  const cookieFrom = result => {
    assert.equal(result.status, 200)
    return result.headers.get('set-cookie').split(';')[0]
  }

  let now = Date.now()
  const clock = t.mock.method(Date, 'now', () => now)
  try {
    const original = await issue()
    assert.equal(original.oneTime, false)
    assert.equal(original.browserSessionTtlMs, DAY)
    assert.equal(Date.parse(original.expiresAt), now + DAY)
    const originalRequest = { ...target, code: original.code }
    await rejected({}, 'session-missing')
    await rejected({ ...target, code: 'unknown-code' }, 'code-invalid-or-used')
    await rejected({ ...originalRequest, task: randomUUID() }, 'target-mismatch')
    assert.equal((await login(originalRequest, undefined, 'https://example.invalid')).status, 403)
    const originalCookie = cookieFrom(await login(originalRequest))
    now += 6 * 60_000
    assert.equal((await login(originalRequest)).status, 200, 'another browser can open a link after five minutes')
    const reopened = await login(originalRequest, originalCookie)
    assert.equal(reopened.status, 200)
    assert.equal(reopened.headers.get('set-cookie'), null)

    now += 8 * 3600_000
    const later = await issue()
    assert.equal(Date.parse(later.expiresAt), now + DAY)
    const laterRequest = { ...target, code: later.code }
    const laterCookie = cookieFrom(await login(laterRequest, originalCookie))
    assert.equal((await login(originalRequest, laterCookie)).headers.get('set-cookie'), null, 'an older link does not replace a newer authorization')

    await stop()
    service = await start(other.dataRoot)
    await rejected(originalRequest, 'code-invalid-or-used')
    await rejected({}, 'session-missing', originalCookie)
    await stop()
    service = await start()
    assert.equal(service.url, origin)
    assert.equal((await login({}, originalCookie)).status, 200, 'the clean URL can refresh after restart')
    assert.equal((await login(originalRequest)).status, 200, 'the original link works after restart without cookies')

    now = Date.parse(original.expiresAt)
    await rejected(originalRequest, 'code-expired', laterCookie)
    await rejected({}, 'session-expired', originalCookie)
    assert.equal((await login(laterRequest, originalCookie)).status, 200, 'the earlier deadline does not cut short a new link')
    assert.equal((await login({}, laterCookie)).status, 200)
    now = Date.parse(later.expiresAt)
    await rejected(laterRequest, 'code-expired')
    await rejected({}, 'session-expired', laterCookie)
  } finally {
    clock.mock.restore()
    await stop()
  }
})
