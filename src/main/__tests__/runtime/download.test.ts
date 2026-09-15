import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ERROR_CODES,
  createZip,
  ensureArtifact,
  hashFile,
  redactUrl,
  resetInflightForTests,
  sha256Hex
} from '../../runtime'
import { fileArtifact, startStaticServer, tempDir } from './helpers'

afterEach(() => {
  resetInflightForTests()
})

describe('ensureArtifact', () => {
  it('matching dest hash is reused without download', async () => {
    const data = Buffer.from('reuse-me')
    const root = tempDir()
    mkdirSync(join(root, 'resources', 'bin'), { recursive: true })
    const dest = join(root, 'resources', 'bin', 'sample.bin')
    writeFileSync(dest, data)
    const artifact = fileArtifact({
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
    expect(result.reused).toBe(true)
    expect(fetches).toBe(0)
  })

  it('1-byte tamper of dest is detected, redownloaded, exe not spawned', async () => {
    const good = Buffer.from('good-bytes!!')
    const srv = await startStaticServer({ '/a.bin': good })
    const root = tempDir()
    mkdirSync(join(root, 'resources', 'bin'), { recursive: true })
    const dest = join(root, 'resources', 'bin', 'a.bin')
    writeFileSync(dest, Buffer.from('GOOD-bytes!!'))
    const artifact = fileArtifact({
      data: good,
      dest: 'resources/bin/a.bin',
      url: srv.url('/a.bin')
    })
    artifact.url = srv.url('/a.bin')
    const spawned = 0
    await ensureArtifact({
      artifact,
      destRoot: root,
      cacheRoot: join(root, 'cache'),
      skipHostCheck: true
    })
    expect(readFileSync(dest).equals(good)).toBe(true)
    expect(spawned).toBe(0)
    await srv.close()
  })

  it('truncated download is rejected and dest is not published', async () => {
    const full = Buffer.from('0123456789')
    const artifact = fileArtifact({ data: full, url: 'http://127.0.0.1/trunc.bin' })
    const srv = await startStaticServer({ '/trunc.bin': full.subarray(0, 4) })
    artifact.url = srv.url('/trunc.bin')
    artifact.size = full.length
    const root = tempDir()
    await expect(
      ensureArtifact({
        artifact,
        destRoot: root,
        cacheRoot: join(root, 'cache'),
        skipHostCheck: true
      })
    ).rejects.toMatchObject({ code: ERROR_CODES.SIZE_MISMATCH })
    expect(existsSync(join(root, 'resources', 'bin', 'sample.bin'))).toBe(false)
    await srv.close()
  })

  it('wrong exe hash is detected and exe is not spawned', async () => {
    const good = Buffer.from('MZ-good')
    const bad = Buffer.from('MZ-evil')
    const srv = await startStaticServer({ '/uv.exe': bad })
    const artifact = fileArtifact({
      id: 'uv',
      data: good,
      dest: 'resources/bin/uv.exe',
      url: srv.url('/uv.exe')
    })
    artifact.url = srv.url('/uv.exe')
    const spawned = false
    await expect(
      ensureArtifact({
        artifact,
        destRoot: tempDir(),
        cacheRoot: join(tempDir(), 'c2'),
        skipHostCheck: true
      })
    ).rejects.toMatchObject({ code: ERROR_CODES.HASH_MISMATCH })
    expect(spawned).toBe(false)
    await srv.close()
  })

  it('hash mismatch is not written into dest', async () => {
    const good = Buffer.from('lock-bytes')
    const bad = Buffer.from('otherbytes')
    const srv = await startStaticServer({ '/x.bin': bad })
    const root = tempDir()
    const artifact = fileArtifact({
      data: good,
      dest: 'resources/bin/x.bin',
      url: srv.url('/x.bin')
    })
    artifact.url = srv.url('/x.bin')
    await expect(
      ensureArtifact({
        artifact,
        destRoot: root,
        cacheRoot: join(root, 'cache'),
        skipHostCheck: true
      })
    ).rejects.toMatchObject({ code: ERROR_CODES.HASH_MISMATCH })
    expect(existsSync(join(root, 'resources', 'bin', 'x.bin'))).toBe(false)
    await srv.close()
  })

  it('single-flight: concurrent same digest downloads once', async () => {
    const data = Buffer.from('single-flight-body')
    const srv = await startStaticServer({ '/s.bin': data }, { delayMs: 80 })
    const artifact = fileArtifact({ data, dest: 'resources/bin/s.bin', url: srv.url('/s.bin') })
    artifact.url = srv.url('/s.bin')
    const cacheRoot = tempDir('cache-')
    const [a, b] = await Promise.all([
      ensureArtifact({ artifact, destRoot: tempDir(), cacheRoot, skipHostCheck: true }),
      ensureArtifact({
        artifact: { ...artifact, dest: 'resources/bin/s2.bin' },
        destRoot: tempDir(),
        cacheRoot,
        skipHostCheck: true
      })
    ])
    expect(a.downloaded || b.downloaded).toBe(true)
    expect(srv.hits()).toBe(1)
    await srv.close()
  })

  it('cancel of one waiter does not cancel the other', async () => {
    const data = Buffer.from('cancel-one-keep-other')
    const srv = await startStaticServer({ '/c.bin': data }, { delayMs: 120 })
    const artifact = fileArtifact({ data, dest: 'resources/bin/c.bin', url: srv.url('/c.bin') })
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
    await expect(p1).rejects.toMatchObject({ name: 'AbortError' })
    const ok = await p2
    expect(existsSync(ok.destPath)).toBe(true)
    await srv.close()
  })

  it('all waiters cancelled does not publish complete cache', async () => {
    const data = Buffer.from('never-complete')
    const srv = await startStaticServer({ '/n.bin': data }, { delayMs: 150 })
    const artifact = fileArtifact({ data, dest: 'resources/bin/n.bin', url: srv.url('/n.bin') })
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
    expect(existsSync(join(cacheRoot, 'sha256', artifact.sha256, 'complete'))).toBe(false)
    await srv.close()
  })

  it('hash mismatch auto-redownloads at most once then errors', async () => {
    const good = Buffer.from('lock-bytes!!')
    const bad = Buffer.from('tamper-bytes')
    const srv = await startStaticServer({ '/r.bin': bad })
    const artifact = fileArtifact({
      data: good,
      dest: 'resources/bin/r.bin',
      url: srv.url('/r.bin')
    })
    artifact.url = srv.url('/r.bin')
    await expect(
      ensureArtifact({
        artifact,
        destRoot: tempDir(),
        cacheRoot: join(tempDir(), 'rd'),
        skipHostCheck: true
      })
    ).rejects.toMatchObject({ code: ERROR_CODES.HASH_MISMATCH })
    expect(srv.hits()).toBe(2)
    await srv.close()
  })

  it('redactUrl strips query and credentials', () => {
    expect(redactUrl('https://user:pass@github.com/a.bin?token=secret#x')).toBe(
      'https://github.com/a.bin'
    )
  })

  it('archive extracted only after outer hash match', async () => {
    const payload = Buffer.from('uv-bytes')
    const zip = createZip([{ name: 'uv.exe', data: payload }])
    const srv = await startStaticServer({ '/uv.zip': zip })
    const root = tempDir()
    const artifact = {
      id: 'uv',
      kind: 'archive' as const,
      version: '1',
      platform: 'win32-x64',
      url: srv.url('/uv.zip'),
      size: zip.length,
      sha256: sha256Hex(zip),
      dest: 'resources/bin/uv.exe',
      source: 'github.com/astral-sh/uv',
      license: 'MIT',
      archive: {
        format: 'zip' as const,
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
    expect(hashFile(join(root, 'resources', 'bin', 'uv.exe'))).toBe(sha256Hex(payload))
    await srv.close()
  })
})
