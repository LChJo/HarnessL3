import { createHash } from 'node:crypto'
import { HarnessError } from './errors.js'

export function validUnicode(text: string): boolean {
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(++index)
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false
    } else if (code >= 0xdc00 && code <= 0xdfff) return false
  }
  return true
}

/** RFC 8785: ECMAScript number/string serialization, UTF-16 key order, no normalization. */
export function canonicalJson(value: unknown): string {
  const parents = new Set<object>()
  function encode(input: unknown): string {
    if (input === null) return 'null'
    if (typeof input === 'boolean') return input ? 'true' : 'false'
    if (typeof input === 'string') {
      if (!validUnicode(input)) throw new HarnessError('INVALID_JSON', 'JSON contains invalid Unicode')
      return JSON.stringify(input)
    }
    if (typeof input === 'number') {
      if (!Number.isFinite(input)) throw new HarnessError('INVALID_JSON', 'JSON numbers must be finite')
      return JSON.stringify(input)
    }
    if (typeof input !== 'object') throw new HarnessError('INVALID_JSON', 'Value is not representable as JSON')
    if (parents.has(input)) throw new HarnessError('INVALID_JSON', 'JSON cannot contain a cycle')
    if (!Array.isArray(input) && ![Object.prototype, null].includes(Object.getPrototypeOf(input))) throw new HarnessError('INVALID_JSON', 'JSON requires plain objects')
    parents.add(input)
    let encoded: string
    if (Array.isArray(input)) encoded = '[' + Array.from(input, encode).join(',') + ']'
    else encoded = '{' + Object.keys(input).sort().map(key => encode(key) + ':' + encode((input as Record<string, unknown>)[key])).join(',') + '}'
    parents.delete(input)
    return encoded
  }
  return encode(value)
}

export const sha256 = (bytes: string | Uint8Array): string => createHash('sha256').update(bytes).digest('hex')
export const digest = (kind: string, content: unknown): string => sha256(canonicalJson({ schemaVersion: 1, kind, content }))

/** Parse the JSON grammar before constructing objects so duplicate keys cannot be lost. */
export function parseJsonStrict(input: string): unknown {
  const text = input.startsWith('\ufeff') ? input.slice(1) : input
  let index = 0
  function fail(): never { throw new HarnessError('INVALID_JSON', 'Invalid JSON, duplicate key, or invalid Unicode', { offset: index }) }
  const whitespace = () => { while (index < text.length && /[\x20\x09\x0a\x0d]/.test(text[index])) index++ }
  function string(): string {
    const start = index++
    while (index < text.length) {
      const character = text[index++]
      if (character === '"') {
        let value: string
        try { value = JSON.parse(text.slice(start, index)) as string } catch { return fail() }
        if (!validUnicode(value)) return fail()
        return value
      }
      if (character === '\\') index++
      else if (character.charCodeAt(0) < 0x20) return fail()
    }
    return fail()
  }
  function value(): unknown {
    whitespace()
    const character = text[index]
    if (character === '"') return string()
    if (character === '{') {
      index++; whitespace()
      const object: Record<string, unknown> = {}
      const keys = new Set<string>()
      if (text[index] === '}') { index++; return object }
      while (index < text.length) {
        whitespace()
        if (text[index] !== '"') return fail()
        const key = string()
        if (keys.has(key)) return fail()
        keys.add(key); whitespace()
        if (text[index++] !== ':') return fail()
        Object.defineProperty(object, key, { value: value(), enumerable: true, writable: true, configurable: true })
        whitespace()
        const delimiter = text[index++]
        if (delimiter === '}') return object
        if (delimiter !== ',') return fail()
      }
      return fail()
    }
    if (character === '[') {
      index++; whitespace()
      const result: unknown[] = []
      if (text[index] === ']') { index++; return result }
      while (index < text.length) {
        result.push(value()); whitespace()
        const delimiter = text[index++]
        if (delimiter === ']') return result
        if (delimiter !== ',') return fail()
      }
      return fail()
    }
    for (const [token, parsed] of [['true', true], ['false', false], ['null', null]] as const) {
      if (text.startsWith(token, index)) { index += token.length; return parsed }
    }
    const number = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(text.slice(index))
    if (!number) return fail()
    index += number[0].length
    const result = Number(number[0])
    if (!Number.isFinite(result)) return fail()
    return result
  }
  const parsed = value()
  whitespace()
  if (index !== text.length) return fail()
  return parsed
}
