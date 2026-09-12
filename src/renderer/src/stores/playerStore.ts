import { create } from 'zustand'
import type { Track } from '../../../shared/types'
import type { AudioEngine, AudioEngineState, AudioLevels, LoopRange } from '../audio/AudioEngine'
import { normalizeLoop } from '../audio/audioMath'
import {
  SILENCE_DB,
  channelDbWritable,
  exclusiveGainApplyOrder,
  initialMixerState,
  mixGains,
  reduceVocalKey,
  type MixSource
} from '../audio/mixGains'
import { WebAudioEngine } from '../audio/WebAudioEngine'
import { reportError } from './errorStore'

// 엔진 구현체 교체 지점 (v2: NativeEngine)
const engine: AudioEngine = new WebAudioEngine()

interface PlayerState {
  track: Track | null
  engineState: AudioEngineState
  position: number
  duration: number
  instDb: number
  vocalDb: number
  /** 전체(마스터) 음량. 두 채널 게인에 합산 적용 (-60..0 dB) */
  masterDb: number
  instMuted: boolean
  vocalMuted: boolean
  /** 메인 뮤트: 채널별 뮤트 상태를 보존한 채 두 채널을 모두 무음으로 */
  masterMuted: boolean
  /** full_mix 전용. 곡 로드 시 MR. vocal_only에서는 무시 */
  mixSource: MixSource
  loop: LoopRange | null
  /** A-B 반복의 시작점(A)만 찍힌 상태. 루프가 확정되거나 해제되면 null */
  loopMarkA: number | null
  /** 키 변경 (반음, -6..+6) */
  pitch: number
  loadError: string | null

  loadTrack: (track: Track) => Promise<void>
  /** 트랙 삭제 등으로 현재 로드를 해제한다 */
  unload: () => void
  play: () => void
  pause: () => void
  stop: () => void
  seek: (seconds: number) => void
  setInstDb: (db: number) => void
  setVocalDb: (db: number) => void
  setMasterDb: (db: number) => void
  toggleInstMute: () => void
  /**
   * V 키 액션 (I3 KeyV → toggleVocalMute).
   * vocal_only·트랙 없음: 보컬 뮤트 토글.
   * full_mix: MR↔AR 배타 전환. 뮤트 해제로 두 소스를 합산하지 않는다.
   */
  toggleVocalMute: () => void
  setMixSource: (source: MixSource) => void
  toggleMasterMute: () => void
  setLoop: (range: LoopRange | null) => void
  /**
   * A-B 반복 순환 (반복 버튼 / L 키). 루프 있음 → 해제, A 없음 → 현재 위치를 A로,
   * A 있음 → A~현재 위치를 루프로 확정. 확정 구간이 너무 짧으면 A를 유지한다.
   */
  cycleLoopAB: () => void
  setPitch: (semitones: number) => void
  /** 레벨 미터 구독. 30 Hz 갱신이라 스토어 상태를 거치지 않는다 (전체 리렌더 방지) */
  subscribeLevels: (cb: (levels: AudioLevels) => void) => () => void
}

export const usePlayerStore = create<PlayerState>((set, get) => {
  engine.onPosition((seconds) => set({ position: seconds, engineState: engine.state }))
  engine.onEnded(() => set({ engineState: engine.state }))
  // 메타 편집이 현재 로드된 트랙이면 Transport 표시도 갱신
  window.api.onTrackUpdated((updated) => {
    const current = get().track
    if (current && current.id === updated.id) set({ track: updated })
  })

  const syncEngine = (): void => set({ engineState: engine.state })

  let lastEngineGains = { inst: SILENCE_DB, guide: SILENCE_DB }

  const applyGains = (): void => {
    const { track, mixSource, instDb, vocalDb, masterDb, instMuted, vocalMuted, masterMuted } =
      get()
    const next = mixGains({
      guideKind: track?.guideKind ?? null,
      source: mixSource,
      instDb,
      guideDb: vocalDb,
      instMuted,
      guideMuted: vocalMuted,
      masterDb,
      masterMuted
    })
    // 이전 소스 뮤트 → 새 소스 램프. 엔진은 무음→가청을 추가로 지연한다
    for (const ch of exclusiveGainApplyOrder(lastEngineGains, next)) {
      if (ch === 'inst') engine.setGain('inst', next.inst)
      else engine.setGain('vocal', next.guide)
    }
    lastEngineGains = next
  }

  return {
    track: null,
    engineState: engine.state,
    position: 0,
    duration: 0,
    instDb: 0,
    vocalDb: window.api.guideVocalDefaultDb,
    masterDb: 0,
    instMuted: false,
    vocalMuted: false,
    masterMuted: false,
    mixSource: 'mr',
    loop: null,
    loopMarkA: null,
    pitch: 0,
    loadError: null,

    loadTrack: async (track) => {
      lastEngineGains = { inst: SILENCE_DB, guide: SILENCE_DB }
      set({
        track,
        loadError: null,
        loop: null,
        loopMarkA: null,
        engineState: 'loading',
        position: 0,
        ...initialMixerState(track.guideKind, window.api.guideVocalDefaultDb)
      })
      try {
        const files = await window.api.trackFiles(track.id)
        await engine.load({ inst: files.inst, guide: files.guide })
        applyGains()
        set({ duration: engine.duration, engineState: engine.state })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        reportError('player', `"${track.title}" 재생 로드 실패: ${message}`, track.id)
        set({
          track: null,
          duration: 0,
          engineState: engine.state,
          loadError: message
        })
      }
    },
    unload: () => {
      engine.stop()
      set({
        track: null,
        duration: 0,
        position: 0,
        loop: null,
        loopMarkA: null,
        engineState: engine.state
      })
    },
    play: () => {
      engine.play()
      syncEngine()
    },
    pause: () => {
      engine.pause()
      syncEngine()
    },
    stop: () => {
      engine.stop()
      set({ engineState: engine.state, position: 0 })
    },
    seek: (seconds) => {
      engine.seek(seconds)
      set({ position: seconds, engineState: engine.state })
    },
    setInstDb: (db) => {
      const { track, mixSource } = get()
      if (!channelDbWritable(track?.guideKind ?? null, mixSource, 'inst')) return
      set({ instDb: db })
      applyGains()
    },
    setVocalDb: (db) => {
      const { track, mixSource } = get()
      if (!channelDbWritable(track?.guideKind ?? null, mixSource, 'guide')) return
      set({ vocalDb: db })
      applyGains()
    },
    setMasterDb: (db) => {
      set({ masterDb: Math.max(-60, Math.min(0, Math.round(db))) })
      applyGains()
    },
    toggleInstMute: () => {
      if (get().track?.guideKind === 'full_mix') return
      set((state) => ({ instMuted: !state.instMuted }))
      applyGains()
    },
    toggleVocalMute: () => {
      const { track, mixSource, vocalMuted } = get()
      set(reduceVocalKey({ guideKind: track?.guideKind ?? null, mixSource, vocalMuted }))
      applyGains()
    },
    setMixSource: (source) => {
      if (get().track?.guideKind !== 'full_mix') return
      if (get().mixSource === source) return
      set({ mixSource: source })
      applyGains()
    },
    toggleMasterMute: () => {
      set((state) => ({ masterMuted: !state.masterMuted }))
      applyGains()
    },
    setLoop: (range) => {
      set({ loop: range, loopMarkA: null })
      engine.setLoop(range)
    },
    cycleLoopAB: () => {
      const { loop, loopMarkA, position, duration, setLoop } = get()
      if (loop) {
        setLoop(null)
        return
      }
      if (loopMarkA === null) {
        set({ loopMarkA: position })
        return
      }
      const range = normalizeLoop(loopMarkA, position, duration)
      if (range) setLoop(range)
    },
    setPitch: (semitones) => {
      const clamped = Math.max(-6, Math.min(6, Math.round(semitones)))
      set({ pitch: clamped })
      engine.setPitch(clamped)
    },
    subscribeLevels: (cb) => engine.onLevels(cb)
  }
})
