import { describe, expect, it } from 'vitest'
import {
  bootstrapStatusMessage,
  isBootstrapInProgress,
  isRuntimeActionAllowed,
  isRuntimeReady
} from '../../shared/bootstrap'
import type { BootstrapState, Track } from '../../shared/types'

function bootstrap(patch: Partial<BootstrapState> = {}): BootstrapState {
  return {
    status: 'checking',
    message: '사이드카 환경 확인 중',
    error: null,
    log: [],
    ...patch
  }
}

function readyTrack(): Track {
  return {
    id: 't1',
    title: 'Ready Song',
    artist: null,
    album: null,
    duration: 10,
    sourcePath: 'C:/tracks/t1/source.m4a',
    status: 'ready',
    lyricsSource: 'none',
    bpm: null,
    musicKey: null,
    bpmConf: null,
    keyConf: null,
    analysisSource: 'none',
    importKind: 'separated',
    guideKind: 'vocal_only',
    createdAt: '2026-09-16T00:00:00.000Z',
    updatedAt: '2026-09-16T00:00:00.000Z'
  }
}

describe('library UI when bootstrap is not ready', () => {
  it('미수신·준비 단계는 알림 진행 상태이며 runtime 동작만 막는다', () => {
    const state = bootstrap({ status: 'download', stage: 'download', logicalId: 'cpython' })
    expect(isBootstrapInProgress(null)).toBe(true)
    expect(isBootstrapInProgress(state)).toBe(true)
    expect(bootstrapStatusMessage(state)).toBe('실행 환경 다운로드 중')
    expect(isRuntimeActionAllowed(state)).toBe(false)
    expect(isRuntimeReady(state)).toBe(false)
  })

  it('runtime 실패여도 기존 ready 트랙은 재생 대상으로 유지한다', () => {
    const state = bootstrap({
      status: 'error',
      stage: 'env-prep',
      logicalId: 'uv',
      error: 'runtime command 종료 코드 1',
      retryable: true
    })
    const tracks = [readyTrack()]
    expect(tracks.some((track) => track.status === 'ready')).toBe(true)
    expect(isBootstrapInProgress(state)).toBe(false)
    expect(isRuntimeActionAllowed(state)).toBe(false)
  })

  it('ready와 model-prep의 runtime 가용성을 구분한다', () => {
    const ready = bootstrap({ status: 'ready', message: '준비 완료' })
    const modelPrep = bootstrap({ status: 'model-prep', stage: 'model-prep' })
    expect(isBootstrapInProgress(ready)).toBe(false)
    expect(bootstrapStatusMessage(ready)).toBeNull()
    expect(isRuntimeActionAllowed(ready)).toBe(true)
    expect(isBootstrapInProgress(modelPrep)).toBe(true)
    expect(isRuntimeActionAllowed(modelPrep)).toBe(true)
    expect(bootstrapStatusMessage(modelPrep)).toBe('모델 준비 중')
  })
})
