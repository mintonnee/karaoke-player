import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { prepareResources } from '../../runtime-lock/prepare.mjs'
import { sha256Hex } from '../../runtime-lock/schema.mjs'
import { uvLockDigestFromBytes } from '../../runtime-lock/wheels.mjs'
import { startStaticServer, tempDir, writeMiniSidecar, baseLock } from './helpers.mjs'

test('prepare-resources writes dest only after hash match', async () => {
  const good = Buffer.from('uv-payload-ok')
  const srv = await startStaticServer({ '/uv.exe': good })
  const root = tempDir('prep-')
  writeMiniSidecar(root)
  const uvLock = readFileSync(join(root, 'sidecar', 'uv.lock'))
  const digest = uvLockDigestFromBytes(uvLock)
  const locksDir = join(root, 'build', 'locks')
  mkdirSync(locksDir, { recursive: true })
  const tools = baseLock('tools', [
    {
      id: 'uv',
      kind: 'file',
      version: '0.12.9',
      platform: 'win32-x64',
      url: 'https://github.com/astral-sh/uv/releases/download/0.12.9/uv.exe',
      size: good.length,
      sha256: sha256Hex(good),
      dest: 'resources/bin/uv.exe',
      source: 'github.com/astral-sh/uv',
      license: 'MIT',
      capability: 'always'
    }
  ])
  const python = {
    ...baseLock('python', [
      {
        id: 'cpython',
        kind: 'file',
        version: '3.12.14',
        platform: 'win32-x64',
        url: 'https://github.com/astral-sh/python-build-standalone/releases/download/x/p.exe',
        size: 4,
        sha256: 'b'.repeat(64),
        dest: 'runtimes/python.exe',
        source: 'github.com/astral-sh/python-build-standalone',
        license: 'PSF-2.0'
      }
    ]),
    python: {
      requiresMajorMinor: '3.12',
      implementation: 'cpython',
      patch: '3.12.14',
      distributionBuild: '20260901'
    }
  }
  const models = {
    ...baseLock('models', [
      {
        id: 'cfg',
        kind: 'file',
        version: '1',
        revision: '0a363e9161cbc7ed1431c9597a8ceaf0c4f78fcf',
        platform: 'win32-x64',
        url: 'https://huggingface.co/mobiuslabsgmbh/faster-whisper-large-v3-turbo/resolve/0a363e9161cbc7ed1431c9597a8ceaf0c4f78fcf/config.json',
        size: 4,
        sha256: 'c'.repeat(64),
        dest: 'models/config.json',
        source: 'huggingface.co/mobiuslabsgmbh/faster-whisper-large-v3-turbo',
        license: 'MIT'
      }
    ]),
    models: []
  }
  const wheels = {
    ...baseLock('wheels', []),
    uvLockDigest: digest,
    python: { requiresMajorMinor: '3.12', implementation: 'cpython' }
  }
  writeFileSync(join(locksDir, 'tools.lock.json'), JSON.stringify(tools))
  writeFileSync(join(locksDir, 'python.lock.json'), JSON.stringify(python))
  writeFileSync(join(locksDir, 'models.lock.json'), JSON.stringify(models))
  writeFileSync(join(locksDir, 'wheels.lock.json'), JSON.stringify(wheels))

  await prepareResources({
    root,
    locksDir,
    cacheRoot: join(root, 'cache'),
    fetchImpl: () => globalThis.fetch(srv.url('/uv.exe')),
    log: () => {}
  })
  const dest = join(root, 'resources', 'bin', 'uv.exe')
  assert.equal(existsSync(dest), true)
  assert.equal(readFileSync(dest).equals(good), true)
  assert.equal(existsSync(join(root, 'resources', 'sidecar', 'pyproject.toml')), true)
  await srv.close()
})

test('prepare-resources does not write dest when hash mismatches', async () => {
  const good = Buffer.from('expected-bytes')
  const bad = Buffer.from('tampered-byte!')
  const srv = await startStaticServer({ '/uv.exe': bad })
  const root = tempDir('prep-bad-')
  writeMiniSidecar(root)
  const digest = uvLockDigestFromBytes(readFileSync(join(root, 'sidecar', 'uv.lock')))
  const locksDir = join(root, 'build', 'locks')
  mkdirSync(locksDir, { recursive: true })
  writeFileSync(
    join(locksDir, 'tools.lock.json'),
    JSON.stringify(
      baseLock('tools', [
        {
          id: 'uv',
          kind: 'file',
          version: '0.12.9',
          platform: 'win32-x64',
          url: 'https://github.com/astral-sh/uv/releases/download/0.12.9/uv.exe',
          size: good.length,
          sha256: sha256Hex(good),
          dest: 'resources/bin/uv.exe',
          source: 'github.com/astral-sh/uv',
          license: 'MIT',
          capability: 'always'
        }
      ])
    )
  )
  writeFileSync(
    join(locksDir, 'python.lock.json'),
    JSON.stringify({
      ...baseLock('python', [
        {
          id: 'cpython',
          kind: 'file',
          version: '3.12.14',
          platform: 'win32-x64',
          url: 'https://github.com/astral-sh/python-build-standalone/releases/download/x/p.exe',
          size: 4,
          sha256: 'b'.repeat(64),
          dest: 'runtimes/python.exe',
          source: 'github.com/astral-sh/python-build-standalone',
          license: 'PSF-2.0'
        }
      ]),
      python: {
        requiresMajorMinor: '3.12',
        implementation: 'cpython',
        patch: '3.12.14',
        distributionBuild: '20260901'
      }
    })
  )
  writeFileSync(
    join(locksDir, 'models.lock.json'),
    JSON.stringify({ ...baseLock('models', []), models: [] })
  )
  writeFileSync(
    join(locksDir, 'wheels.lock.json'),
    JSON.stringify({
      ...baseLock('wheels', []),
      uvLockDigest: digest,
      python: { requiresMajorMinor: '3.12', implementation: 'cpython' }
    })
  )

  await assert.rejects(() =>
    prepareResources({
      root,
      locksDir,
      cacheRoot: join(root, 'cache'),
      fetchImpl: () => globalThis.fetch(srv.url('/uv.exe')),
      log: () => {}
    })
  )
  assert.equal(existsSync(join(root, 'resources', 'bin', 'uv.exe')), false)
  await srv.close()
})
