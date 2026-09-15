import { existsSync, mkdirSync } from 'fs'
import { open, readFile, rm, writeFile } from 'fs/promises'
import { dirname } from 'path'

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

/** 죽은 owner만 회수한다. 오래된 잠금은 시간이 지났다는 이유만으로 지우지 않는다. */
export async function withProcessLock<T>(lockPath: string, fn: () => Promise<T>): Promise<T> {
  mkdirSync(dirname(lockPath), { recursive: true })
  for (;;) {
    try {
      const handle = await open(lockPath, 'wx')
      try {
        await handle.writeFile(
          JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }),
          'utf8'
        )
      } finally {
        await handle.close()
      }
      try {
        return await fn()
      } finally {
        await rm(lockPath, { force: true })
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
      let ownerPid: number | null = null
      if (existsSync(lockPath)) {
        try {
          const raw = await readFile(lockPath, 'utf8')
          ownerPid = (JSON.parse(raw) as { pid?: number }).pid ?? null
        } catch {
          ownerPid = null
        }
      }
      if (ownerPid != null && !pidAlive(ownerPid)) {
        try {
          await writeFile(
            lockPath,
            JSON.stringify({
              pid: process.pid,
              startedAt: new Date().toISOString(),
              reclaimed: true
            }),
            { flag: 'w' }
          )
          try {
            return await fn()
          } finally {
            await rm(lockPath, { force: true })
          }
        } catch (reclaimErr) {
          const code = (reclaimErr as NodeJS.ErrnoException).code
          if (code === 'EPERM' || code === 'EACCES') {
            await new Promise((r) => setTimeout(r, 50))
            continue
          }
          throw reclaimErr
        }
      }
      await new Promise((r) => setTimeout(r, 50))
    }
  }
}
