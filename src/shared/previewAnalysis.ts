import { bootstrapStatusMessage } from './bootstrap'
import { parseUserBpm, parseUserMusicKey } from './trackEdit'
import { BPM_MAX, BPM_MIN } from './types'
import type { BootstrapState } from './types'

export type PreviewAnalysisField = 'bpm' | 'key'

export interface PreviewAnalysisRequest {
  trackId: string
  field: PreviewAnalysisField
}

export const PREVIEW_ANALYSIS_FIELDS = ['bpm', 'key'] as const

export const PREVIEW_ANALYSIS_ERROR_CODES = [
  'RUNTIME_NOT_READY',
  'INVALID_REQUEST',
  'TRACK_NOT_FOUND',
  'TRACK_NOT_READY',
  'INST_MISSING',
  'IN_PROGRESS',
  'ANALYZE_FAILED',
  'TIMEOUT',
  'FIELD_UNAVAILABLE',
  'TRACK_GONE'
] as const

export type PreviewAnalysisErrorCode = (typeof PREVIEW_ANALYSIS_ERROR_CODES)[number]

export type PreviewAnalysisBpmSuccess = {
  ok: true
  field: 'bpm'
  bpm: number
  bpmConf: number | null
}

export type PreviewAnalysisKeySuccess = {
  ok: true
  field: 'key'
  musicKey: string
  keyConf: number | null
}

export type PreviewAnalysisFailure = {
  ok: false
  field: PreviewAnalysisField
  code: PreviewAnalysisErrorCode
  message: string
}

export type PreviewAnalysisResult =
  PreviewAnalysisBpmSuccess | PreviewAnalysisKeySuccess | PreviewAnalysisFailure

export const PREVIEW_ANALYSIS_MESSAGES: Record<PreviewAnalysisErrorCode, string> = {
  RUNTIME_NOT_READY: '실행 환경이 아직 준비되지 않았습니다',
  INVALID_REQUEST: '재측정 요청이 올바르지 않습니다',
  TRACK_NOT_FOUND: '곡을 찾을 수 없습니다',
  TRACK_NOT_READY: '준비된 곡만 재측정할 수 있습니다',
  INST_MISSING: '반주 파일이 없어 재측정할 수 없습니다',
  IN_PROGRESS: '이 곡은 이미 재측정 중입니다',
  ANALYZE_FAILED: '반주를 분석하지 못했습니다. 다시 시도해 주세요',
  TIMEOUT: '재측정이 시간 제한을 넘었습니다. 다시 시도해 주세요',
  FIELD_UNAVAILABLE: '이 값을 추정하지 못했습니다',
  TRACK_GONE: '곡이 삭제되었거나 더 이상 재측정할 수 없는 상태입니다'
}

const ERROR_CODE_SET = new Set<string>(PREVIEW_ANALYSIS_ERROR_CODES)

export function isPreviewAnalysisField(raw: unknown): raw is PreviewAnalysisField {
  return raw === 'bpm' || raw === 'key'
}

export function isPreviewAnalysisErrorCode(raw: unknown): raw is PreviewAnalysisErrorCode {
  return typeof raw === 'string' && ERROR_CODE_SET.has(raw)
}

/** 실패 응답용. 필드가 없으면 BPM으로 둔다 */
export function previewAnalysisFieldOf(raw: unknown): PreviewAnalysisField {
  if (raw != null && typeof raw === 'object' && !Array.isArray(raw)) {
    const field = (raw as Record<string, unknown>).field
    if (isPreviewAnalysisField(field)) return field
  }
  return 'bpm'
}

export function previewAnalysisMessage(
  code: PreviewAnalysisErrorCode,
  field: PreviewAnalysisField
): string {
  if (code === 'FIELD_UNAVAILABLE') {
    return field === 'bpm' ? 'BPM을 추정하지 못했습니다' : '원키를 추정하지 못했습니다'
  }
  return PREVIEW_ANALYSIS_MESSAGES[code]
}

export function previewAnalysisFailure(
  field: PreviewAnalysisField,
  code: PreviewAnalysisErrorCode,
  message?: string
): PreviewAnalysisFailure {
  return {
    ok: false,
    field,
    code,
    message: message ?? previewAnalysisMessage(code, field)
  }
}

export function previewAnalysisRuntimeRejection(
  field: PreviewAnalysisField,
  state: BootstrapState
): PreviewAnalysisFailure {
  const detail = bootstrapStatusMessage(state)
  const base = PREVIEW_ANALYSIS_MESSAGES.RUNTIME_NOT_READY
  const message = detail ? `${base}. ${detail}` : base
  return previewAnalysisFailure(field, 'RUNTIME_NOT_READY', message)
}

/** 렌더러가 보낸 재측정 요청. 파일 경로는 받지 않는다 */
export function sanitizePreviewAnalysisRequest(raw: unknown): PreviewAnalysisRequest | null {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const rec = raw as Record<string, unknown>
  if (typeof rec.trackId !== 'string') return null
  const trackId = rec.trackId.trim()
  if (trackId === '') return null
  if (!isPreviewAnalysisField(rec.field)) return null
  return { trackId, field: rec.field }
}

export function parsePreviewBpmValue(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  if (value < BPM_MIN || value > BPM_MAX) return null
  try {
    return parseUserBpm(value)
  } catch {
    return null
  }
}

export function parsePreviewMusicKeyValue(value: unknown): string | null {
  if (typeof value !== 'string') return null
  try {
    return parseUserMusicKey(value)
  } catch {
    return null
  }
}

/** undefined = 타입 불일치. null/undefined 입력은 null */
export function parsePreviewConfidence(value: unknown): number | null | undefined {
  if (value == null) return null
  if (typeof value === 'number' && Number.isFinite(value)) return value
  return undefined
}

/**
 * IPC 미리보기 결과를 화이트리스트 필드로만 재구성한다.
 * 성공 값의 범위·키 형식도 Main과 같은 규칙을 쓴다.
 */
export function parsePreviewAnalysisResult(raw: unknown): PreviewAnalysisResult | null {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const rec = raw as Record<string, unknown>
  if (!isPreviewAnalysisField(rec.field)) return null

  if (rec.ok === true) {
    if (rec.field === 'bpm') {
      const bpm = parsePreviewBpmValue(rec.bpm)
      if (bpm === null) return null
      const bpmConf = parsePreviewConfidence(rec.bpmConf)
      if (bpmConf === undefined) return null
      return { ok: true, field: 'bpm', bpm, bpmConf }
    }
    const musicKey = parsePreviewMusicKeyValue(rec.musicKey)
    if (musicKey === null) return null
    const keyConf = parsePreviewConfidence(rec.keyConf)
    if (keyConf === undefined) return null
    return { ok: true, field: 'key', musicKey, keyConf }
  }

  if (rec.ok !== false) return null
  if (!isPreviewAnalysisErrorCode(rec.code)) return null
  if (typeof rec.message !== 'string') return null
  return { ok: false, field: rec.field, code: rec.code, message: rec.message }
}
