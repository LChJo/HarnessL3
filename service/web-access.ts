import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import path from 'node:path'
import { validateUuid } from '../cli/args.js'
import { HarnessError } from '../core/errors.js'
import { isErrno, readJson, writeJson } from '../core/io.js'
import { validateServiceFile } from './controller.js'

export const WEB_LINK_TTL_MS = 24 * 60 * 60_000

type WebAccessState = { key: string; port: number | null }
export type LinkTarget = { worktree?: string; task?: string; batch?: string }
type Link = { expires: number; target: LinkTarget; nonce: string }
type Cookie = { expires: number }

export function linkTarget(input: unknown): LinkTarget {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new HarnessError('INVALID_ARGUMENT', 'Expected a Web link target')
  const fields = input as Record<string, unknown>
  const target: LinkTarget = {}
  for (const name of ['worktree', 'task', 'batch'] as const) {
    const value = fields[name]
    if (value === undefined) continue
    if (typeof value !== 'string') throw new HarnessError('INVALID_ARGUMENT', 'Expected a Web link target UUID', { field: name })
    target[name] = validateUuid(value, name)
  }
  if ((target.task && !target.worktree) || (target.batch && !target.task)) throw new HarnessError('INVALID_ARGUMENT', 'A Web link needs the complete parent target')
  return target
}

export async function loadWebAccess(dataRoot: string) {
  const file = path.join(dataRoot, 'web-access.json')
  await validateServiceFile(file)
  let state: WebAccessState
  try { state = await readJson<WebAccessState>(file) }
  catch (error) {
    if (!isErrno(error, 'ENOENT')) throw error
    state = { key: randomBytes(32).toString('hex'), port: null }
  }
  if (!state || typeof state.key !== 'string' || !/^[a-f0-9]{64}$/.test(state.key) ||
      (state.port !== null && (!Number.isInteger(state.port) || state.port < 1 || state.port > 65535))) {
    throw new HarnessError('SERVICE_CONFLICT', 'The Web access metadata is invalid', { file })
  }
  const key = Buffer.from(state.key, 'hex')
  type Credential = 'link' | 'cookie'
  const sign = (kind: Credential, origin: string, payload: string) => createHmac('sha256', key).update(`harnessl3-web-v1:${kind}:${origin}:${payload}`).digest()
  const encode = (kind: Credential, origin: string, value: Link | Cookie) => {
    const payload = Buffer.from(JSON.stringify(value)).toString('base64url')
    return payload + '.' + sign(kind, origin, payload).toString('base64url')
  }
  const decode = <T extends Link | Cookie>(kind: Credential, origin: string, value: string): T | null => {
    const match = /^([A-Za-z0-9_-]{1,512})\.([A-Za-z0-9_-]{43})$/.exec(value)
    if (!match) return null
    // Comparing the canonical signature also rejects alternate base64 encodings.
    if (!timingSafeEqual(Buffer.from(match[2]), Buffer.from(sign(kind, origin, match[1]).toString('base64url')))) return null
    return JSON.parse(Buffer.from(match[1], 'base64url').toString('utf8')) as T
  }
  return {
    port: state.port,
    async rememberPort(port: number) {
      if (port !== state.port) await writeJson(file, { ...state, port })
    },
    issue(origin: string, target: LinkTarget) {
      const expires = Date.now() + WEB_LINK_TTL_MS
      return { code: encode('link', origin, { expires, target, nonce: randomBytes(16).toString('hex') }),
        oneTime: false, expiresAt: new Date(expires).toISOString(), browserSessionTtlMs: WEB_LINK_TTL_MS }
    },
    verifyLink: (origin: string, code: string) => decode<Link>('link', origin, code),
    cookieExpiry(origin: string, header: string | undefined) {
      const value = /(?:^|;\s*)harnessl3_session=([^;]+)(?:;|$)/.exec(header ?? '')?.[1]
      return value ? decode<Cookie>('cookie', origin, value)?.expires : undefined
    },
    cookie(origin: string, expires: number, now: number) {
      const maxAge = Math.ceil((expires - now) / 1000)
      return `harnessl3_session=${encode('cookie', origin, { expires })}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}`
    },
  }
}
