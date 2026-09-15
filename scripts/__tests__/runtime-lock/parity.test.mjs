import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { validateArtifactShape, validateLockShape } from '../../runtime-lock/schema.mjs'
import { validateArtifactRuntime } from '../../runtime-lock/verify.mjs'

const dir = dirname(fileURLToPath(import.meta.url))

function loadCases(kind) {
  const base = join(dir, 'fixtures', 'parity', kind)
  return readdirSync(base)
    .filter((name) => name.endsWith('.json'))
    .map((name) => ({ name, data: JSON.parse(readFileSync(join(base, name), 'utf8')) }))
}

function evaluate(data) {
  if (data.lock) return validateLockShape(data.lock)
  const shape = validateArtifactShape(data.entry)
  const runtime = validateArtifactRuntime(data.entry, 'models')
  return [...shape, ...runtime]
}

for (const { name, data } of loadCases('accept')) {
  test(`parity accept ${name}`, () => {
    const errors = evaluate(data)
    assert.deepEqual(errors, [], errors.map((e) => e.message).join('\n'))
  })
}

for (const { name, data } of loadCases('reject')) {
  test(`parity reject ${name}`, () => {
    const errors = evaluate(data)
    assert.ok(errors.length > 0, 'expected rejection')
    assert.equal(
      errors.some((e) => e.code === data.expected.reasonCode),
      true,
      `expected ${data.expected.reasonCode} got ${errors.map((e) => e.code).join(',')}`
    )
  })
}
