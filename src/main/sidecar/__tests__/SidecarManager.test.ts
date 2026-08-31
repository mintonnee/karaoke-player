import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { SidecarError, SidecarManager } from '../SidecarManager'
import type { SidecarProgressEvent } from '../SidecarManager'

const FAKE_WORKER = join(process.cwd(), 'src', 'main', 'sidecar', '__tests__', 'fake_worker.mjs')

function createManager(): SidecarManager {
  return new SidecarManager({
    command: process.execPath,
    baseArgs: [FAKE_WORKER],
    onLog: () => {}
  })
}

async function expectSidecarError(promise: Promise<unknown>, code: string): Promise<void> {
  const error = await promise.then(
    () => {
      throw new Error('expected rejection')
    },
    (e) => e
  )
  expect(error).toBeInstanceOf(SidecarError)
  expect((error as SidecarError).code).toBe(code)
}

describe('SidecarManager', () => {
  it('done 이벤트의 result를 resolve하고 progress를 전달한다', async () => {
    const progress: SidecarProgressEvent[] = []
    const result = await createManager().run(['ok'], {
      onProgress: (event) => progress.push(event)
    })

    expect(result).toEqual({ duration: 187.2, title: 'fake song' })
    expect(progress.map((p) => p.pct)).toEqual([10, 90])
    expect(progress[0].stage).toBe('probe')
  })

  it('error 이벤트를 SidecarError(code)로 reject한다', async () => {
    await expectSidecarError(createManager().run(['error']), 'CUDA_OOM')
  })

  it('타임아웃 시 프로세스를 죽이고 TIMEOUT으로 reject한다', async () => {
    await expectSidecarError(createManager().run(['hang'], { timeoutMs: 300 }), 'TIMEOUT')
  })

  it('AbortSignal로 취소하면 CANCELLED로 reject한다', async () => {
    const controller = new AbortController()
    const promise = createManager().run(['hang'], { signal: controller.signal })
    setTimeout(() => controller.abort(), 100)
    await expectSidecarError(promise, 'CANCELLED')
  })

  it('이미 abort된 signal이면 spawn 없이 즉시 CANCELLED', async () => {
    const controller = new AbortController()
    controller.abort()
    await expectSidecarError(
      createManager().run(['ok'], { signal: controller.signal }),
      'CANCELLED'
    )
  })

  it('JSON이 아닌 stdout 줄은 무시하고 계속 진행한다', async () => {
    const result = await createManager().run(['garbage'])
    expect(result).toEqual({ ok: true })
  })

  it('done/error 없이 종료하면 NO_RESULT로 reject한다', async () => {
    await expectSidecarError(createManager().run(['silent']), 'NO_RESULT')
  })

  it('실행 파일이 없으면 SPAWN_FAILED로 reject한다', async () => {
    const manager = new SidecarManager({
      command: 'karaoke-player-no-such-command',
      baseArgs: [],
      onLog: () => {}
    })
    await expectSidecarError(manager.run(['ok']), 'SPAWN_FAILED')
  })
})
