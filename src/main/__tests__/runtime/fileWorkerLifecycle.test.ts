import type { EventEmitter } from 'node:events'
import { expect, it, vi } from 'vitest'
import { runFileJob } from '../../runtime/fileWorkerClient'

const state = vi.hoisted(() => ({
  workers: [] as Array<EventEmitter & { requests: Array<{ id: number }> }>
}))
vi.mock('node:worker_threads', async () => {
  const { EventEmitter } = await import('node:events')
  return {
    Worker: class extends EventEmitter {
      requests: Array<{ id: number }> = []
      constructor() {
        super()
        state.workers.push(this)
      }
      ref(): void {
        /* no OS handle in this lifecycle fixture */
      }
      unref(): void {
        /* no OS handle in this lifecycle fixture */
      }
      postMessage(message: { id: number }): void {
        this.requests.push(message)
      }
    }
  }
})

it('rejects every pending request on unexpected exit and starts a fresh worker for retry', async () => {
  const first = runFileJob({ kind: 'hash', path: 'one' })
  const second = runFileJob({ kind: 'hash', path: 'two' })
  const results = Promise.allSettled([first, second])
  state.workers[0].emit('exit', 1)
  expect((await results).map((result) => result.status)).toEqual(['rejected', 'rejected'])

  const retry = runFileJob({ kind: 'hash', path: 'one' })
  expect(state.workers).toHaveLength(2)
  const replacement = state.workers[1]
  // A late event from the dead worker must not reject a new request.
  state.workers[0].emit('error', new Error('late error'))
  replacement.emit('message', { id: replacement.requests[0].id, result: 'verified' })
  await expect(retry).resolves.toBe('verified')
})
