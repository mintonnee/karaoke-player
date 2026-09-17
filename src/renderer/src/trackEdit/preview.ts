import { bootstrapStatusMessage, isRuntimeActionAllowed } from '../../../shared/bootstrap'
import { lowConfSuffix } from '../../../shared/musicKey'
import { BPM_LOW_CONF } from '../../../shared/types'
import {
  parsePreviewAnalysisResult,
  previewAnalysisFailure,
  previewAnalysisRuntimeRejection,
  PREVIEW_ANALYSIS_MESSAGES,
  type PreviewAnalysisBpmSuccess,
  type PreviewAnalysisFailure,
  type PreviewAnalysisField,
  type PreviewAnalysisKeySuccess,
  type PreviewAnalysisResult
} from '../../../shared/previewAnalysis'
import type { BootstrapState, TrackStatus } from '../../../shared/types'
import type { TrackEditFields } from './form'

export const PREVIEW_ANALYSIS_HINT = '반주에서 다시 추정합니다.'
export const PREVIEW_APPLIED_HINT = '측정 되었습니다.'
export const PREVIEW_ANALYSIS_IN_FLIGHT = '대기 또는 분석 중…'
export const PREVIEW_BPM_BUTTON_LABEL = 'BPM 재측정'
export const PREVIEW_KEY_BUTTON_LABEL = '원키 재측정'
export const PREVIEW_BPM_LOW_CONF_HINT = '추정값이 불확실합니다.'

export type PreviewDisableCause =
  'saving' | 'notFound' | 'inFlight' | 'trackNotReady' | 'runtimeNotReady'

export type PreviewInputStatusKind = 'pending' | 'applied' | 'uncertain'

export interface PreviewInputStatus {
  kind: PreviewInputStatusKind
  message: string
}

export interface PreviewDraftHints {
  bpm: PreviewInputStatus | null
  key: PreviewInputStatus | null
}

export interface PreviewGenerationGuard {
  alive: boolean
  generation: number
  responseGeneration: number
}

export interface PreviewUiError {
  target: 'bpm' | 'musicKey' | 'general'
  message: string
  notFound: boolean
}

export type PreviewApplyOutcome =
  | { status: 'stale' }
  | {
      status: 'applied'
      fields: TrackEditFields
      hints: PreviewDraftHints
      result: PreviewAnalysisBpmSuccess | PreviewAnalysisKeySuccess
    }
  | {
      status: 'failed'
      fields: TrackEditFields
      hints: PreviewDraftHints
      error: PreviewUiError
    }

export function emptyPreviewDraftHints(): PreviewDraftHints {
  return { bpm: null, key: null }
}

export function isStalePreviewResponse(guard: PreviewGenerationGuard): boolean {
  return !guard.alive || guard.generation !== guard.responseGeneration
}

export function nextPreviewGeneration(generation: number): number {
  return generation + 1
}

export function previewBpmInputValue(bpm: number): string {
  return String(bpm)
}

export function applyPreviewSuccess(
  fields: TrackEditFields,
  result: PreviewAnalysisBpmSuccess | PreviewAnalysisKeySuccess
): TrackEditFields {
  if (result.field === 'bpm') return { ...fields, bpm: previewBpmInputValue(result.bpm) }
  return { ...fields, musicKey: result.musicKey }
}

/** 값은 입력 칸에 넣는다. 안내 문구는 상태 아이콘 호버로 보여 준다 */
export function previewInputStatusAfterSuccess(
  result: PreviewAnalysisBpmSuccess | PreviewAnalysisKeySuccess
): PreviewInputStatus {
  if (result.field === 'bpm' && lowConfSuffix(result.bpmConf, BPM_LOW_CONF) === '?') {
    return { kind: 'uncertain', message: PREVIEW_BPM_LOW_CONF_HINT }
  }
  return { kind: 'applied', message: PREVIEW_APPLIED_HINT }
}

export function hintsAfterPreviewSuccess(
  hints: PreviewDraftHints,
  result: PreviewAnalysisBpmSuccess | PreviewAnalysisKeySuccess
): PreviewDraftHints {
  const status = previewInputStatusAfterSuccess(result)
  if (result.field === 'bpm') return { ...hints, bpm: status }
  return { ...hints, key: status }
}

export function previewFieldStatus(
  field: PreviewAnalysisField,
  inFlight: PreviewAnalysisField | null,
  hints: PreviewDraftHints
): PreviewInputStatus | null {
  if (inFlight === field) {
    return { kind: 'pending', message: PREVIEW_ANALYSIS_IN_FLIGHT }
  }
  return field === 'key' ? hints.key : hints.bpm
}

export function hintsAfterManualEdit(
  hints: PreviewDraftHints,
  patch: Partial<TrackEditFields>
): PreviewDraftHints {
  let next = hints
  if (patch.bpm !== undefined && hints.bpm !== null) next = { ...next, bpm: null }
  if (patch.musicKey !== undefined && hints.key !== null) next = { ...next, key: null }
  return next
}

export function classifyPreviewFailure(result: PreviewAnalysisFailure): PreviewUiError {
  if (result.code === 'FIELD_UNAVAILABLE') {
    return {
      target: result.field === 'key' ? 'musicKey' : 'bpm',
      message: result.message,
      notFound: false
    }
  }
  return {
    target: 'general',
    message: result.message,
    notFound: result.code === 'TRACK_NOT_FOUND'
  }
}

export function resolvePreviewAnalysisPayload(
  raw: unknown,
  requestedField: PreviewAnalysisField
): PreviewAnalysisResult {
  return parsePreviewAnalysisResult(raw) ?? previewAnalysisFailure(requestedField, 'ANALYZE_FAILED')
}

export function applyPreviewAnalysisResult(input: {
  fields: TrackEditFields
  hints: PreviewDraftHints
  requestedField: PreviewAnalysisField
  result: unknown
  guard: PreviewGenerationGuard
}): PreviewApplyOutcome {
  if (isStalePreviewResponse(input.guard)) return { status: 'stale' }

  const result = resolvePreviewAnalysisPayload(input.result, input.requestedField)
  if (!result.ok) {
    return {
      status: 'failed',
      fields: input.fields,
      hints: input.hints,
      error: classifyPreviewFailure(result)
    }
  }
  if (result.field !== input.requestedField) {
    return {
      status: 'failed',
      fields: input.fields,
      hints: input.hints,
      error: classifyPreviewFailure(previewAnalysisFailure(input.requestedField, 'INVALID_REQUEST'))
    }
  }

  return {
    status: 'applied',
    fields: applyPreviewSuccess(input.fields, result),
    hints: hintsAfterPreviewSuccess(input.hints, result),
    result
  }
}

export function previewRuntimeDisabledMessage(
  field: PreviewAnalysisField,
  bootstrap: BootstrapState | null
): string {
  if (bootstrap) return previewAnalysisRuntimeRejection(field, bootstrap).message
  const base = PREVIEW_ANALYSIS_MESSAGES.RUNTIME_NOT_READY
  const detail = bootstrapStatusMessage(null)
  return detail ? `${base}. ${detail}` : base
}

export function previewButtonDisableCause(input: {
  trackStatus: TrackStatus
  bootstrap: BootstrapState | null
  inFlight: boolean
  saving: boolean
  notFound: boolean
}): PreviewDisableCause | null {
  if (input.saving) return 'saving'
  if (input.notFound) return 'notFound'
  if (input.inFlight) return 'inFlight'
  if (input.trackStatus !== 'ready') return 'trackNotReady'
  if (!isRuntimeActionAllowed(input.bootstrap)) return 'runtimeNotReady'
  return null
}

export function previewButtonDisableReason(
  cause: PreviewDisableCause | null,
  opts: { field: PreviewAnalysisField; bootstrap: BootstrapState | null }
): string | null {
  if (cause === null || cause === 'saving' || cause === 'notFound') return null
  if (cause === 'inFlight') return PREVIEW_ANALYSIS_IN_FLIGHT
  if (cause === 'trackNotReady') return PREVIEW_ANALYSIS_MESSAGES.TRACK_NOT_READY
  return previewRuntimeDisabledMessage(opts.field, opts.bootstrap)
}

export function areAnalysisInputsLocked(input: { inFlight: boolean; saving: boolean }): boolean {
  return input.inFlight || input.saving
}

export function areIdentityInputsLockedByPreview(_inFlight: boolean): boolean {
  return false
}

export function isSaveBlockedByPreview(inFlight: boolean): boolean {
  return inFlight
}

export function canDismissTrackEditDuringPreview(saving: boolean): boolean {
  return !saving
}
