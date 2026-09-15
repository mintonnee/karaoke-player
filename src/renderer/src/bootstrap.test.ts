import { describe, expect, it } from 'vitest'
import { bootstrapChrome, isRuntimeActionAllowed, isRuntimeReady } from '../../shared/bootstrap'
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
  it('빈 라이브러리는 준비 패널을 보여주고 가져오기를 끈다', () => {
    const state = bootstrap({ status: 'download', stage: 'download', logicalId: 'cpython' })
    const tracks: Track[] = []
    expect(bootstrapChrome(state, { trackCount: tracks.length })).toBe('panel')
    expect(isRuntimeActionAllowed(state)).toBe(false)
    expect(isRuntimeReady(state)).toBe(false)
  })

  it('ready 트랙이 있으면 목록·재생은 열고 가져오기만 막는다', () => {
    const state = bootstrap({
      status: 'error',
      stage: 'env-prep',
      logicalId: 'uv',
      error: 'runtime command 종료 코드 1',
      retryable: true
    })
    const tracks = [readyTrack()]
    expect(tracks.some((t) => t.status === 'ready')).toBe(true)
    expect(bootstrapChrome(state, { trackCount: tracks.length })).toBe('strip')
    expect(isRuntimeActionAllowed(state)).toBe(false)
  })

  it('runtime이 ready면 배너를 숨기고 작업을 허용한다', () => {
    const state = bootstrap({ status: 'ready', message: '준비 완료' })
    expect(bootstrapChrome(state, { trackCount: 0 })).toBe('hidden')
    expect(isRuntimeActionAllowed(state)).toBe(true)
  })
})
