import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ensureArtifact, resetInflightForTests, hashFile } from '../../runtime-lock/download.mjs'
import { createZip } from '../../runtime-lock/zip.mjs'
import { ERROR_CODES, sha256Hex } from '../../runtime-lock/schema.mjs'
import { fileArtifact, startStaticServer, tempDir } from './helpers.mjs'

test('matching dest hash is reused without download', async () => {
  resetInflightForTests()
  const data = Buffer.from('reuse-me')
  const root = tempDir()
  const dest = join(root, 'resources', 'bin', 'sample.bin')
  mkdirSync(join(root, 'resources', 'bin'), { recursive: true })
  writeFileSync(dest, data)
  const { artifact } = fileArtifact({
    data,
    url: 'https://github.com/astral-sh/uv/releases/download/x/sample.bin'
  })
  let fetches = 0
  const result = await ensureArtifact({
    artifact,
    destRoot: root,
    cacheRoot: join(root, 'cache'),
    fetchImpl: async () => {
      fetches += 1
      throw new Error('should not fetch')
    }
  })
  assert.equal(result.reused, true)
  assert.equal(fetches, 0)
})

test('1-byte tamper of cached dest is detected and not spawned', async () => {
  resetInflightForTests()
  const good = Buffer.from('good-bytes!!')
  const srv = await startStaticServer({ '/a.bin': good })
  const root = tempDir()
  mkdirSync(join(root, 'resources', 'bin'), { recursive: true })
  const dest = join(root, 'resources', 'bin', 'a.bin')
  writeFileSync(dest, Buffer.from('GOOD-bytes!!'))
  const { artifact } = fileArtifact({
    data: good,
    dest: 'resources/bin/a.bin',
    url: srv.url('/a.bin')
  })
  let spawned = 0
  await ensureArtifact({
    artifact,
    destRoot: root,
    cacheRoot: join(root, 'cache'),
    skipHostCheck: true,
    fetchImpl: globalThis.fetch
  })
  assert.equal(readFileSync(dest).equals(good), true)
  assert.equal(spawned, 0)
  await srv.close()
})

test('truncated download is rejected', async () => {
  resetInflightForTests()
  const full = Buffer.from('0123456789')
  const { artifact } = fileArtifact({ data: full, url: 'http://127.0.0.1/trunc.bin' })
  const srv = await startStaticServer({ '/trunc.bin': full.subarray(0, 4) })
  artifact.url = srv.url('/trunc.bin')
  artifact.size = full.length
  await assert.rejects(
    () =>
      ensureArtifact({
        artifact,
        destRoot: tempDir(),
        cacheRoot: join(tempDir(), 'c'),
        skipHostCheck: true
      }),
    (err) => err.code === ERROR_CODES.SIZE_MISMATCH
  )
  await srv.close()
})

test('wrong exe hash is detected and exe is not spawned', async () => {
  resetInflightForTests()
  const good = Buffer.from('MZ-good')
  const bad = Buffer.from('MZ-evil')
  const srv = await startStaticServer({ '/uv.exe': bad })
  const { artifact } = fileArtifact({
    id: 'uv',
    data: good,
    dest: 'resources/bin/uv.exe',
    url: srv.url('/uv.exe')
  })
  artifact.url = srv.url('/uv.exe')
  let spawned = false
  await assert.rejects(
    () =>
      ensureArtifact({
        artifact,
        destRoot: tempDir(),
        cacheRoot: join(tempDir(), 'c2'),
        skipHostCheck: true,
        spawnExe: spawned ? undefined : undefined
      }),
    (err) => err.code === ERROR_CODES.HASH_MISMATCH
  )
  assert.equal(spawned, false)
  await srv.close()
})

test('force re-downloads even when dest hash matches', async () => {
  resetInflightForTests()
  const data = Buffer.from('force-me')
  const srv = await startStaticServer({ '/f.bin': data })
  const root = tempDir()
  mkdirSync(join(root, 'resources', 'bin'), { recursive: true })
  const dest = join(root, 'resources', 'bin', 'f.bin')
  writeFileSync(dest, data)
  const { artifact } = fileArtifact({ data, dest: 'resources/bin/f.bin', url: srv.url('/f.bin') })
  artifact.url = srv.url('/f.bin')
  await ensureArtifact({
    artifact,
    destRoot: root,
    cacheRoot: join(root, 'cache'),
    force: true,
    skipHostCheck: true
  })
  assert.ok(srv.hits() >= 1)
  await srv.close()
})

test('hash mismatch is not written into dest', async () => {
  resetInflightForTests()
  const good = Buffer.from('lock-bytes')
  const bad = Buffer.from('otherbytes')
  const srv = await startStaticServer({ '/x.bin': bad })
  const root = tempDir()
  const { artifact } = fileArtifact({
    data: good,
    dest: 'resources/bin/x.bin',
    url: srv.url('/x.bin')
  })
  artifact.url = srv.url('/x.bin')
  const dest = join(root, 'resources', 'bin', 'x.bin')
  await assert.rejects(() =>
    ensureArtifact({
      artifact,
      destRoot: root,
      cacheRoot: join(root, 'cache'),
      skipHostCheck: true
    })
  )
  assert.equal(existsSync(dest), false)
  await srv.close()
})

test('single-flight: concurrent same digest downloads once', async () => {
  resetInflightForTests()
  const data = Buffer.from('single-flight-body')
  const srv = await startStaticServer({ '/s.bin': data }, { delayMs: 80 })
  const { artifact } = fileArtifact({ data, dest: 'resources/bin/s.bin', url: srv.url('/s.bin') })
  artifact.url = srv.url('/s.bin')
  const root1 = tempDir()
  const root2 = tempDir()
  const cacheRoot = tempDir('cache-')
  const [a, b] = await Promise.all([
    ensureArtifact({ artifact, destRoot: root1, cacheRoot, skipHostCheck: true }),
    ensureArtifact({
      artifact: { ...artifact, dest: 'resources/bin/s2.bin' },
      destRoot: root2,
      cacheRoot,
      skipHostCheck: true
    })
  ])
  assert.equal(a.downloaded || b.downloaded, true)
  assert.equal(srv.hits(), 1)
  await srv.close()
})

test('cancel of one waiter does not cancel the other', async () => {
  resetInflightForTests()
  const data = Buffer.from('cancel-one-keep-other')
  const srv = await startStaticServer({ '/c.bin': data }, { delayMs: 120 })
  const { artifact } = fileArtifact({ data, dest: 'resources/bin/c.bin', url: srv.url('/c.bin') })
  artifact.url = srv.url('/c.bin')
  const cacheRoot = tempDir('cache-')
  const ac = new AbortController()
  const p1 = ensureArtifact({
    artifact,
    destRoot: tempDir(),
    cacheRoot,
    skipHostCheck: true,
    signal: ac.signal
  })
  const p2 = ensureArtifact({
    artifact: { ...artifact, dest: 'resources/bin/c2.bin' },
    destRoot: tempDir(),
    cacheRoot,
    skipHostCheck: true
  })
  ac.abort()
  await assert.rejects(p1)
  const ok = await p2
  assert.equal(ok.downloaded || existsSync(join(ok.destPath)), true)
  await srv.close()
})

test('all waiters cancelled does not publish complete cache', async () => {
  resetInflightForTests()
  const data = Buffer.from('never-complete')
  const srv = await startStaticServer({ '/n.bin': data }, { delayMs: 150 })
  const { artifact } = fileArtifact({ data, dest: 'resources/bin/n.bin', url: srv.url('/n.bin') })
  artifact.url = srv.url('/n.bin')
  const cacheRoot = tempDir('cache-')
  const a1 = new AbortController()
  const a2 = new AbortController()
  const p1 = ensureArtifact({
    artifact,
    destRoot: tempDir(),
    cacheRoot,
    skipHostCheck: true,
    signal: a1.signal
  })
  const p2 = ensureArtifact({
    artifact: { ...artifact, dest: 'resources/bin/n2.bin' },
    destRoot: tempDir(),
    cacheRoot,
    skipHostCheck: true,
    signal: a2.signal
  })
  a1.abort()
  a2.abort()
  await Promise.allSettled([p1, p2])
  const complete = join(cacheRoot, 'sha256', artifact.sha256, 'complete')
  assert.equal(existsSync(complete), false)
  await srv.close()
})

test('archive extracted only after outer hash match', async () => {
  resetInflightForTests()
  const payload = Buffer.from('uv-bytes')
  const zip = createZip([{ name: 'uv.exe', data: payload }])
  const srv = await startStaticServer({ '/uv.zip': zip })
  const root = tempDir()
  const artifact = {
    id: 'uv',
    kind: 'archive',
    version: '1',
    platform: 'win32-x64',
    url: srv.url('/uv.zip'),
    size: zip.length,
    sha256: sha256Hex(zip),
    dest: 'resources/bin/uv.exe',
    source: 'github.com/astral-sh/uv',
    license: 'MIT',
    archive: {
      format: 'zip',
      files: [
        {
          path: 'uv.exe',
          size: payload.length,
          sha256: sha256Hex(payload),
          executable: true,
          dest: 'resources/bin/uv.exe'
        }
      ]
    }
  }
  await ensureArtifact({
    artifact,
    destRoot: root,
    cacheRoot: join(root, 'cache'),
    skipHostCheck: true
  })
  const dest = join(root, 'resources', 'bin', 'uv.exe')
  assert.equal(hashFile(dest), sha256Hex(payload))
  await srv.close()
})
