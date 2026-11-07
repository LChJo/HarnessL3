import { existsSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { Ajv2020 } from 'ajv/dist/2020.js'
import type { FormatsPlugin } from 'ajv-formats'
import { SCHEMA_ROOT } from './package.js'
import { parseJsonStrict } from './json.js'
import { HarnessError } from './errors.js'

const ajv = new Ajv2020({ allErrors: true, strict: false, validateFormats: true })
const addFormats = createRequire(import.meta.url)('ajv-formats') as FormatsPlugin
addFormats(ajv)
for (const name of readdirSync(SCHEMA_ROOT).filter(name => name.endsWith('.schema.json'))) {
  ajv.addSchema(parseJsonStrict(readFileSync(path.join(SCHEMA_ROOT, name), 'utf8')) as object)
}
export function validateContract<T>(name: string, value: unknown): T {
  if (value && typeof value === 'object' && 'schemaVersion' in value && value.schemaVersion !== 1) throw new HarnessError('UNSUPPORTED_SCHEMA', 'Only schemaVersion 1 is supported')
  const validate = ajv.getSchema(`https://harnessl3.local/spec/v1/${name}.schema.json`)
  if (!validate) throw new HarnessError('INTERNAL_ERROR', 'Unknown contract', { name })
  if (!validate(value)) {
    const example = path.join(SCHEMA_ROOT, 'examples', `${name}.json`)
    throw new HarnessError('SCHEMA_INVALID', 'Request does not match its v1 contract', {
      schema: name,
      ...(existsSync(example) ? { example } : {}),
      diagnostics: validate.errors?.map(error => ({ path: error.instancePath, keyword: error.keyword, message: error.message ?? 'Invalid value' })) ?? [],
    })
  }
  return value as T
}
