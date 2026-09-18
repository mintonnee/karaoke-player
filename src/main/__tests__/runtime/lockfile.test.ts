import { writeFileSync, existsSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { withProcessLock } from '../../runtime'
import { tempDir } from './helpers'

describe('runtime process lock', () => {
  it('recovers when both a former owner and its reclaimer crashed', async () => {
    const path = join(tempDir(), 'digest.lock')
    writeFileSync(path, JSON.stringify({ pid: 2_147_483_647, token: 'dead' }))
    writeFileSync(
      `${path}.reclaim`,
      JSON.stringify({ pid: 2_147_483_647, token: 'dead-reclaimer' })
    )
    await expect(withProcessLock(path, async () => 'recovered')).resolves.toBe('recovered')
    expect(existsSync(path)).toBe(false)
    expect(existsSync(`${path}.reclaim`)).toBe(false)
  })

  it('parallel stale-owner reclaimers serialize critical sections', async () => {
    const path = join(tempDir(), 'digest.lock')
    writeFileSync(path, JSON.stringify({ pid: 2_147_483_647 }))
    let active = 0
    let maximum = 0
    await Promise.all(
      Array.from({ length: 8 }, () =>
        withProcessLock(path, async () => {
          maximum = Math.max(maximum, ++active)
          await new Promise((resolve) => setTimeout(resolve, 5))
          active--
        })
      )
    )
    expect(maximum).toBe(1)
    expect(existsSync(path)).toBe(false)
  })

  it('cancellation of a waiter preserves the active owner', async () => {
    const path = join(tempDir(), 'digest.lock')
    writeFileSync(path, JSON.stringify({ pid: process.pid, token: 'other-owner' }))
    const ac = new AbortController()
    const wait = withProcessLock(
      path,
      async () => {
        throw new Error('must not run')
      },
      { signal: ac.signal }
    )
    const rejection = expect(wait).rejects.toMatchObject({ name: 'AbortError' })
    ac.abort()
    await rejection
    expect(existsSync(path)).toBe(true)
  })

  it('bounds ambiguous locks and propagates callback EEXIST without retrying', async () => {
    const path = join(tempDir(), 'digest.lock')
    writeFileSync(path, '')
    await expect(withProcessLock(path, async () => {}, { timeoutMs: 1 })).rejects.toMatchObject({
      code: 'ETIMEDOUT'
    })
    const fresh = join(tempDir(), 'digest.lock')
    let calls = 0
    await expect(
      withProcessLock(fresh, async () => {
        calls++
        throw Object.assign(new Error('publish failed'), { code: 'EEXIST' })
      })
    ).rejects.toThrow('publish failed')
    expect(calls).toBe(1)
  })
})
