import { existsSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { Ajv2020, type ErrorObject } from 'ajv/dist/2020.js'
import type { FormatsPlugin } from 'ajv-formats'
import { SCHEMA_ROOT } from './package.js'
import { parseJsonStrict } from './json.js'
import { HarnessError } from './errors.js'

const ajv = new Ajv2020({ allErrors: true, strict: false, validateFormats: true })
const addFormats = createRequire(import.meta.url)('ajv-formats') as FormatsPlugin
addFormats(ajv)
let knownDescription: string | undefined
for (const name of readdirSync(SCHEMA_ROOT).filter(name => name.endsWith('.schema.json'))) {
  const schema = parseJsonStrict(readFileSync(path.join(SCHEMA_ROOT, name), 'utf8')) as { $defs?: { known?: { description?: string } } }
  ajv.addSchema(schema)
  if (name === 'common.schema.json') knownDescription = schema.$defs?.known?.description
}
function diagnostic(name: string, error: ErrorObject) {
  const property = error.keyword === 'required' ? error.params.missingProperty
    : error.keyword === 'additionalProperties' ? error.params.additionalProperty
    : error.propertyName ?? (error.keyword === 'propertyNames' ? error.params.propertyName : undefined)
  const location = error.instancePath + (typeof property === 'string' ? '/' + property.replace(/~/g, '~0').replace(/\//g, '~1') : '')
  const knownPath = name === 'selection' || name === 'selection-input' ? '/context/known' : name === 'query' || name === 'query-input' ? '/known' : null
  const hint = knownPath && (location === knownPath || location.startsWith(knownPath + '/')) ? knownDescription : undefined
  return { path: location, keyword: error.keyword, message: error.message ?? 'Invalid value', schemaPath: error.schemaPath, params: error.params, ...(hint ? { hint } : {}) }
}
export function validateContract<T>(name: string, value: unknown): T {
  if (value && typeof value === 'object' && 'schemaVersion' in value && value.schemaVersion !== 1) throw new HarnessError('UNSUPPORTED_SCHEMA', 'Only schemaVersion 1 is supported')
  const validate = ajv.getSchema(`https://harnessl3.local/spec/v1/${name}.schema.json`)
  if (!validate) throw new HarnessError('INTERNAL_ERROR', 'Unknown contract', { name })
  if (!validate(value)) {
    const example = path.join(SCHEMA_ROOT, 'examples', `${name}.json`)
    const diagnostics = validate.errors?.map(error => diagnostic(name, error)) ?? []
    const first = diagnostics[0]
    throw new HarnessError('SCHEMA_INVALID', 'Request does not match its v1 contract' + (first ? `: ${first.path || '/'} ${first.message}` : ''), {
      schema: name,
      schemaFile: path.join(SCHEMA_ROOT, `${name}.schema.json`),
      ...(existsSync(example) ? { example } : {}),
      diagnostics,
    })
  }
  return value as T
}
