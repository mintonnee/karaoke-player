import { describe, expect, it } from 'vitest'
import { JobQueue } from '../JobQueue'

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

async function flush(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0))
}

describe('JobQueue', () => {
  it('잡을 순서대로 하나씩 실행한다', async () => {
    const queue = new JobQueue()
    const order: string[] = []
    const first = deferred()

    queue.enqueue(async () => {
      order.push('a:start')
      await first.promise
      order.push('a:end')
    })
    queue.enqueue(async () => {
      order.push('b')
    })

    await flush()
    expect(order).toEqual(['a:start'])
    expect(queue.isRunning).toBe(true)
    expect(queue.pending).toBe(1)

    first.resolve()
    await flush()
    expect(order).toEqual(['a:start', 'a:end', 'b'])
    expect(queue.isRunning).toBe(false)
    expect(queue.pending).toBe(0)
  })

  it('잡이 실패해도 다음 잡을 계속 실행한다', async () => {
    const errors: unknown[] = []
    const queue = new JobQueue((e) => errors.push(e))
    const order: string[] = []

    queue.enqueue(async () => {
      throw new Error('boom')
    })
    queue.enqueue(async () => {
      order.push('next')
    })

    await flush()
    expect(order).toEqual(['next'])
    expect(errors).toHaveLength(1)
    expect((errors[0] as Error).message).toBe('boom')
  })

  it('실행 중에 추가된 잡도 이어서 실행한다', async () => {
    const queue = new JobQueue()
    const order: string[] = []
    const gate = deferred()

    queue.enqueue(async () => {
      order.push('a')
      await gate.promise
      queue.enqueue(async () => {
        order.push('c')
      })
    })
    queue.enqueue(async () => {
      order.push('b')
    })

    gate.resolve()
    await flush()
    expect(order).toEqual(['a', 'b', 'c'])
  })
})
