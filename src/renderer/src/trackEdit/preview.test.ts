import { describe, expect, it } from 'vitest'
import { bootstrapStatusMessage } from '../../../shared/bootstrap'
import {
  PREVIEW_ANALYSIS_MESSAGES,
  previewAnalysisFailure,
  type PreviewAnalysisBpmSuccess,
  type PreviewAnalysisKeySuccess,
  type PreviewAnalysisResult
} from '../../../shared/previewAnalysis'
import { BPM_LOW_CONF } from '../../../shared/types'
import type { BootstrapState } from '../../../shared/types'
import {
  canSaveTrackEdit,
  fieldsFromSnapshot,
  keepCoverDraft,
  replaceCoverDraft,
  type CoverDraft,
  type TrackEditFields,
  type TrackEditSnapshot
} from './form'
import {
  applyPreviewAnalysisResult,
  applyPreviewSuccess,
  areAnalysisInputsLocked,
  areIdentityInputsLockedByPreview,
  canDismissTrackEditDuringPreview,
  emptyPreviewDraftHints,
  hintsAfterManualEdit,
  hintsAfterPreviewSuccess,
  isSaveBlockedByPreview,
  isStalePreviewResponse,
  nextPreviewGeneration,
  previewButtonDisableCause,
  previewButtonDisableReason,
  previewFieldStatus,
  previewInputStatusAfterSuccess,
  PREVIEW_APPLIED_HINT,
  PREVIEW_ANALYSIS_IN_FLIGHT,
  PREVIEW_BPM_LOW_CONF_HINT,
  type PreviewApplyOutcome,
  type PreviewDraftHints,
  type PreviewGenerationGuard
} from './preview'

function snapshot(overrides: Partial<TrackEditSnapshot> = {}): TrackEditSnapshot {
  return {
    title: '제목',
    artist: '가수',
    album: '앨범',
    bpm: 120,
    musicKey: 'Am',
    ...overrides
  }
}

function fieldsFrom(
  snap: TrackEditSnapshot,
  overrides: Partial<TrackEditFields> = {}
): TrackEditFields {
  return { ...fieldsFromSnapshot(snap), ...overrides }
}

function dirtyDraft(overrides: Partial<TrackEditFields> = {}): TrackEditFields {
  return fieldsFrom(snapshot(), {
    title: '편집한 제목',
    artist: '편집한 가수',
    album: '편집한 앨범',
    bpm: '90',
    musicKey: 'C',
    ...overrides
  })
}

function liveGuard(generation = 1): PreviewGenerationGuard {
  return { alive: true, generation, responseGeneration: generation }
}

function bpmOk(overrides: Partial<PreviewAnalysisBpmSuccess> = {}): PreviewAnalysisBpmSuccess {
  return { ok: true, field: 'bpm', bpm: 140, bpmConf: 0.9, ...overrides }
}

function keyOk(overrides: Partial<PreviewAnalysisKeySuccess> = {}): PreviewAnalysisKeySuccess {
  return { ok: true, field: 'key', musicKey: 'C#m', keyConf: 0.8, ...overrides }
}

function bootstrap(patch: Partial<BootstrapState> = {}): BootstrapState {
  return {
    status: 'ready',
    message: '준비 완료',
    error: null,
    log: [],
    ...patch
  }
}

function applyRaw(
  fields: TrackEditFields,
  requestedField: 'bpm' | 'key',
  result: PreviewAnalysisResult | null,
  guard: PreviewGenerationGuard = liveGuard(),
  hints: PreviewDraftHints = emptyPreviewDraftHints()
): PreviewApplyOutcome {
  return applyPreviewAnalysisResult({
    fields,
    hints,
    requestedField,
    result,
    guard
  })
}

describe('applyPreviewSuccess', () => {
  it('BPM 성공은 키·제목·앨범 초안을 건드리지 않는다', () => {
    const fields = dirtyDraft()
    expect(applyPreviewSuccess(fields, bpmOk({ bpm: 132 }))).toEqual({
      ...fields,
      bpm: '132'
    })
  })

  it('원키 성공은 BPM·제목·앨범 초안을 건드리지 않는다', () => {
    const fields = dirtyDraft()
    expect(applyPreviewSuccess(fields, keyOk({ musicKey: 'F#' }))).toEqual({
      ...fields,
      musicKey: 'F#'
    })
  })

  it('요청 필드의 더티 초안을 덮어쓴다', () => {
    const fields = dirtyDraft({ bpm: '77', musicKey: 'G' })
    expect(applyPreviewSuccess(fields, bpmOk({ bpm: 128 })).bpm).toBe('128')
    expect(applyPreviewSuccess(fields, keyOk({ musicKey: 'Dm' })).musicKey).toBe('Dm')
  })
})

describe('applyPreviewAnalysisResult', () => {
  it('BPM 성공은 커버 초안과 다른 필드를 보존한다', () => {
    const fields = dirtyDraft()
    const cover: CoverDraft = replaceCoverDraft('C:\\art.png', 'data:image/png;base64,aaa')
    const outcome = applyRaw(fields, 'bpm', bpmOk({ bpm: 150 }))
    expect(outcome.status).toBe('applied')
    if (outcome.status !== 'applied') return
    expect(outcome.fields).toEqual({ ...fields, bpm: '150' })
    expect(cover).toEqual(replaceCoverDraft('C:\\art.png', 'data:image/png;base64,aaa'))
    expect(canSaveTrackEdit(snapshot(), outcome.fields, cover)).toBe(true)
  })

  it('원키 성공은 커버 초안과 다른 필드를 보존한다', () => {
    const fields = dirtyDraft()
    const cover: CoverDraft = replaceCoverDraft('C:\\art.png', 'data:image/png;base64,aaa')
    const outcome = applyRaw(fields, 'key', keyOk({ musicKey: 'Bm' }))
    expect(outcome.status).toBe('applied')
    if (outcome.status !== 'applied') return
    expect(outcome.fields).toEqual({ ...fields, musicKey: 'Bm' })
    expect(cover.type).toBe('replace')
  })

  it('실패와 FIELD_UNAVAILABLE은 필드를 유지한다', () => {
    const fields = dirtyDraft()
    const hints = hintsAfterPreviewSuccess(emptyPreviewDraftHints(), bpmOk())
    const unavailable = applyRaw(
      fields,
      'bpm',
      previewAnalysisFailure('bpm', 'FIELD_UNAVAILABLE'),
      liveGuard(),
      hints
    )
    expect(unavailable).toEqual({
      status: 'failed',
      fields,
      hints,
      error: {
        target: 'bpm',
        message: 'BPM을 추정하지 못했습니다',
        notFound: false
      }
    })
    expect(unavailable.status === 'failed' && unavailable.fields).toBe(fields)

    const missing = applyRaw(fields, 'key', previewAnalysisFailure('key', 'INST_MISSING'))
    expect(missing.status).toBe('failed')
    if (missing.status !== 'failed') return
    expect(missing.fields).toBe(fields)
    expect(missing.error).toEqual({
      target: 'general',
      message: PREVIEW_ANALYSIS_MESSAGES.INST_MISSING,
      notFound: false
    })
  })

  it('원키 FIELD_UNAVAILABLE은 필드 오류로 두고 초안을 유지한다', () => {
    const fields = dirtyDraft()
    const outcome = applyRaw(fields, 'key', previewAnalysisFailure('key', 'FIELD_UNAVAILABLE'))
    expect(outcome.status).toBe('failed')
    if (outcome.status !== 'failed') return
    expect(outcome.fields).toBe(fields)
    expect(outcome.error).toEqual({
      target: 'musicKey',
      message: '원키를 추정하지 못했습니다',
      notFound: false
    })
  })

  it('늦은 응답(스테일 generation)은 적용하지 않는다', () => {
    const fields = dirtyDraft()
    const hints = hintsAfterPreviewSuccess(emptyPreviewDraftHints(), bpmOk())
    expect(isStalePreviewResponse({ alive: true, generation: 2, responseGeneration: 1 })).toBe(true)
    expect(isStalePreviewResponse({ alive: false, generation: 1, responseGeneration: 1 })).toBe(
      true
    )
    expect(isStalePreviewResponse(liveGuard(1))).toBe(false)

    const staleGen = applyRaw(
      fields,
      'bpm',
      bpmOk({ bpm: 200 }),
      {
        alive: true,
        generation: 2,
        responseGeneration: 1
      },
      hints
    )
    expect(staleGen).toEqual({ status: 'stale' })

    const dead = applyRaw(
      fields,
      'key',
      keyOk({ musicKey: 'E' }),
      {
        alive: false,
        generation: 1,
        responseGeneration: 1
      },
      hints
    )
    expect(dead).toEqual({ status: 'stale' })
  })

  it('닫은 뒤의 IN_PROGRESS는 오류로 보여주고 스피너를 유지하지 않는다', () => {
    const fields = dirtyDraft()
    const outcome = applyRaw(fields, 'bpm', previewAnalysisFailure('bpm', 'IN_PROGRESS'))
    expect(outcome.status).toBe('failed')
    if (outcome.status !== 'failed') return
    expect(outcome.fields).toBe(fields)
    expect(outcome.error.message).toBe(PREVIEW_ANALYSIS_MESSAGES.IN_PROGRESS)
    expect(outcome.error.notFound).toBe(false)
  })

  it('파싱 실패는 필드를 유지하고 ANALYZE_FAILED 메시지를 쓴다', () => {
    const fields = dirtyDraft()
    const outcome = applyRaw(fields, 'key', null)
    expect(outcome.status).toBe('failed')
    if (outcome.status !== 'failed') return
    expect(outcome.fields).toBe(fields)
    expect(outcome.error.message).toBe(PREVIEW_ANALYSIS_MESSAGES.ANALYZE_FAILED)
  })
})

describe('canSaveTrackEdit after preview apply', () => {
  it('같은 값 적용이고 다른 수정이 없으면 저장할 수 없다', () => {
    const snap = snapshot({ bpm: 120, musicKey: 'Am' })
    const bpmSame = applyPreviewSuccess(fieldsFrom(snap), bpmOk({ bpm: 120 }))
    expect(canSaveTrackEdit(snap, bpmSame, keepCoverDraft())).toBe(false)
    const keySame = applyPreviewSuccess(fieldsFrom(snap), keyOk({ musicKey: 'Am' }))
    expect(canSaveTrackEdit(snap, keySame, keepCoverDraft())).toBe(false)
  })

  it('다른 값 적용이면 저장할 수 있다', () => {
    const snap = snapshot()
    const bpmChanged = applyPreviewSuccess(fieldsFrom(snap), bpmOk({ bpm: 140 }))
    expect(canSaveTrackEdit(snap, bpmChanged, keepCoverDraft())).toBe(true)
    const keyChanged = applyPreviewSuccess(fieldsFrom(snap), keyOk({ musicKey: 'C#m' }))
    expect(canSaveTrackEdit(snap, keyChanged, keepCoverDraft())).toBe(true)
  })
})

describe('preview draft hints', () => {
  it('측정값은 입력에 넣고 안내는 상태 아이콘 메시지로만 둔다', () => {
    const fields = dirtyDraft({ bpm: '77', musicKey: 'G' })
    const lowBpm = bpmOk({ bpm: 128, bpmConf: BPM_LOW_CONF - 0.1 })
    const highBpm = bpmOk({ bpm: 128, bpmConf: 0.9 })
    const lowKey = keyOk({ musicKey: 'Am', keyConf: 0.1 })

    expect(applyPreviewSuccess(fields, lowBpm).bpm).toBe('128')
    expect(applyPreviewSuccess(fields, lowKey).musicKey).toBe('Am')
    expect(previewInputStatusAfterSuccess(lowBpm)).toEqual({
      kind: 'uncertain',
      message: PREVIEW_BPM_LOW_CONF_HINT
    })
    expect(previewInputStatusAfterSuccess(lowBpm).message).not.toContain('128')
    expect(previewInputStatusAfterSuccess(highBpm)).toEqual({
      kind: 'applied',
      message: PREVIEW_APPLIED_HINT
    })
    expect(previewInputStatusAfterSuccess(lowKey)).toEqual({
      kind: 'applied',
      message: PREVIEW_APPLIED_HINT
    })
  })

  it('요청 중인 필드만 pending 아이콘을 쓰고 다른 필드 안내는 유지한다', () => {
    const hints = hintsAfterPreviewSuccess(emptyPreviewDraftHints(), keyOk())
    expect(previewFieldStatus('bpm', 'bpm', hints)).toEqual({
      kind: 'pending',
      message: PREVIEW_ANALYSIS_IN_FLIGHT
    })
    expect(previewFieldStatus('key', 'bpm', hints)).toEqual({
      kind: 'applied',
      message: PREVIEW_APPLIED_HINT
    })
    expect(previewFieldStatus('bpm', null, emptyPreviewDraftHints())).toBeNull()
  })

  it('적용 후 해당 필드를 수동 편집하면 그 필드 안내만 지운다', () => {
    let hints = emptyPreviewDraftHints()
    hints = hintsAfterPreviewSuccess(hints, bpmOk({ bpm: 128, bpmConf: 0.2 }))
    hints = hintsAfterPreviewSuccess(hints, keyOk({ musicKey: 'Dm', keyConf: 0.1 }))
    expect(hints.bpm).toEqual({ kind: 'uncertain', message: PREVIEW_BPM_LOW_CONF_HINT })
    expect(hints.key).toEqual({ kind: 'applied', message: PREVIEW_APPLIED_HINT })

    const afterTitle = hintsAfterManualEdit(hints, { title: '다른 제목' })
    expect(afterTitle).toEqual(hints)

    const afterBpm = hintsAfterManualEdit(hints, { bpm: '130' })
    expect(afterBpm).toEqual({ bpm: null, key: hints.key })

    const afterKey = hintsAfterManualEdit(hints, { musicKey: 'Em' })
    expect(afterKey).toEqual({ bpm: hints.bpm, key: null })
  })
})

describe('preview button disablement', () => {
  const enabled = {
    trackStatus: 'ready' as const,
    bootstrap: bootstrap(),
    inFlight: false,
    saving: false,
    notFound: false
  }

  it('준비되지 않은 곡은 비활성화하고 TRACK_NOT_READY 사유를 쓴다', () => {
    for (const trackStatus of ['imported', 'separating', 'failed'] as const) {
      const cause = previewButtonDisableCause({ ...enabled, trackStatus })
      expect(cause).toBe('trackNotReady')
      expect(
        previewButtonDisableReason(cause, { field: 'bpm', bootstrap: enabled.bootstrap })
      ).toBe(PREVIEW_ANALYSIS_MESSAGES.TRACK_NOT_READY)
    }
  })

  it('런타임 미준비는 R1 한국어 사유를 표시한다', () => {
    const downloading = bootstrap({
      status: 'download',
      stage: 'download',
      message: '실행 환경 다운로드 중'
    })
    const cause = previewButtonDisableCause({ ...enabled, bootstrap: downloading })
    expect(cause).toBe('runtimeNotReady')
    const reason = previewButtonDisableReason(cause, { field: 'key', bootstrap: downloading })
    expect(reason).toContain(PREVIEW_ANALYSIS_MESSAGES.RUNTIME_NOT_READY)
    expect(reason).toContain(bootstrapStatusMessage(downloading))
  })

  it('요청 중에는 버튼을 막고 대기 문구를 사유로 쓴다', () => {
    const cause = previewButtonDisableCause({ ...enabled, inFlight: true })
    expect(cause).toBe('inFlight')
    expect(previewButtonDisableReason(cause, { field: 'bpm', bootstrap: enabled.bootstrap })).toBe(
      PREVIEW_ANALYSIS_IN_FLIGHT
    )
  })

  it('저장 중·없는 곡도 다른 동작과 같이 막는다', () => {
    expect(previewButtonDisableCause({ ...enabled, saving: true })).toBe('saving')
    expect(previewButtonDisableCause({ ...enabled, notFound: true })).toBe('notFound')
    expect(
      previewButtonDisableReason('saving', { field: 'bpm', bootstrap: enabled.bootstrap })
    ).toBeNull()
    expect(previewButtonDisableCause(enabled)).toBeNull()
  })
})

describe('preview locks', () => {
  it('요청 중에는 저장을 막고 분석 입력만 잠근다', () => {
    expect(isSaveBlockedByPreview(true)).toBe(true)
    expect(isSaveBlockedByPreview(false)).toBe(false)
    expect(areAnalysisInputsLocked({ inFlight: true, saving: false })).toBe(true)
    expect(areAnalysisInputsLocked({ inFlight: false, saving: true })).toBe(true)
    expect(areAnalysisInputsLocked({ inFlight: false, saving: false })).toBe(false)
    expect(areIdentityInputsLockedByPreview(true)).toBe(false)
    expect(areIdentityInputsLockedByPreview(false)).toBe(false)
  })

  it('미리보기 대기 중에도 취소·Escape는 가능하다', () => {
    expect(canDismissTrackEditDuringPreview(false)).toBe(true)
    expect(canDismissTrackEditDuringPreview(true)).toBe(false)
    expect(nextPreviewGeneration(3)).toBe(4)
  })
})
