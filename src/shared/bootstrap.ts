import type { BootstrapPrepStage, BootstrapState, BootstrapStatus, ImportRejection } from './types'

export type BootstrapChrome = 'hidden' | 'panel' | 'strip'

export const BOOTSTRAP_STAGE_LABEL: Record<BootstrapPrepStage, string> = {
  download: '다운로드',
  verify: '검증',
  'env-prep': '환경 구성',
  'model-prep': '모델 준비'
}

export const BOOTSTRAP_STAGE_MESSAGE: Record<BootstrapPrepStage, string> = {
  download: '실행 환경 다운로드 중',
  verify: '다운로드 파일 확인 중',
  'env-prep': '실행 환경 구성 중',
  'model-prep': '모델 준비 중'
}

const STATUS_STAGE: Partial<Record<BootstrapStatus, BootstrapPrepStage>> = {
  copying: 'download',
  download: 'download',
  verify: 'verify',
  syncing: 'env-prep',
  'env-prep': 'env-prep',
  'model-prep': 'model-prep'
}

/** Python 런타임이 준비되어 sidecar 작업을 받을 수 있는지. model-prep은 환경은 준비된 상태 */
export function isRuntimeReady(state: BootstrapState | null | undefined): boolean {
  if (!state) return false
  return state.status === 'ready' || state.status === 'model-prep'
}

/** 임포트·분리·정렬·전사·URL 가져오기처럼 sidecar가 필요한 동작 */
export function isRuntimeActionAllowed(state: BootstrapState | null | undefined): boolean {
  return isRuntimeReady(state)
}

export function bootstrapDisplayStage(
  state: BootstrapState | null | undefined
): BootstrapPrepStage | null {
  if (!state) return null
  if (state.stage) return state.stage
  return STATUS_STAGE[state.status] ?? null
}

/** 알림 버튼에 진행 표시가 필요한 상태. 상태 미수신도 확인 중으로 취급한다. */
export function isBootstrapInProgress(state: BootstrapState | null | undefined): boolean {
  return !state || (state.status !== 'ready' && state.status !== 'error')
}

/** 알림의 현재 상태 문구. ready면 현재 상태 카드가 없으므로 null이다. */
export function bootstrapStatusMessage(state: BootstrapState | null | undefined): string | null {
  if (!state) return '준비 상태 확인 중'
  if (state.status === 'ready') return null
  if (state.status === 'error') {
    return state.error?.trim() || state.message.trim() || '실행 환경을 준비하지 못했습니다'
  }
  const stage = bootstrapDisplayStage(state)
  return stage ? BOOTSTRAP_STAGE_MESSAGE[stage] : '준비 상태 확인 중'
}

/**
 * 빈 라이브러리는 준비 패널, 기존 곡이 있으면 상태 줄.
 * ready면 숨긴다. model-prep은 진행만 알린다.
 */
export function bootstrapChrome(
  state: BootstrapState | null | undefined,
  opts: { trackCount: number }
): BootstrapChrome {
  if (!state || state.status === 'ready') return 'hidden'
  return opts.trackCount === 0 ? 'panel' : 'strip'
}

export function formatRuntimeBlockedMessage(state: BootstrapState): string {
  const stage = bootstrapDisplayStage(state) ?? state.status
  const logicalId = state.logicalId ?? 'runtime'
  const retryable = isBootstrapRetryable(state)
  const detail = state.error?.trim() || state.message || '런타임이 아직 준비되지 않았습니다'
  return `${detail} (id=${logicalId}, stage=${stage}, retryable=${retryable})`
}

export function runtimeActionRejection(state: BootstrapState, filePath = ''): ImportRejection {
  return { filePath, reason: formatRuntimeBlockedMessage(state) }
}

export function isBootstrapRetryable(state: BootstrapState | null | undefined): boolean {
  return state?.status === 'error' && state.retryable === true
}
