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

  it('enqueueAndWait는 결과를 돌려주고 실패는 onJobError로 보내지 않는다', async () => {
    const errors: unknown[] = []
    const queue = new JobQueue((e) => errors.push(e))

    await expect(queue.enqueueAndWait(async () => 7)).resolves.toBe(7)
    await expect(
      queue.enqueueAndWait(async () => {
        throw new Error('wait-boom')
      })
    ).rejects.toThrow('wait-boom')
    expect(errors).toEqual([])

    const order: string[] = []
    queue.enqueue(async () => {
      order.push('after-waitable')
    })
    await flush()
    expect(order).toEqual(['after-waitable'])
    expect(queue.isRunning).toBe(false)
  })

  it('실패한 waitable 잡 뒤에도 다음 잡을 계속 실행한다', async () => {
    const errors: unknown[] = []
    const queue = new JobQueue((e) => errors.push(e))
    const order: string[] = []

    const failed = queue.enqueueAndWait(async () => {
      order.push('waitable')
      throw new Error('wait-fail')
    })
    queue.enqueue(async () => {
      order.push('next')
    })

    await expect(failed).rejects.toThrow('wait-fail')
    await flush()
    expect(order).toEqual(['waitable', 'next'])
    expect(errors).toEqual([])
  })

  it('enqueueAndWait는 기존 enqueue와 함께 하나씩 실행한다', async () => {
    const queue = new JobQueue()
    const order: string[] = []
    const first = deferred()

    queue.enqueue(async () => {
      order.push('enqueue:start')
      await first.promise
      order.push('enqueue:end')
    })
    const waited = queue.enqueueAndWait(async () => {
      order.push('wait')
      return 1
    })

    await flush()
    expect(order).toEqual(['enqueue:start'])
    expect(queue.pending).toBe(1)

    first.resolve()
    await expect(waited).resolves.toBe(1)
    expect(order).toEqual(['enqueue:start', 'enqueue:end', 'wait'])
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
