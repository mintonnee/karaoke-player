import { writeFileSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import { runFileJob, hashFileInWorker, verifyFileInWorker } from '../../runtime/fileWorkerClient'
import { executeFileJob } from '../../runtime/fileOperations'
import { sha256Hex } from '../../runtime/schema'
import { tempDir, fileArtifact } from './helpers'
import { abortError } from '../../runtime/cancellation'

describe('runtime file worker', () => {
  it('keeps the calling event loop responsive during hashing and preserves structured errors', async () => {
    const root = tempDir()
    const path = join(root, 'large.bin')
    const bytes = Buffer.alloc(64 * 1024 * 1024, 17)
    writeFileSync(path, bytes)
    const expected = sha256Hex(bytes)
    let ticks = 0
    const timer = setInterval(() => ticks++, 1)
    try {
      expect(await hashFileInWorker(path)).toBe(expected)
      expect(ticks).toBeGreaterThan(0)
    } finally {
      clearInterval(timer)
    }
    await expect(
      verifyFileInWorker(path, { size: bytes.length, sha256: '0'.repeat(64), id: 'wheel' })
    ).rejects.toMatchObject({ code: 'HASH_MISMATCH', id: 'wheel', path })
    // An operation error must not poison subsequent requests.
    expect(await hashFileInWorker(path)).toBe(expected)
  })

  it('cancels a queued publication without writing and allows retry', async () => {
    const root = tempDir()
    const blob = join(root, 'blob')
    writeFileSync(blob, 'payload')
    const artifact = fileArtifact({ data: 'payload', url: 'https://github.com/a' })
    const job = { kind: 'publish' as const, artifact, blob, cacheRoot: root, destRoot: root }
    const controller = new AbortController()
    const cancelled = runFileJob(job, controller.signal)
    controller.abort()
    await expect(cancelled).rejects.toMatchObject({ code: 'ABORT_ERR' })
    expect(existsSync(join(root, artifact.dest))).toBe(false)
    await runFileJob(job)
    expect(await hashFileInWorker(join(root, artifact.dest))).toBe(artifact.sha256)
  })

  it('cleans up a cancelled copy before publication and preserves the previous destination', () => {
    const root = tempDir()
    const blob = join(root, 'blob')
    const dest = join(root, 'wheel.whl')
    writeFileSync(blob, 'new')
    writeFileSync(dest, 'old')
    const artifact = {
      ...fileArtifact({ data: 'new', url: 'https://github.com/a' }),
      dest: 'wheel.whl'
    }
    let checks = 0
    expect(() =>
      executeFileJob({ kind: 'publish', artifact, blob, cacheRoot: root, destRoot: root }, () => {
        if (++checks >= 2) throw abortError()
      })
    ).toThrow('operation cancelled')
    expect(readdirSync(root).sort()).toEqual(['blob', 'wheel.whl'])
    // Content validation through the same worker used by the app.
    return expect(hashFileInWorker(dest)).resolves.toBe(sha256Hex(Buffer.from('old')))
  })
})
