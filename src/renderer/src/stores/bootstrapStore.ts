import { create } from 'zustand'
import {
  bootstrapDisplayStage,
  formatRuntimeBlockedMessage,
  isBootstrapRetryable,
  isRuntimeReady
} from '../../../shared/bootstrap'
import type { BootstrapState } from '../../../shared/types'
import { reportError } from './errorStore'

interface BootstrapStore {
  state: BootstrapState | null
  retrying: boolean
  retryError: string | null
  setState: (state: BootstrapState) => void
}

let stateRevision = 0
let failureReported = false
let pendingRetry: Promise<void> | null = null

function isRuntimeFailure(state: BootstrapState): boolean {
  return state.status === 'error' && bootstrapDisplayStage(state) !== 'model-prep'
}

function reportRuntimeFailure(message: string): void {
  if (failureReported) return
  failureReported = true
  reportError('runtime', message)
}

export const useBootstrapStore = create<BootstrapStore>((set, get) => ({
  state: null,
  retrying: false,
  retryError: null,
  setState: (state) => {
    stateRevision += 1
    if (state.status !== 'error' && !get().retrying) failureReported = false
    set({ state })
    if (isRuntimeFailure(state)) reportRuntimeFailure(formatRuntimeBlockedMessage(state))
  }
}))

interface BootstrapConnection {
  consumers: number
  active: boolean
  unsubscribe: () => void
}

let connection: BootstrapConnection | null = null

/** 앱 수명에 연결한다. 여러 호출자는 한 구독을 공유하며 각자 반환된 함수를 해제한다. */
export function connectBootstrap(
  api: Pick<Window['api'], 'getBootstrapState' | 'onBootstrapState'> = window.api
): () => void {
  if (!connection) {
    const current: BootstrapConnection = {
      consumers: 0,
      active: true,
      unsubscribe: () => {}
    }
    connection = current
    let receivedEvent = false
    current.unsubscribe = api.onBootstrapState((state) => {
      if (!current.active) return
      receivedEvent = true
      useBootstrapStore.getState().setState(state)
    })
    const revision = stateRevision
    void api.getBootstrapState().then(
      (state) => {
        if (current.active && !receivedEvent && revision === stateRevision) {
          useBootstrapStore.getState().setState(state)
        }
      },
      (error: unknown) => {
        if (current.active && !receivedEvent && revision === stateRevision) {
          useBootstrapStore.getState().setState({
            status: 'error',
            message: '준비 상태를 확인하지 못했습니다',
            error: String(error),
            log: [],
            retryable: false
          })
        }
      }
    )
  }
  const current = connection
  current.consumers += 1
  let released = false
  return () => {
    if (released) return
    released = true
    current.consumers -= 1
    if (current.consumers === 0) {
      current.active = false
      current.unsubscribe()
      if (connection === current) connection = null
    }
  }
}

/** 실패 기록과 별개로 시도 경계를 열고, IPC 실패는 retryError에 보존한다. */
export function retryBootstrap(
  api: Pick<Window['api'], 'retryBootstrap'> = window.api
): Promise<void> {
  if (pendingRetry) return pendingRetry
  const state = useBootstrapStore.getState().state
  if (!state || !isRuntimeFailure(state) || !isBootstrapRetryable(state)) {
    return Promise.resolve()
  }
  failureReported = false
  stateRevision += 1
  const revision = stateRevision
  useBootstrapStore.setState({ retrying: true, retryError: null })
  pendingRetry = Promise.resolve()
    .then(() => api.retryBootstrap())
    .then((result) => {
      const latest = useBootstrapStore.getState().state
      // 진행 이벤트 뒤의 최종 응답은 반영하되, 먼저 도착한 종료/모델 상태를 되돌리지 않는다.
      if (
        revision === stateRevision ||
        (latest && latest.status !== 'error' && !isRuntimeReady(latest))
      ) {
        useBootstrapStore.getState().setState(result)
      }
    })
    .catch((error: unknown) => {
      const message = `실행 환경을 다시 준비하지 못했습니다: ${String(error)}`
      useBootstrapStore.setState({ retryError: message })
      reportRuntimeFailure(message)
    })
    .finally(() => {
      pendingRetry = null
      if (useBootstrapStore.getState().state?.status !== 'error') failureReported = false
      useBootstrapStore.setState({ retrying: false })
    })
  return pendingRetry
}

export function useRuntimeReady(): boolean {
  return useBootstrapStore((s) => isRuntimeReady(s.state))
}
