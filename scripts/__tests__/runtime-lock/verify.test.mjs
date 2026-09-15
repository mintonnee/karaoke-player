import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readFileSync, statSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ERROR_CODES } from '../../runtime-lock/schema.mjs'
import { verifyLocks, assertLocksUnchanged, LOCK_FILES } from '../../runtime-lock/verify.mjs'
import { proposeLocks } from '../../runtime-lock/propose.mjs'
import { baseLock, tempDir, writeMiniSidecar } from './helpers.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')

const valid = {
  id: 'uv',
  kind: 'file',
  version: '0.12.9',
  platform: 'win32-x64',
  url: 'https://github.com/astral-sh/uv/releases/download/0.12.9/uv.exe',
  size: 4,
  sha256: 'a'.repeat(64),
  dest: 'resources/bin/uv.exe',
  source: 'github.com/astral-sh/uv',
  license: 'MIT'
}

function writeLocks(root, overrides = {}) {
  writeMiniSidecar(root)
  const locksDir = join(root, 'build', 'locks')
  mkdirSync(locksDir, { recursive: true })
  const files = {
    tools: baseLock('tools', [valid]),
    python: {
      ...baseLock('python', [
        {
          ...valid,
          id: 'cpython',
          dest: 'runtimes/python.exe',
          url: 'https://github.com/astral-sh/python-build-standalone/releases/download/x/p.tar.gz',
          kind: 'archive',
          archive: {
            format: 'tar.gz',
            files: [
              { path: 'python/python.exe', size: 4, sha256: 'b'.repeat(64), executable: true }
            ]
          }
        }
      ]),
      python: {
        requiresMajorMinor: '3.12',
        implementation: 'cpython',
        patch: '3.12.14',
        distributionBuild: '20260901'
      }
    },
    models: {
      ...baseLock('models', [
        {
          ...valid,
          id: 'whisper-config',
          dest: 'models/config.json',
          url:
            'https://huggingface.co/mobiuslabsgmbh/faster-whisper-large-v3-turbo/resolve/' +
            '0a363e9161cbc7ed1431c9597a8ceaf0c4f78fcf/config.json',
          revision: '0a363e9161cbc7ed1431c9597a8ceaf0c4f78fcf'
        }
      ]),
      models: [
        {
          id: 'large-v3-turbo',
          loader: 'faster_whisper.WhisperModel',
          loaderBinding: { package: 'faster_whisper', symbol: 'WhisperModel' },
          revision: '0a363e9161cbc7ed1431c9597a8ceaf0c4f78fcf',
          repo: 'mobiuslabsgmbh/faster-whisper-large-v3-turbo',
          license: 'MIT',
          artifactIds: ['whisper-config'],
          dependsOn: []
        }
      ]
    },
    wheels: {
      ...baseLock('wheels', []),
      uvLockDigest: 'sha256:' + '1'.repeat(64),
      python: { requiresMajorMinor: '3.12', implementation: 'cpython' }
    },
    ...overrides
  }
  for (const [kind, body] of Object.entries(files)) {
    writeFileSync(join(locksDir, `${kind}.lock.json`), JSON.stringify(body, null, 2))
  }
  return locksDir
}

test('schema errors, missing hash, duplicate paths, bad size, bad platform, mutable revision, disallowed host fail', () => {
  const root = tempDir()
  writeLocks(root, {
    tools: baseLock('tools', [
      { ...valid, sha256: '' },
      { ...valid, id: 'dup', dest: 'resources/bin/uv.exe' },
      { ...valid, id: 'size', dest: 'resources/bin/s.exe', size: -3 },
      { ...valid, id: 'plat', dest: 'resources/bin/p.exe', platform: 'linux-x64' },
      {
        ...valid,
        id: 'hf',
        dest: 'models/x.bin',
        url: 'https://huggingface.co/foo/bar/resolve/main/x.bin',
        revision: 'main'
      },
      {
        ...valid,
        id: 'host',
        dest: 'resources/bin/h.exe',
        url: 'https://evil.example/h.exe'
      }
    ])
  })
  const result = verifyLocks({ root })
  const codes = new Set(result.errors.map((e) => e.code))
  assert.equal(codes.has(ERROR_CODES.MISSING_HASH), true)
  assert.equal(codes.has(ERROR_CODES.DUPLICATE_DEST), true)
  assert.equal(codes.has(ERROR_CODES.BAD_SIZE), true)
  assert.equal(codes.has(ERROR_CODES.BAD_PLATFORM), true)
  assert.equal(codes.has(ERROR_CODES.MUTABLE_REVISION), true)
  assert.equal(codes.has(ERROR_CODES.DISALLOWED_HOST), true)
  assert.equal(result.ok, false)
})

test('verify does not mutate lock files', () => {
  const snapshots = Object.values(LOCK_FILES).map((name) => {
    const path = join(repoRoot, 'build', 'locks', name)
    return { path, mtimeMs: statSync(path).mtimeMs, bytes: readFileSync(path) }
  })
  verifyLocks({ root: repoRoot })
  const mutated = assertLocksUnchanged(snapshots)
  assert.deepEqual(mutated, [])
})

test('propose writes only to --output and leaves build/locks unchanged', () => {
  const before = Object.values(LOCK_FILES).map((name) => {
    const path = join(repoRoot, 'build', 'locks', name)
    return { path, mtimeMs: statSync(path).mtimeMs, bytes: readFileSync(path) }
  })
  const output = tempDir('cand-')
  proposeLocks({ root: repoRoot, output })
  assert.equal(statSync(join(output, 'SUMMARY.md')).isFile(), true)
  assert.equal(statSync(join(output, 'tools.lock.json')).isFile(), true)
  const mutated = assertLocksUnchanged(before)
  assert.deepEqual(mutated, [])
})
