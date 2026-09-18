import { create } from 'zustand'
import {
  TOOL_IDS,
  type ToolId,
  type ToolReadinessSnapshot,
  type ToolReadinessState
} from '../../../shared/runtimeTools'

const INITIAL_SNAPSHOT: ToolReadinessSnapshot = {
  tools: {
    uv: pendingState('uv'),
    deno: pendingState('deno'),
    'yt-dlp': pendingState('yt-dlp')
  }
}

function pendingState(toolId: ToolId): ToolReadinessState {
  return {
    toolId,
    status: 'pending',
    downloadedBytes: null,
    totalBytes: null,
    error: null,
    retryable: false
  }
}

type ToolFlags = Record<ToolId, boolean>
type ToolMessages = Record<ToolId, string | null>

interface ToolReadinessStore {
  snapshot: ToolReadinessSnapshot
  loaded: boolean
  loadError: string | null
  retrying: ToolFlags
  retryErrors: ToolMessages
}

const idleFlags = (): ToolFlags => ({ uv: false, deno: false, 'yt-dlp': false })
const emptyMessages = (): ToolMessages => ({ uv: null, deno: null, 'yt-dlp': null })

export const useToolReadinessStore = create<ToolReadinessStore>(() => ({
  snapshot: INITIAL_SNAPSHOT,
  loaded: false,
  loadError: null,
  retrying: idleFlags(),
  retryErrors: emptyMessages()
}))

const stateRevisions: Record<ToolId, number> = { uv: 0, deno: 0, 'yt-dlp': 0 }
const pendingRetries: Partial<Record<ToolId, Promise<void>>> = {}
let lifecycleRevision = 0

function replaceToolState(state: ToolReadinessState): void {
  stateRevisions[state.toolId] += 1
  useToolReadinessStore.setState((current) => ({
    snapshot: {
      tools: { ...current.snapshot.tools, [state.toolId]: state }
    },
    retryErrors:
      state.status === 'error'
        ? current.retryErrors
        : { ...current.retryErrors, [state.toolId]: null }
  }))
}

function applySnapshot(
  snapshot: ToolReadinessSnapshot,
  shouldApply: (toolId: ToolId, incoming: ToolReadinessState) => boolean
): void {
  for (const toolId of TOOL_IDS) {
    const incoming = snapshot.tools[toolId]
    if (shouldApply(toolId, incoming)) replaceToolState(incoming)
  }
}

interface ToolReadinessConnection {
  consumers: number
  active: boolean
  lifecycle: number
  unsubscribe: () => void
}

let connection: ToolReadinessConnection | null = null

/** 앱 수명에 연결한다. 이벤트를 먼저 구독하고 도구별로 늦은 snapshot을 걸러낸다. */
export function connectToolReadiness(
  api: Pick<Window['api'], 'getToolReadiness' | 'onToolReadiness'> = window.api
): () => void {
  if (!connection) {
    lifecycleRevision += 1
    const current: ToolReadinessConnection = {
      consumers: 0,
      active: true,
      lifecycle: lifecycleRevision,
      unsubscribe: () => {}
    }
    connection = current
    const liveTools = new Set<ToolId>()
    current.unsubscribe = api.onToolReadiness((state) => {
      if (!current.active) return
      liveTools.add(state.toolId)
      replaceToolState(state)
      useToolReadinessStore.setState({ loaded: true, loadError: null })
    })
    const revisions = { ...stateRevisions }
    void api.getToolReadiness().then(
      (snapshot) => {
        if (!current.active) return
        applySnapshot(
          snapshot,
          (toolId) => !liveTools.has(toolId) && revisions[toolId] === stateRevisions[toolId]
        )
        useToolReadinessStore.setState({ loaded: true, loadError: null })
      },
      (error: unknown) => {
        if (!current.active) return
        useToolReadinessStore.setState({
          loaded: true,
          loadError: `도구 준비 상태를 확인하지 못했습니다: ${String(error)}`
        })
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
      lifecycleRevision += 1
      useToolReadinessStore.setState({ retrying: idleFlags() })
      if (connection === current) connection = null
    }
  }
}

/** 같은 도구의 중복 재시도는 합류하고, 서로 다른 도구는 독립적으로 실행한다. */
export function retryRuntimeTool(
  toolId: ToolId,
  api: Pick<Window['api'], 'retryToolReadiness'> = window.api
): Promise<void> {
  const existing = pendingRetries[toolId]
  if (existing) return existing

  const currentState = useToolReadinessStore.getState().snapshot.tools[toolId]
  if (currentState.status !== 'error' || !currentState.retryable) return Promise.resolve()

  stateRevisions[toolId] += 1
  const revisions = { ...stateRevisions }
  const lifecycle = connection?.lifecycle ?? 0
  useToolReadinessStore.setState((current) => ({
    retrying: { ...current.retrying, [toolId]: true },
    retryErrors: { ...current.retryErrors, [toolId]: null }
  }))

  const pending = Promise.resolve()
    .then(() => api.retryToolReadiness(toolId))
    .then((snapshot) => {
      if (lifecycle !== 0 && connection?.lifecycle !== lifecycle) return
      applySnapshot(snapshot, (candidate, incoming) => {
        if (revisions[candidate] === stateRevisions[candidate]) return true
        if (candidate !== toolId) return false
        const latest = useToolReadinessStore.getState().snapshot.tools[candidate]
        const latestInProgress =
          latest.status === 'pending' ||
          latest.status === 'downloading' ||
          latest.status === 'verifying'
        const incomingFinished =
          incoming.status === 'ready' ||
          incoming.status === 'error' ||
          incoming.status === 'disabled'
        return latestInProgress && incomingFinished
      })
    })
    .catch((error: unknown) => {
      if (lifecycle !== 0 && connection?.lifecycle !== lifecycle) return
      useToolReadinessStore.setState((current) => ({
        retryErrors: {
          ...current.retryErrors,
          [toolId]: `${toolId} 준비를 다시 시도하지 못했습니다: ${String(error)}`
        }
      }))
    })
    .finally(() => {
      delete pendingRetries[toolId]
      if (lifecycle !== 0 && connection?.lifecycle !== lifecycle) return
      useToolReadinessStore.setState((current) => ({
        retrying: { ...current.retrying, [toolId]: false }
      }))
    })

  pendingRetries[toolId] = pending
  return pending
}

export function areUrlToolsReady(snapshot: ToolReadinessSnapshot): boolean {
  return snapshot.tools.deno.status === 'ready' && snapshot.tools['yt-dlp'].status === 'ready'
}

export function isImportRuntimeReady(
  pythonReady: boolean,
  requiresUrlTools: boolean,
  snapshot: ToolReadinessSnapshot
): boolean {
  return pythonReady && (!requiresUrlTools || areUrlToolsReady(snapshot))
}

export function isToolReadinessInProgress(snapshot: ToolReadinessSnapshot): boolean {
  return TOOL_IDS.some((toolId) => {
    const status = snapshot.tools[toolId].status
    return status === 'pending' || status === 'downloading' || status === 'verifying'
  })
}

export function toolReadinessErrorCount(snapshot: ToolReadinessSnapshot): number {
  return TOOL_IDS.filter((toolId) => snapshot.tools[toolId].status === 'error').length
}
