import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  ToolId,
  ToolReadinessSnapshot,
  ToolReadinessState
} from '../../../../shared/runtimeTools'

function state(toolId: ToolId, patch: Partial<ToolReadinessState> = {}): ToolReadinessState {
  return {
    toolId,
    status: 'pending',
    downloadedBytes: null,
    totalBytes: null,
    error: null,
    retryable: false,
    ...patch
  }
}

function snapshot(
  patch: Partial<Record<ToolId, Partial<ToolReadinessState>>> = {}
): ToolReadinessSnapshot {
  return {
    tools: {
      uv: state('uv', patch.uv),
      deno: state('deno', patch.deno),
      'yt-dlp': state('yt-dlp', patch['yt-dlp'])
    }
  }
}

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: unknown) => void
} {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

describe('tool readiness store', () => {
  let store: typeof import('../toolReadinessStore')
  const disconnects: Array<() => void> = []

  beforeEach(async () => {
    vi.resetModules()
    store = await import('../toolReadinessStore')
  })

  afterEach(() => {
    disconnects.splice(0).forEach((disconnect) => disconnect())
  })

  function connect(initial = deferred<ToolReadinessSnapshot>()): {
    initial: ReturnType<typeof deferred<ToolReadinessSnapshot>>
    emit: (value: ToolReadinessState) => void
    disconnect: () => void
    unsubscribe: ReturnType<typeof vi.fn>
    api: {
      onToolReadiness: ReturnType<typeof vi.fn>
      getToolReadiness: ReturnType<typeof vi.fn>
    }
  } {
    let emit!: (value: ToolReadinessState) => void
    const unsubscribe = vi.fn()
    const api = {
      onToolReadiness: vi.fn((callback: typeof emit) => {
        emit = callback
        return unsubscribe
      }),
      getToolReadiness: vi.fn(() => initial.promise)
    }
    const disconnect = store.connectToolReadiness(api)
    disconnects.push(disconnect)
    return { initial, emit, disconnect, unsubscribe, api }
  }

  it('먼저 온 도구 이벤트만 늦은 snapshot에서 보호하고 나머지는 채운다', async () => {
    const channel = connect()
    expect(channel.api.onToolReadiness.mock.invocationCallOrder[0]).toBeLessThan(
      channel.api.getToolReadiness.mock.invocationCallOrder[0]
    )
    channel.emit(state('deno', { status: 'ready' }))
    channel.initial.resolve(
      snapshot({
        uv: { status: 'ready' },
        deno: { status: 'error', error: 'stale', retryable: true },
        'yt-dlp': { status: 'disabled' }
      })
    )
    await channel.initial.promise

    const current = store.useToolReadinessStore.getState()
    expect(current.snapshot.tools.uv.status).toBe('ready')
    expect(current.snapshot.tools.deno.status).toBe('ready')
    expect(current.snapshot.tools['yt-dlp'].status).toBe('disabled')
    expect(current.loaded).toBe(true)
  })

  it('도구별 재시도를 독립 실행하고 같은 도구의 중복 요청은 합류시킨다', async () => {
    const channel = connect()
    channel.emit(state('deno', { status: 'error', error: 'deno failed', retryable: true }))
    channel.emit(state('yt-dlp', { status: 'error', error: 'yt-dlp failed', retryable: true }))
    const denoResult = deferred<ToolReadinessSnapshot>()
    const ytResult = deferred<ToolReadinessSnapshot>()
    const retryToolReadiness = vi.fn((toolId: ToolId) =>
      toolId === 'deno' ? denoResult.promise : ytResult.promise
    )
    const api = { retryToolReadiness }

    const denoRetry = store.retryRuntimeTool('deno', api)
    expect(store.retryRuntimeTool('deno', api)).toBe(denoRetry)
    const ytRetry = store.retryRuntimeTool('yt-dlp', api)
    await Promise.resolve()
    expect(retryToolReadiness).toHaveBeenCalledTimes(2)
    expect(store.useToolReadinessStore.getState().retrying).toEqual({
      uv: false,
      deno: true,
      'yt-dlp': true
    })

    denoResult.resolve(
      snapshot({
        uv: { status: 'ready' },
        deno: { status: 'ready' },
        'yt-dlp': { status: 'error', error: 'yt-dlp failed', retryable: true }
      })
    )
    await denoRetry
    expect(store.useToolReadinessStore.getState().snapshot.tools.deno.status).toBe('ready')
    expect(store.useToolReadinessStore.getState().snapshot.tools['yt-dlp'].status).toBe('error')

    ytResult.resolve(
      snapshot({
        uv: { status: 'ready' },
        deno: { status: 'ready' },
        'yt-dlp': { status: 'ready' }
      })
    )
    await ytRetry
    expect(store.useToolReadinessStore.getState().snapshot.tools['yt-dlp'].status).toBe('ready')
  })

  it('새 terminal 이벤트를 오래된 retry 응답으로 되돌리지 않는다', async () => {
    const channel = connect()
    channel.emit(state('deno', { status: 'error', error: 'failed', retryable: true }))
    const result = deferred<ToolReadinessSnapshot>()
    const pending = store.retryRuntimeTool('deno', { retryToolReadiness: () => result.promise })
    channel.emit(state('deno', { status: 'ready' }))
    result.resolve(snapshot({ deno: { status: 'error', error: 'stale', retryable: true } }))
    await pending
    expect(store.useToolReadinessStore.getState().snapshot.tools.deno.status).toBe('ready')
  })

  it('dispose 뒤의 이벤트와 snapshot, retry 완료를 무시한다', async () => {
    const channel = connect()
    channel.emit(state('deno', { status: 'error', error: 'failed', retryable: true }))
    const retry = deferred<ToolReadinessSnapshot>()
    const pending = store.retryRuntimeTool('deno', { retryToolReadiness: () => retry.promise })
    const beforeDispose = store.useToolReadinessStore.getState().snapshot
    channel.disconnect()
    expect(store.useToolReadinessStore.getState().retrying.deno).toBe(false)

    channel.emit(state('deno', { status: 'ready' }))
    channel.initial.resolve(snapshot({ deno: { status: 'ready' } }))
    retry.resolve(snapshot({ deno: { status: 'ready' } }))
    await Promise.all([channel.initial.promise, pending])

    expect(channel.unsubscribe).toHaveBeenCalledTimes(1)
    expect(store.useToolReadinessStore.getState().snapshot).toBe(beforeDispose)
  })

  it('snapshot 조회 실패를 보존하고 이벤트 수신 시 해제한다', async () => {
    const channel = connect()
    channel.initial.reject(new Error('IPC unavailable'))
    await channel.initial.promise.catch(() => {})
    expect(store.useToolReadinessStore.getState().loadError).toContain('IPC unavailable')
    channel.emit(state('uv', { status: 'ready' }))
    expect(store.useToolReadinessStore.getState().loadError).toBeNull()
  })

  it('URL 미리보기는 URL 도구만, 실제 가져오기는 Python까지 준비되어야 한다', () => {
    const urlReady = snapshot({ deno: { status: 'ready' }, 'yt-dlp': { status: 'ready' } })
    const denoPending = snapshot({ deno: { status: 'pending' }, 'yt-dlp': { status: 'ready' } })

    expect(store.areUrlToolsReady(urlReady)).toBe(true)
    expect(store.areUrlToolsReady(denoPending)).toBe(false)
    expect(store.isImportRuntimeReady(false, true, urlReady)).toBe(false)
    expect(store.isImportRuntimeReady(true, true, denoPending)).toBe(false)
    expect(store.isImportRuntimeReady(true, true, urlReady)).toBe(true)
    expect(store.isImportRuntimeReady(true, false, denoPending)).toBe(true)
  })
})
