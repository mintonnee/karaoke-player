import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { verifyPackage } from '../../runtime-lock/package.mjs'
import { ERROR_CODES } from '../../runtime-lock/schema.mjs'
import { tempDir } from './helpers.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const locksDir = join(repoRoot, 'build', 'locks')

function layout(names) {
  const input = tempDir('pkg-')
  mkdirSync(join(input, 'resources', 'bin'), { recursive: true })
  mkdirSync(join(input, 'resources', 'sidecar'), { recursive: true })
  writeFileSync(join(input, 'resources', 'sidecar', 'pyproject.toml'), '')
  writeFileSync(join(input, 'resources', 'sidecar', 'uv.lock'), '')
  for (const name of names) writeFileSync(join(input, 'resources', 'bin', name), 'x')
  return input
}

test('zip layout includes yt-dlp', () => {
  const input = layout(['uv.exe', 'yt-dlp.exe', 'deno.exe'])
  const result = verifyPackage({ target: 'zip', input, locksDir })
  assert.equal(result.ok, true, result.errors.map((e) => e.message).join('\n'))
})

test('appx layout without yt-dlp is OK', () => {
  const input = layout(['uv.exe', 'deno.exe'])
  const result = verifyPackage({ target: 'appx', input, locksDir })
  assert.equal(result.ok, true, result.errors.map((e) => e.message).join('\n'))
})

test('missing uv.exe is error', () => {
  const input = layout(['yt-dlp.exe', 'deno.exe'])
  const result = verifyPackage({ target: 'zip', input, locksDir })
  assert.equal(result.ok, false)
  assert.equal(
    result.errors.some((e) => e.id === 'uv'),
    true
  )
})

test('extra unsigned unexpected exe is error', () => {
  const input = layout(['uv.exe', 'yt-dlp.exe', 'deno.exe', 'hack.exe'])
  const result = verifyPackage({ target: 'zip', input, locksDir })
  assert.equal(result.ok, false)
  assert.equal(
    result.errors.some((e) => e.code === ERROR_CODES.UNEXPECTED_EXECUTABLE),
    true
  )
})
