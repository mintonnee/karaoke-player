import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { isRuntimeReady } from '../../../../shared/bootstrap'
import type { AppErrorReport, BootstrapState } from '../../../../shared/types'

function bootstrap(patch: Partial<BootstrapState> = {}): BootstrapState {
  return { status: 'checking', message: '확인 중', error: null, log: [], ...patch }
}

const failed = bootstrap({
  status: 'error',
  stage: 'env-prep',
  logicalId: 'runtime',
  error: '환경 구성 실패',
  retryable: true
})
const ready = bootstrap({ status: 'ready', message: '준비 완료' })

function deferred(): {
  promise: Promise<BootstrapState>
  resolve: (value: BootstrapState) => void
  reject: (error: unknown) => void
} {
  let resolve!: (value: BootstrapState) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<BootstrapState>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

describe('bootstrap store state boundary', () => {
  let store: typeof import('../bootstrapStore')
  let errors: typeof import('../errorStore').useErrorStore
  let receiveError: (report: AppErrorReport) => void
  const disconnects: (() => void)[] = []

  beforeEach(async () => {
    vi.resetModules()
    vi.stubGlobal('window', {
      api: {
        onAppError: vi.fn((callback: typeof receiveError) => {
          receiveError = callback
          return () => {}
        })
      }
    })
    store = await import('../bootstrapStore')
    errors = (await import('../errorStore')).useErrorStore
  })

  afterEach(() => {
    disconnects.splice(0).forEach((disconnect) => disconnect())
    vi.unstubAllGlobals()
  })

  function connect(snapshot = deferred()): {
    snapshot: ReturnType<typeof deferred>
    emit: (state: BootstrapState) => void
    disconnect: () => void
    api: {
      onBootstrapState: Mock<(callback: (state: BootstrapState) => void) => () => void>
      getBootstrapState: Mock<() => Promise<BootstrapState>>
    }
    unsubscribe: ReturnType<typeof vi.fn>
  } {
    let emit!: (state: BootstrapState) => void
    const unsubscribe = vi.fn()
    const api = {
      onBootstrapState: vi.fn((callback: typeof emit) => {
        emit = callback
        return unsubscribe
      }),
      getBootstrapState: vi.fn(() => snapshot.promise)
    }
    const disconnect = store.connectBootstrap(api)
    disconnects.push(disconnect)
    return { snapshot, emit, disconnect, api, unsubscribe }
  }

  it('subscribes before querying and ignores an old snapshot after a live event', async () => {
    const channel = connect()
    expect(channel.api.onBootstrapState.mock.invocationCallOrder[0]).toBeLessThan(
      channel.api.getBootstrapState.mock.invocationCallOrder[0]
    )
    channel.emit(ready)
    channel.snapshot.resolve(failed)
    await channel.snapshot.promise
    expect(store.useBootstrapStore.getState().state).toBe(ready)
    expect(errors.getState().entries).toHaveLength(0)
  })

  it('records the first error snapshot once across duplicate events, deletion and reconnect', async () => {
    const channel = connect()
    channel.snapshot.resolve(failed)
    await channel.snapshot.promise
    channel.emit({ ...failed })
    expect(errors.getState().entries).toHaveLength(1)
    expect(errors.getState().entries[0]).toMatchObject({ source: 'runtime', seen: false })
    expect(errors.getState().entries[0].message).toContain('stage=env-prep')
    errors.getState().clear()
    errors.getState().setNotificationOpen(true)
    channel.disconnect()
    const next = connect()
    next.snapshot.resolve({ ...failed })
    await next.snapshot.promise
    next.emit(failed)
    expect(errors.getState().entries).toHaveLength(0)
    expect(store.useBootstrapStore.getState().state).toBe(failed)
    expect(isRuntimeReady(store.useBootstrapStore.getState().state)).toBe(false)
  })

  it('shares one subscription and makes cleanup idempotent for multiple consumers', () => {
    const channel = connect()
    const releaseSecond = store.connectBootstrap(channel.api)
    disconnects.push(releaseSecond)
    expect(channel.api.onBootstrapState).toHaveBeenCalledTimes(1)
    expect(channel.api.getBootstrapState).toHaveBeenCalledTimes(1)
    channel.disconnect()
    channel.disconnect()
    expect(channel.unsubscribe).not.toHaveBeenCalled()
    channel.emit(ready)
    expect(store.useBootstrapStore.getState().state).toBe(ready)
    releaseSecond()
    expect(channel.unsubscribe).toHaveBeenCalledTimes(1)
    channel.emit(failed)
    expect(store.useBootstrapStore.getState().state).toBe(ready)
  })

  it('ignores a disconnected snapshot and listener after StrictMode-style reconnect', async () => {
    const old = connect()
    old.disconnect()
    const current = connect()
    current.snapshot.resolve(ready)
    await current.snapshot.promise
    old.emit(failed)
    old.snapshot.resolve(failed)
    await old.snapshot.promise
    expect(store.useBootstrapStore.getState().state).toBe(ready)
    expect(errors.getState().entries).toHaveLength(0)
    expect(old.unsubscribe).toHaveBeenCalledTimes(1)
  })

  it('preserves live state when the initial query rejects', async () => {
    const channel = connect()
    channel.emit(ready)
    channel.snapshot.reject(new Error('IPC unavailable'))
    await channel.snapshot.promise.catch(() => {})
    expect(store.useBootstrapStore.getState().state).toBe(ready)
    expect(errors.getState().entries).toHaveLength(0)
  })

  it('retains an initial query failure without an unhandled rejection', async () => {
    const channel = connect()
    channel.snapshot.reject(new Error('IPC unavailable'))
    await channel.snapshot.promise.catch(() => {})
    expect(store.useBootstrapStore.getState().state).toMatchObject({
      status: 'error',
      retryable: false
    })
    expect(errors.getState().entries).toHaveLength(1)
  })

  it('updates one current state and keeps job failures on their original error path', () => {
    const setState = store.useBootstrapStore.getState().setState
    for (const status of ['download', 'verify', 'env-prep', 'model-prep'] as const) {
      const state = bootstrap({ status, stage: status })
      setState(state)
      expect(store.useBootstrapStore.getState().state).toBe(state)
    }
    const modelFailure = bootstrap({
      status: 'model-prep',
      stage: 'model-prep',
      error: '모델 다운로드 실패'
    })
    setState(modelFailure)
    receiveError({ source: 'analyze', message: '모델 다운로드 실패', at: '2026-09-17' })
    expect(store.useBootstrapStore.getState().state).toBe(modelFailure)
    setState(bootstrap({ status: 'error', stage: 'model-prep', error: '모델 실패' }))
    setState(ready)
    expect(errors.getState().entries).toHaveLength(1)
    expect(errors.getState().entries[0].source).toBe('analyze')
  })

  it('records a new non-error to runtime-error transition', () => {
    const setState = store.useBootstrapStore.getState().setState
    setState(failed)
    setState(ready)
    setState(failed)
    setState({ ...failed, error: '후속 로그 갱신' })
    expect(errors.getState().entries).toHaveLength(2)
  })

  it('does not change current failure or availability when errors are seen or removed', () => {
    store.useBootstrapStore.getState().setState(failed)
    errors.getState().markAllSeen()
    errors.getState().remove(errors.getState().entries[0].id)
    errors.getState().clear()
    expect(store.useBootstrapStore.getState().state).toBe(failed)
    expect(isRuntimeReady(store.useBootstrapStore.getState().state)).toBe(false)
  })

  it('records retry failure once even without progress, including event and reply duplication', async () => {
    const channel = connect()
    channel.emit(failed)
    const retry = deferred()
    const api = { retryBootstrap: vi.fn(() => retry.promise) }
    const first = store.retryBootstrap(api)
    expect(store.retryBootstrap(api)).toBe(first)
    expect(store.useBootstrapStore.getState().retrying).toBe(true)
    await Promise.resolve()
    expect(api.retryBootstrap).toHaveBeenCalledTimes(1)
    channel.emit(failed)
    retry.resolve(failed)
    await first
    channel.emit(failed)
    expect(errors.getState().entries).toHaveLength(2)
    expect(store.useBootstrapStore.getState().retrying).toBe(false)
    await store.retryBootstrap({ retryBootstrap: vi.fn().mockResolvedValue(failed) })
    expect(errors.getState().entries).toHaveLength(3)
  })

  it('invalidates a pending initial snapshot when retry starts', async () => {
    const channel = connect()
    store.useBootstrapStore.getState().setState(failed)
    const retry = deferred()
    const pending = store.retryBootstrap({ retryBootstrap: () => retry.promise })
    channel.snapshot.resolve(ready)
    await channel.snapshot.promise
    expect(store.useBootstrapStore.getState().state).toBe(failed)
    retry.resolve(failed)
    await pending
    expect(errors.getState().entries).toHaveLength(2)
  })

  it('accepts a final retry reply after progress and preserves previous failures on success', async () => {
    const channel = connect()
    channel.emit(failed)
    const retry = deferred()
    const pending = store.retryBootstrap({ retryBootstrap: () => retry.promise })
    channel.emit(bootstrap({ status: 'env-prep' }))
    retry.resolve(ready)
    await pending
    expect(store.useBootstrapStore.getState().state).toBe(ready)
    expect(errors.getState().entries).toHaveLength(1)
  })

  it('does not replace a newer terminal event with a stale retry reply', async () => {
    const channel = connect()
    channel.emit(failed)
    const retry = deferred()
    const pending = store.retryBootstrap({ retryBootstrap: () => retry.promise })
    channel.emit(ready)
    retry.resolve(failed)
    await pending
    expect(store.useBootstrapStore.getState().state).toBe(ready)
    expect(errors.getState().entries).toHaveLength(1)
  })

  it('preserves IPC retry rejection and records each explicit failed attempt once', async () => {
    store.useBootstrapStore.getState().setState(failed)
    const api = { retryBootstrap: vi.fn().mockRejectedValue(new Error('IPC disconnected')) }
    await store.retryBootstrap(api)
    expect(store.useBootstrapStore.getState()).toMatchObject({ state: failed, retrying: false })
    expect(store.useBootstrapStore.getState().retryError).toContain('IPC disconnected')
    expect(errors.getState().entries).toHaveLength(2)
    store.useBootstrapStore.getState().setState(failed)
    expect(errors.getState().entries).toHaveLength(2)
    await store.retryBootstrap(api)
    expect(errors.getState().entries).toHaveLength(3)
  })

  it('does not double-record when the retry event and IPC rejection describe one attempt', async () => {
    const channel = connect()
    channel.emit(failed)
    const retry = deferred()
    const pending = store.retryBootstrap({ retryBootstrap: () => retry.promise })
    channel.emit(failed)
    retry.reject(new Error('IPC failed'))
    await pending
    expect(errors.getState().entries).toHaveLength(2)
  })

  it('records at most one failure during a retry and rearms after its final ready state', async () => {
    const channel = connect()
    channel.emit(failed)
    const retry = deferred()
    const pending = store.retryBootstrap({ retryBootstrap: () => retry.promise })
    channel.emit(failed)
    channel.emit(bootstrap({ status: 'verify' }))
    channel.emit(failed)
    expect(errors.getState().entries).toHaveLength(2)
    channel.emit(ready)
    retry.resolve(ready)
    await pending
    channel.emit(failed)
    expect(errors.getState().entries).toHaveLength(3)
  })

  it.each([
    null,
    ready,
    { ...failed, retryable: false },
    { ...failed, stage: 'model-prep' as const }
  ])('does not retry a state without a recoverable runtime failure: %s', async (state) => {
    if (state) store.useBootstrapStore.getState().setState(state)
    const api = { retryBootstrap: vi.fn() }
    await store.retryBootstrap(api)
    expect(api.retryBootstrap).not.toHaveBeenCalled()
    expect(store.useBootstrapStore.getState().retrying).toBe(false)
  })
})
