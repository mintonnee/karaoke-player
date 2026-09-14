const unmuted = { masterMuted: false, instMuted: false, vocalMuted: false }
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Track, TrackVolumes } from '../../../../shared/types'

const { engine, reportError } = vi.hoisted(() => ({
  engine: {
    state: 'ready',
    duration: 180,
    load: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn(),
    setGain: vi.fn(),
    setPitch: vi.fn(),
    onPosition: vi.fn(),
    onEnded: vi.fn()
  },
  reportError: vi.fn()
}))
vi.mock('../../audio/WebAudioEngine', () => ({
  WebAudioEngine: class {
    constructor() {
      return engine
    }
  }
}))
vi.mock('../errorStore', () => ({ reportError }))

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const track = (id: string, guideKind: Track['guideKind'] = 'vocal_only'): Track => ({
  id,
  title: id,
  artist: null,
  album: null,
  duration: 180,
  sourcePath: 'song.wav',
  status: 'ready',
  lyricsSource: 'none',
  bpm: null,
  musicKey: null,
  bpmConf: null,
  keyConf: null,
  analysisSource: 'none',
  importKind: 'paired',
  guideKind,
  createdAt: '',
  updatedAt: ''
})
let store: (typeof import('../playerStore'))['usePlayerStore']
let saved: Map<string, TrackVolumes>
let pitches: Map<string, number>
const api = {
  guideVocalDefaultDb: -20,
  getTrackPitch: vi.fn<(id: string) => Promise<number>>(),
  setTrackPitch: vi.fn<(id: string, pitch: number) => Promise<void>>(),
  onTrackUpdated: vi.fn(),
  trackFiles: vi.fn().mockResolvedValue({ inst: 'inst.wav', guide: 'vocal.wav' }),
  getTrackVolumes: vi.fn<(id: string) => Promise<TrackVolumes | null>>(),
  setTrackVolumes: vi.fn<(id: string, volumes: TrackVolumes) => Promise<void>>()
}

beforeEach(async () => {
  vi.resetModules()
  vi.clearAllMocks()
  saved = new Map()
  pitches = new Map()
  api.getTrackPitch.mockImplementation(async (id) => pitches.get(id) ?? 0)
  api.setTrackPitch.mockImplementation(async (id, pitch) => {
    pitches.set(id, pitch)
  })
  api.getTrackVolumes.mockImplementation(async (id) => saved.get(id) ?? null)
  api.setTrackVolumes.mockImplementation(async (id, volumes) => {
    saved.set(id, volumes)
  })
  vi.stubGlobal('window', { api })
  store = (await import('../playerStore')).usePlayerStore
})
afterEach(() => vi.unstubAllGlobals())

it('곡별 볼륨을 자동 저장하고 오래된 Track 객체로 재로드해도 최신 값을 엔진에 복원한다', async () => {
  const a = track('a')
  await store.getState().loadTrack(a)
  store.getState().setMasterDb(-3)
  store.getState().setInstDb(-5)
  store.getState().setVocalDb(-12)
  await store.getState().loadTrack(track('b'))
  expect(store.getState()).toMatchObject({ ...unmuted, masterDb: 0, instDb: 0, vocalDb: -20 })
  store.getState().setInstDb(-9)
  await store.getState().loadTrack(a)
  expect(store.getState()).toMatchObject({ ...unmuted, masterDb: -3, instDb: -5, vocalDb: -12 })
  expect(engine.setGain).toHaveBeenCalledWith('inst', -8)
  expect(engine.setGain).toHaveBeenCalledWith('vocal', -15)
  expect(saved.get('b')?.instDb).toBe(-9)
})

it.each(['vocal_only', 'full_mix', 'none'] as const)(
  '%s에서 볼륨과 뮤트를 복원하고 소스는 초기화한다',
  async (kind) => {
    saved.set('a', { ...unmuted, masterDb: -2, instDb: -6, vocalDb: -10 })
    await store.getState().loadTrack(track('a', kind))
    store.getState().toggleMasterMute()
    store.getState().toggleInstMute()
    store.getState().toggleVocalMute()
    await store.getState().loadTrack(track('a', kind))
    expect(store.getState()).toMatchObject({
      masterDb: -2,
      instDb: -6,
      vocalDb: -10,
      masterMuted: true,
      instMuted: kind !== 'full_mix',
      vocalMuted: kind === 'vocal_only',
      mixSource: 'mr'
    })
    expect(api.setTrackVolumes).toHaveBeenCalledTimes(
      kind === 'vocal_only' ? 3 : kind === 'none' ? 2 : 1
    )
    expect(engine.setGain).toHaveBeenCalledWith('inst', -Infinity)
    expect(engine.setGain).toHaveBeenCalledWith('vocal', -Infinity)
  }
)

it('저장값 없는 AR은 0 dB 기본값을 사용한다', async () => {
  await store.getState().loadTrack(track('a', 'full_mix'))
  expect(store.getState()).toMatchObject({ ...unmuted, masterDb: 0, instDb: 0, vocalDb: 0 })
})

it('완료되지 않은 저장을 기다린 뒤 같은 곡의 볼륨을 읽는다', async () => {
  await store.getState().loadTrack(track('a'))
  const pending = deferred<void>()
  api.setTrackVolumes.mockImplementationOnce(async (id, volumes) => {
    await pending.promise
    saved.set(id, volumes)
  })
  store.getState().setInstDb(-7)
  api.getTrackVolumes.mockClear()
  const loading = store.getState().loadTrack(track('a'))
  expect(api.getTrackVolumes).not.toHaveBeenCalled()
  pending.resolve(undefined)
  await loading
  expect(store.getState().instDb).toBe(-7)
})

it('늦게 도착한 이전 곡의 조회 결과는 현재 곡에 적용하지 않는다', async () => {
  const pending = deferred<TrackVolumes | null>()
  api.getTrackVolumes.mockImplementationOnce(() => pending.promise)
  const first = store.getState().loadTrack(track('a'))
  await vi.waitFor(() => expect(api.getTrackVolumes).toHaveBeenCalledWith('a'))
  await store.getState().loadTrack(track('b'))
  pending.resolve({ ...unmuted, masterDb: -50, instDb: -50, vocalDb: -50 })
  await first
  expect(store.getState().track?.id).toBe('b')
  expect(store.getState().masterDb).toBe(0)
  expect(engine.load).toHaveBeenCalledTimes(1)
})

it('unload 후 늦은 조회 결과를 무시한다', async () => {
  const pending = deferred<TrackVolumes | null>()
  api.getTrackVolumes.mockImplementationOnce(() => pending.promise)
  const loading = store.getState().loadTrack(track('a'))
  await vi.waitFor(() => expect(api.getTrackVolumes).toHaveBeenCalled())
  store.getState().unload()
  pending.resolve({ ...unmuted, masterDb: -50, instDb: -50, vocalDb: -50 })
  await loading
  expect(store.getState().track).toBeNull()
  expect(engine.load).not.toHaveBeenCalled()
})

it('저장 실패는 재생 볼륨을 유지하면서 오류 센터에 알린다', async () => {
  await store.getState().loadTrack(track('a'))
  api.setTrackVolumes.mockRejectedValueOnce(new Error('disk full'))
  store.getState().setMasterDb(-4)
  await vi.waitFor(() =>
    expect(reportError).toHaveBeenCalledWith('player', expect.stringContaining('disk full'), 'a')
  )
  expect(store.getState().masterDb).toBe(-4)
})

it('로드 중이거나 비정상적인 볼륨 입력은 저장하지 않는다', async () => {
  const loading = store.getState().loadTrack(track('a'))
  store.getState().setMasterDb(-5)
  store.getState().toggleMasterMute()
  store.getState().toggleInstMute()
  store.getState().toggleVocalMute()
  await loading
  store.getState().setInstDb(NaN)
  store.getState().setVocalDb(Infinity)
  expect(api.setTrackVolumes).not.toHaveBeenCalled()
})

it('채널 뮤트와 해제를 곡별로 저장하고 페이더 변경 후에도 유지한다', async () => {
  await store.getState().loadTrack(track('a'))
  store.getState().toggleVocalMute()
  store.getState().setMasterDb(-4)
  await store.getState().loadTrack(track('b'))
  expect(store.getState().vocalMuted).toBe(false)
  await store.getState().loadTrack(track('a'))
  expect(store.getState()).toMatchObject({ vocalMuted: true, masterMuted: false, masterDb: -4 })
  expect(engine.setGain).toHaveBeenLastCalledWith('vocal', -Infinity)
  store.getState().toggleVocalMute()
  await store.getState().loadTrack(track('a'))
  expect(store.getState().vocalMuted).toBe(false)
  expect(engine.setGain).toHaveBeenCalledWith('vocal', -24)
})

it('곡별 조정키를 자동 저장·복원하고 원키 리셋도 저장한다', async () => {
  const a = track('a')
  await store.getState().loadTrack(a)
  store.getState().setPitch(2)
  expect(engine.setPitch).toHaveBeenLastCalledWith(2)
  await store.getState().loadTrack(track('b'))
  expect(store.getState().pitch).toBe(0)
  expect(engine.setPitch).toHaveBeenLastCalledWith(0)
  store.getState().setPitch(-3)
  await store.getState().loadTrack(a)
  expect(store.getState().pitch).toBe(2)
  expect(engine.setPitch).toHaveBeenLastCalledWith(2)
  store.getState().setPitch(0)
  await store.getState().loadTrack(a)
  expect(store.getState().pitch).toBe(0)
  expect(pitches.get('b')).toBe(-3)
})

it('연속 키 조정은 직렬 저장하며 재로드는 마지막 저장을 기다린다', async () => {
  await store.getState().loadTrack(track('a'))
  const pending = deferred<void>()
  api.setTrackPitch.mockImplementationOnce(async (id, pitch) => {
    await pending.promise
    pitches.set(id, pitch)
  })
  store.getState().setPitch(1)
  store.getState().setPitch(3)
  await vi.waitFor(() => expect(api.setTrackPitch).toHaveBeenCalledTimes(1))
  const loading = store.getState().loadTrack(track('a'))
  pending.resolve(undefined)
  await loading
  expect(pitches.get('a')).toBe(3)
  expect(store.getState().pitch).toBe(3)
  expect(engine.setPitch).toHaveBeenLastCalledWith(3)
})

it.each([false, true])('늦은 키 조회는 곡 전환·unload 후 무시한다: %s', async (unload) => {
  const pending = deferred<number>()
  api.getTrackPitch.mockImplementationOnce(() => pending.promise)
  const loading = store.getState().loadTrack(track('a'))
  await vi.waitFor(() => expect(api.getTrackPitch).toHaveBeenCalledWith('a'))
  if (unload) store.getState().unload()
  else await store.getState().loadTrack(track('b'))
  pending.resolve(5)
  await loading
  expect(store.getState().track?.id).toBe(unload ? undefined : 'b')
  expect(store.getState().pitch).toBe(0)
  expect(engine.setPitch).not.toHaveBeenCalledWith(5)
})

it('키 저장 실패는 재생 값을 유지하고 다음 저장을 막지 않는다', async () => {
  await store.getState().loadTrack(track('a'))
  api.setTrackPitch.mockRejectedValueOnce(new Error('disk full'))
  store.getState().setPitch(2)
  await vi.waitFor(() =>
    expect(reportError).toHaveBeenCalledWith(
      'player',
      expect.stringContaining('조정키 저장 실패'),
      'a'
    )
  )
  expect(store.getState().pitch).toBe(2)
  store.getState().setPitch(3)
  await store.getState().loadTrack(track('a'))
  expect(store.getState().pitch).toBe(3)
})

it('곡 없음·로드 중·비정상 조정은 무시하고 범위를 제한한다', async () => {
  store.getState().setPitch(2)
  const loading = store.getState().loadTrack(track('a'))
  store.getState().setPitch(2)
  await loading
  store.getState().setPitch(NaN)
  store.getState().setPitch(Infinity)
  expect(api.setTrackPitch).not.toHaveBeenCalled()
  for (const [input, expected] of [
    [10, 6],
    [-10, -6],
    [1.6, 2]
  ]) {
    store.getState().setPitch(input)
    await store.getState().loadTrack(track('a'))
    expect(store.getState().pitch).toBe(expected)
  }
})
