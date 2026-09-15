import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'
import {
  selectRuntimeWheels,
  uvLockDigestFromFile,
  diffWheelSelection
} from '../../runtime-lock/wheels.mjs'
import { readLock, LOCK_FILES } from '../../runtime-lock/verify.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')

test('wheels.lock selection matches uv.lock win32/3.12 hashes', () => {
  const uvPath = resolve(root, 'sidecar', 'uv.lock')
  const selected = selectRuntimeWheels(readFileSync(uvPath, 'utf8'))
  assert.ok(selected.artifacts.length > 0)
  assert.equal(
    selected.artifacts.some((a) => a.id === 'pytest'),
    false
  )
  assert.ok(selected.artifacts.some((a) => a.id === 'torch' && a.version.includes('cu128')))
  assert.ok(selected.artifacts.some((a) => a.id === 'demucs' && a.version === '4.1.0'))
  const digest = uvLockDigestFromFile(uvPath)
  const wheels = readLock(resolve(root, 'build', 'locks'), LOCK_FILES.wheels).json
  const diff = diffWheelSelection(wheels, readFileSync(uvPath, 'utf8'), digest)
  assert.deepEqual(diff.errors, [])
})

test('tampering uv.lock digest makes verify selection fail', () => {
  const uvPath = resolve(root, 'sidecar', 'uv.lock')
  const wheels = readLock(resolve(root, 'build', 'locks'), LOCK_FILES.wheels).json
  const diff = diffWheelSelection(wheels, readFileSync(uvPath, 'utf8'), 'sha256:' + '0'.repeat(64))
  assert.ok(diff.errors.some((e) => e.includes('uvLockDigest mismatch')))
})
