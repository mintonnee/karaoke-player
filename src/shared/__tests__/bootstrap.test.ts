import { describe, expect, it } from 'vitest'
import {
  bootstrapStatusMessage,
  bootstrapChrome,
  bootstrapDisplayStage,
  formatRuntimeBlockedMessage,
  isBootstrapInProgress,
  isBootstrapRetryable,
  isRuntimeActionAllowed,
  isRuntimeReady,
  runtimeActionRejection
} from '../bootstrap'
import { isRegisteredDemucsModel, modelIdForWorker } from '../types'
import type { BootstrapState } from '../types'

function state(patch: Partial<BootstrapState> = {}): BootstrapState {
  return {
    status: 'checking',
    message: '확인 중',
    error: null,
    log: [],
    ...patch
  }
}

describe('isRuntimeReady', () => {
  it('ready와 model-prep만 라이브러리 작업을 허용한다', () => {
    expect(isRuntimeReady(null)).toBe(false)
    expect(isRuntimeReady(state({ status: 'checking' }))).toBe(false)
    expect(isRuntimeReady(state({ status: 'copying' }))).toBe(false)
    expect(isRuntimeReady(state({ status: 'download' }))).toBe(false)
    expect(isRuntimeReady(state({ status: 'error', error: 'fail' }))).toBe(false)
    expect(isRuntimeReady(state({ status: 'ready' }))).toBe(true)
    expect(isRuntimeReady(state({ status: 'model-prep', stage: 'model-prep' }))).toBe(true)
  })
})

describe('bootstrapChrome', () => {
  it('준비 전이면 빈 목록은 패널, 기존 곡이 있으면 상태 줄', () => {
    const downloading = state({ status: 'download', stage: 'download' })
    expect(bootstrapChrome(downloading, { trackCount: 0 })).toBe('panel')
    expect(bootstrapChrome(downloading, { trackCount: 2 })).toBe('strip')
    expect(bootstrapChrome(state({ status: 'ready' }), { trackCount: 0 })).toBe('hidden')
    expect(bootstrapChrome(null, { trackCount: 0 })).toBe('hidden')
  })

  it('model-prep은 재생을 막지 않고 진행만 표시한다', () => {
    const prep = state({ status: 'model-prep', stage: 'model-prep', logicalId: 'htdemucs_ft' })
    expect(isRuntimeActionAllowed(prep)).toBe(true)
    expect(bootstrapChrome(prep, { trackCount: 0 })).toBe('panel')
    expect(bootstrapChrome(prep, { trackCount: 1 })).toBe('strip')
  })
})

describe('bootstrapDisplayStage', () => {
  it('L2 copying/syncing을 download/env-prep으로 대응한다', () => {
    expect(bootstrapDisplayStage(state({ status: 'copying' }))).toBe('download')
    expect(bootstrapDisplayStage(state({ status: 'syncing' }))).toBe('env-prep')
    expect(bootstrapDisplayStage(state({ status: 'verify', stage: 'verify' }))).toBe('verify')
  })
})

describe('notification bootstrap status', () => {
  it('미수신과 준비 단계는 진행 중이고 단계 중심 문구를 사용한다', () => {
    expect(isBootstrapInProgress(null)).toBe(true)
    expect(bootstrapStatusMessage(null)).toBe('준비 상태 확인 중')

    const cases = [
      [state({ status: 'copying' }), '실행 환경 다운로드 중'],
      [state({ status: 'verify', stage: 'verify' }), '다운로드 파일 확인 중'],
      [state({ status: 'syncing' }), '실행 환경 구성 중'],
      [state({ status: 'model-prep', stage: 'model-prep' }), '모델 준비 중']
    ] as const
    for (const [current, message] of cases) {
      expect(isBootstrapInProgress(current)).toBe(true)
      expect(bootstrapStatusMessage(current)).toBe(message)
    }
  })

  it('ready는 숨기고 error는 실패 문구를 보존하며 진행으로 보지 않는다', () => {
    const ready = state({ status: 'ready' })
    const failed = state({ status: 'error', message: '구성 실패', error: 'sha256 mismatch' })
    expect(isBootstrapInProgress(ready)).toBe(false)
    expect(bootstrapStatusMessage(ready)).toBeNull()
    expect(isBootstrapInProgress(failed)).toBe(false)
    expect(bootstrapStatusMessage(failed)).toBe('sha256 mismatch')
  })
})

describe('runtime-needed action', () => {
  it('준비 전에는 거부 사유에 id·stage·retryable을 포함한다', () => {
    const failed = state({
      status: 'error',
      stage: 'download',
      logicalId: 'uv',
      retryable: true,
      error: 'sha256 mismatch',
      message: '사이드카 환경 구성 실패'
    })
    expect(isRuntimeActionAllowed(failed)).toBe(false)
    expect(isBootstrapRetryable(failed)).toBe(true)
    const message = formatRuntimeBlockedMessage(failed)
    expect(message).toContain('id=uv')
    expect(message).toContain('stage=download')
    expect(message).toContain('retryable=true')
    expect(message).not.toMatch(/캐시 삭제|라이브러리 초기화|wipe/i)
    expect(runtimeActionRejection(failed, 'song.mp3')).toEqual({
      filePath: 'song.mp3',
      reason: message
    })
  })

  it('명시적으로 재구성 가능한 runtime 오류만 재시도 가능하다', () => {
    const missingManifest = state({
      status: 'error',
      stage: 'verify',
      logicalId: 'runtime-manifest',
      error: 'manifest missing'
    })
    expect(isBootstrapRetryable(missingManifest)).toBe(false)
    expect(formatRuntimeBlockedMessage(missingManifest)).toContain('retryable=false')
    expect(isBootstrapRetryable({ ...missingManifest, retryable: false })).toBe(false)
    expect(isBootstrapRetryable({ ...missingManifest, retryable: true })).toBe(true)
    expect(isBootstrapRetryable(state({ status: 'model-prep', retryable: true }))).toBe(false)
  })
})

describe('isRegisteredDemucsModel', () => {
  it('등록된 ID만 허용하고 경로·URL은 거부한다', () => {
    expect(isRegisteredDemucsModel('htdemucs_ft')).toBe(true)
    expect(isRegisteredDemucsModel('htdemucs')).toBe(true)
    expect(isRegisteredDemucsModel('not-a-model')).toBe(false)
    expect(isRegisteredDemucsModel('https://example.com/model.th')).toBe(false)
    expect(isRegisteredDemucsModel('C:\\\\models\\\\htdemucs')).toBe(false)
  })
})

describe('modelIdForWorker', () => {
  it('worker 명령에 고정 모델 ID를 연결한다', () => {
    expect(modelIdForWorker('separate', 'htdemucs')).toBe('htdemucs')
    expect(modelIdForWorker('transcribe', 'htdemucs')).toBe('large-v3-turbo')
    expect(modelIdForWorker('align', 'htdemucs')).toBe('mms-fa')
    expect(modelIdForWorker('analyze', 'htdemucs')).toBe('beat-this-final0')
    expect(modelIdForWorker('probe', 'htdemucs')).toBeNull()
    expect(modelIdForWorker('cover', 'htdemucs')).toBeNull()
  })
})
