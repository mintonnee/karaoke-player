import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ERROR_CODES,
  canonicalizeLock,
  digestCanonical,
  getDistributionPolicy,
  isMutableRevision,
  isToolId,
  lockDigest,
  validateArtifactShape,
  validateDistributionPolicy,
  validateLockShape
} from '../../runtime-lock/schema.mjs'
import { assertAllowedUrl, redactUrl } from '../../runtime-lock/hosts.mjs'
import { baseLock } from './helpers.mjs'

const validFile = {
  id: 'yt-dlp',
  kind: 'file',
  version: '2026.08.19',
  platform: 'win32-x64',
  url: 'https://github.com/yt-dlp/yt-dlp/releases/download/2026.08.19/yt-dlp.exe',
  size: 10,
  sha256: 'a'.repeat(64),
  dest: 'resources/bin/yt-dlp.exe',
  source: 'github.com/yt-dlp/yt-dlp',
  license: 'Unlicense'
}

test('schema error on missing fields', () => {
  const errors = validateLockShape({ schemaVersion: 1, kind: 'tools' })
  assert.ok(errors.length > 0)
  assert.ok(
    errors.some((e) => e.code === ERROR_CODES.SCHEMA_ERROR || e.code === ERROR_CODES.BAD_PLATFORM)
  )
})

test('missing hash fails', () => {
  const errors = validateArtifactShape({ ...validFile, sha256: '' })
  assert.equal(
    errors.some((e) => e.code === ERROR_CODES.MISSING_HASH),
    true
  )
})

test('duplicate dest fails', () => {
  const errors = validateLockShape(baseLock('tools', [validFile, { ...validFile, id: 'other' }]))
  assert.equal(
    errors.some((e) => e.code === ERROR_CODES.DUPLICATE_DEST),
    true
  )
})

test('bad size fails', () => {
  const errors = validateArtifactShape({ ...validFile, size: -1 })
  assert.equal(
    errors.some((e) => e.code === ERROR_CODES.BAD_SIZE),
    true
  )
})

test('bad platform fails', () => {
  const errors = validateArtifactShape({ ...validFile, platform: 'darwin-arm64' })
  assert.equal(
    errors.some((e) => e.code === ERROR_CODES.BAD_PLATFORM),
    true
  )
})

test('mutable revision is detected', () => {
  assert.equal(isMutableRevision('main', { requireGitSha: true }), true)
  assert.equal(isMutableRevision('latest', { requireGitSha: true }), true)
  assert.equal(isMutableRevision('a'.repeat(40), { requireGitSha: true }), false)
})

test('disallowed host fails', () => {
  assert.throws(
    () => assertAllowedUrl('http://evil.example/x'),
    (err) => {
      return err.code === ERROR_CODES.DISALLOWED_HOST
    }
  )
  assert.throws(
    () => assertAllowedUrl('https://evil.example/x'),
    (err) => {
      return err.code === ERROR_CODES.DISALLOWED_HOST
    }
  )
})

test('redactUrl strips query and userinfo', () => {
  assert.equal(redactUrl('https://user:pass@github.com/foo?token=abc#x'), 'https://github.com/foo')
})

test('canonical digest is stable under key reorder', () => {
  const a = canonicalizeLock(baseLock('tools', [validFile]))
  const b = canonicalizeLock(baseLock('tools', [validFile]))
  assert.equal(lockDigest(a), digestCanonical(b))
})

test('distribution policy maps each target exactly', () => {
  assert.deepEqual(getDistributionPolicy('nsis'), {
    capabilities: { urlImport: true },
    toolDelivery: { uv: 'download', deno: 'download', 'yt-dlp': 'download' }
  })
  assert.deepEqual(getDistributionPolicy('zip'), {
    capabilities: { urlImport: true },
    toolDelivery: { uv: 'bundled', deno: 'bundled', 'yt-dlp': 'bundled' }
  })
  assert.deepEqual(getDistributionPolicy('appx'), {
    capabilities: { urlImport: false },
    toolDelivery: { uv: 'bundled', deno: 'bundled', 'yt-dlp': 'disabled' }
  })
})

test('distribution policy rejects mismatches and unknown targets', () => {
  assert.equal(
    validateDistributionPolicy(
      'appx',
      { urlImport: true },
      { uv: 'bundled', deno: 'bundled', 'yt-dlp': 'bundled' }
    ).length,
    2
  )
  assert.throws(
    () => getDistributionPolicy('portable'),
    (error) => error.code === ERROR_CODES.SCHEMA_ERROR
  )
})

test('tool ids are closed to the runtime tool set', () => {
  assert.equal(isToolId('uv'), true)
  assert.equal(isToolId('deno'), true)
  assert.equal(isToolId('yt-dlp'), true)
  assert.equal(isToolId('python'), false)
})
