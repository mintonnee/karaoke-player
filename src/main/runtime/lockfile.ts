import { mkdirSync } from 'fs'
import { link, readFile, rm, writeFile } from 'fs/promises'
import { dirname } from 'path'
import { randomUUID } from 'crypto'
import { checkAbort, waitWithSignal } from './cancellation'

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return true
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

async function readOwner(path: string): Promise<{ pid: number; token: string } | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch {
    return null
  }
}

/** Atomically publish complete ownership, and serialize/recheck dead-owner reclamation. */
export async function withProcessLock<T>(
  lockPath: string,
  fn: () => Promise<T>,
  options: { signal?: AbortSignal; timeoutMs?: number } = {}
): Promise<T> {
  mkdirSync(dirname(lockPath), { recursive: true })
  const deadline = Date.now() + (options.timeoutMs ?? 10 * 60_000)
  const token = randomUUID()
  const ownerPath = `${lockPath}.${token}.owner`
  // A crash before link leaves only an unused owner file, never an empty canonical lock.
  await writeFile(ownerPath, JSON.stringify({ pid: process.pid, token }), { flag: 'wx' })
  try {
    for (;;) {
      checkAbort(options.signal)
      if (Date.now() >= deadline)
        throw Object.assign(new Error('runtime lock timed out'), { code: 'ETIMEDOUT' })
      let acquired = false
      try {
        await link(ownerPath, lockPath)
        acquired = true
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
      }
      if (acquired) {
        try {
          checkAbort(options.signal)
          return await fn()
        } finally {
          if ((await readOwner(lockPath))?.token === token) await rm(lockPath, { force: true })
        }
      }
      const owner = await readOwner(lockPath)
      if (owner && !pidAlive(owner.pid)) {
        // A crashed reclaimer is itself reclaimable with the same protocol.
        await withProcessLock(
          `${lockPath}.reclaim`,
          async () => {
            const current = await readOwner(lockPath)
            if (current && !pidAlive(current.pid)) await rm(lockPath, { force: true })
          },
          { signal: options.signal, timeoutMs: Math.max(1, deadline - Date.now()) }
        )
        continue
      }
      await waitWithSignal(new Promise<void>((resolve) => setTimeout(resolve, 50)), options.signal)
    }
  } finally {
    await rm(ownerPath, { force: true })
  }
}
