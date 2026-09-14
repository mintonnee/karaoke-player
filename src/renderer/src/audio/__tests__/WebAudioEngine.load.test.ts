import { describe, expect, it, vi } from 'vitest'
import { WebAudioEngine } from '../WebAudioEngine'

function deferred(): {
  promise: Promise<AudioBuffer>
  resolve: (buffer: AudioBuffer) => void
  reject: (error: Error) => void
} {
  let resolve!: (buffer: AudioBuffer) => void
  let reject!: (error: Error) => void
  const promise = new Promise<AudioBuffer>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

function setup(): {
  engine: WebAudioEngine
  pending: ReturnType<typeof deferred>
  create: ReturnType<typeof vi.spyOn>
} {
  const engine = new WebAudioEngine()
  // 디코딩 완료 순서만 제어하고 load/stop/dispose 상태 전이는 실제 구현을 실행한다.
  const internals = engine as unknown as {
    ensureContext: () => AudioContext
    ensurePitchGraph: () => Promise<void>
    decodeFile: (ctx: AudioContext, path: string) => Promise<AudioBuffer>
    createChannel: (ctx: AudioContext, buffer: AudioBuffer) => unknown
  }
  const pending = deferred()
  vi.spyOn(internals, 'ensureContext').mockReturnValue({} as AudioContext)
  vi.spyOn(internals, 'ensurePitchGraph').mockResolvedValue(undefined)
  vi.spyOn(internals, 'decodeFile').mockImplementation((_ctx, path) =>
    path === 'a' ? pending.promise : Promise.resolve({ duration: 200 } as AudioBuffer)
  )
  const create = vi.spyOn(internals, 'createChannel').mockImplementation((_ctx, buffer) => ({
    buffer,
    gain: { disconnect: vi.fn() },
    analyser: { disconnect: vi.fn() }
  }))
  return { engine, pending, create }
}

describe('WebAudioEngine concurrent load', () => {
  it.each(['success', 'failure'] as const)(
    '이전 로드의 늦은 %s는 최신 버퍼와 상태를 유지한다',
    async (result) => {
      const { engine, pending, create } = setup()
      const first = engine.load({ inst: 'a', guide: null })
      await engine.load({ inst: 'b', guide: null })
      if (result === 'success') pending.resolve({ duration: 100 } as AudioBuffer)
      else pending.reject(new Error('old decode failed'))
      await first
      expect(engine.duration).toBe(200)
      expect(engine.state).toBe('ready')
      expect(create).toHaveBeenCalledTimes(1)
      engine.dispose()
    }
  )

  it.each(['stop', 'dispose'] as const)(
    '%s 이후 늦은 로드는 엔진을 되살리지 않는다',
    async (action) => {
      const { engine, pending, create } = setup()
      const loading = engine.load({ inst: 'a', guide: null })
      engine[action]()
      pending.resolve({ duration: 100 } as AudioBuffer)
      await loading
      expect(engine.state).toBe('idle')
      expect(engine.duration).toBe(0)
      expect(create).not.toHaveBeenCalled()
    }
  )
})
