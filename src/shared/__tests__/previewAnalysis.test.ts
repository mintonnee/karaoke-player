import { describe, expect, it } from 'vitest'
import { bootstrapStatusMessage } from '../bootstrap'
import {
  PREVIEW_ANALYSIS_ERROR_CODES,
  PREVIEW_ANALYSIS_MESSAGES,
  parsePreviewAnalysisResult,
  parsePreviewBpmValue,
  parsePreviewConfidence,
  parsePreviewMusicKeyValue,
  previewAnalysisFailure,
  previewAnalysisFieldOf,
  previewAnalysisMessage,
  previewAnalysisRuntimeRejection,
  sanitizePreviewAnalysisRequest,
  type PreviewAnalysisResult
} from '../previewAnalysis'
import { BPM_MAX, BPM_MIN, IPC_CHANNELS } from '../types'
import type { BootstrapState } from '../types'

describe('sanitizePreviewAnalysisRequest', () => {
  it('trackId를 trim하고 bpm|key만 받는다', () => {
    expect(sanitizePreviewAnalysisRequest({ trackId: '  t1  ', field: 'bpm' })).toEqual({
      trackId: 't1',
      field: 'bpm'
    })
    expect(sanitizePreviewAnalysisRequest({ trackId: 't1', field: 'key' })).toEqual({
      trackId: 't1',
      field: 'key'
    })
  })

  it('파일 경로 등 임의 필드는 버리고 잘못된 요청은 거부한다', () => {
    expect(
      sanitizePreviewAnalysisRequest({
        trackId: 't1',
        field: 'bpm',
        filePath: 'C:\\evil\\inst.wav'
      })
    ).toEqual({ trackId: 't1', field: 'bpm' })
    expect(sanitizePreviewAnalysisRequest(null)).toBeNull()
    expect(sanitizePreviewAnalysisRequest({ field: 'bpm' })).toBeNull()
    expect(sanitizePreviewAnalysisRequest({ trackId: '  ', field: 'bpm' })).toBeNull()
    expect(sanitizePreviewAnalysisRequest({ trackId: 't1', field: 'tempo' })).toBeNull()
    expect(sanitizePreviewAnalysisRequest({ trackId: 't1' })).toBeNull()
  })
})

describe('previewAnalysisFieldOf / failure helpers', () => {
  it('필드가 있으면 그대로, 없으면 bpm으로 둔다', () => {
    expect(previewAnalysisFieldOf({ field: 'key' })).toBe('key')
    expect(previewAnalysisFieldOf({ field: 'tempo' })).toBe('bpm')
    expect(previewAnalysisFieldOf(null)).toBe('bpm')
  })

  it('필드별 추정 실패 문구와 런타임 미준비 문구를 만든다', () => {
    expect(previewAnalysisMessage('FIELD_UNAVAILABLE', 'bpm')).toBe('BPM을 추정하지 못했습니다')
    expect(previewAnalysisMessage('FIELD_UNAVAILABLE', 'key')).toBe('원키를 추정하지 못했습니다')
    expect(previewAnalysisFailure('key', 'IN_PROGRESS')).toEqual({
      ok: false,
      field: 'key',
      code: 'IN_PROGRESS',
      message: PREVIEW_ANALYSIS_MESSAGES.IN_PROGRESS
    })

    const downloading: BootstrapState = {
      status: 'download',
      stage: 'download',
      message: '실행 환경 다운로드 중',
      error: null,
      log: []
    }
    const rejection = previewAnalysisRuntimeRejection('bpm', downloading)
    expect(rejection.ok).toBe(false)
    if (rejection.ok) return
    expect(rejection.code).toBe('RUNTIME_NOT_READY')
    expect(rejection.message).toContain(PREVIEW_ANALYSIS_MESSAGES.RUNTIME_NOT_READY)
    expect(rejection.message).toContain(bootstrapStatusMessage(downloading))
  })
})

describe('parsePreviewBpmValue / parsePreviewMusicKeyValue', () => {
  it('범위·형식만 통과하고 null/잘못된 값은 실패로 둔다', () => {
    expect(parsePreviewBpmValue(128)).toBe(128)
    expect(parsePreviewBpmValue(BPM_MIN)).toBe(BPM_MIN)
    expect(parsePreviewBpmValue(BPM_MAX)).toBe(BPM_MAX)
    expect(parsePreviewBpmValue(BPM_MIN - 1)).toBeNull()
    expect(parsePreviewBpmValue(BPM_MAX + 1)).toBeNull()
    expect(parsePreviewBpmValue(null)).toBeNull()
    expect(parsePreviewBpmValue('128')).toBeNull()
    expect(parsePreviewBpmValue(Number.NaN)).toBeNull()

    expect(parsePreviewMusicKeyValue('C#m')).toBe('C#m')
    expect(parsePreviewMusicKeyValue('  Bm  ')).toBe('Bm')
    expect(parsePreviewMusicKeyValue(null)).toBeNull()
    expect(parsePreviewMusicKeyValue('')).toBeNull()
    expect(parsePreviewMusicKeyValue('Db')).toBeNull()
    expect(parsePreviewMusicKeyValue('c#')).toBeNull()
    expect(parsePreviewMusicKeyValue('H')).toBeNull()
  })

  it('신뢰도는 유한 숫자 또는 null이다', () => {
    expect(parsePreviewConfidence(0.2)).toBe(0.2)
    expect(parsePreviewConfidence(0)).toBe(0)
    expect(parsePreviewConfidence(null)).toBeNull()
    expect(parsePreviewConfidence('0.2')).toBeUndefined()
  })
})

describe('parsePreviewAnalysisResult', () => {
  const bpmOk: PreviewAnalysisResult = {
    ok: true,
    field: 'bpm',
    bpm: 128,
    bpmConf: 0.2
  }
  const keyOk: PreviewAnalysisResult = {
    ok: true,
    field: 'key',
    musicKey: 'C#m',
    keyConf: null
  }
  const failed: PreviewAnalysisResult = {
    ok: false,
    field: 'bpm',
    code: 'INST_MISSING',
    message: PREVIEW_ANALYSIS_MESSAGES.INST_MISSING
  }

  it('성공·실패 유니온을 화이트리스트로만 재구성한다', () => {
    expect(parsePreviewAnalysisResult({ ...bpmOk, filePath: 'x' })).toEqual(bpmOk)
    expect(parsePreviewAnalysisResult(keyOk)).toEqual(keyOk)
    expect(parsePreviewAnalysisResult(failed)).toEqual(failed)
    expect(IPC_CHANNELS.previewTrackAnalysis).toBe('library:preview-track-analysis')
    expect(PREVIEW_ANALYSIS_ERROR_CODES).toContain('TRACK_GONE')
  })

  it('범위 밖 성공값·알 수 없는 코드는 거부한다', () => {
    expect(
      parsePreviewAnalysisResult({ ok: true, field: 'bpm', bpm: 12, bpmConf: null })
    ).toBeNull()
    expect(
      parsePreviewAnalysisResult({ ok: true, field: 'key', musicKey: 'Db', keyConf: null })
    ).toBeNull()
    expect(
      parsePreviewAnalysisResult({
        ok: false,
        field: 'bpm',
        code: 'NOPE',
        message: 'x'
      })
    ).toBeNull()
    expect(parsePreviewAnalysisResult(null)).toBeNull()
  })
})
