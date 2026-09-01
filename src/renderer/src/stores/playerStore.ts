import { create } from 'zustand'
import type { Track } from '../../../shared/types'
import type { AudioEngine, AudioEngineState, LoopRange } from '../audio/AudioEngine'
import { WebAudioEngine } from '../audio/WebAudioEngine'

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
  /** 전체 뮤트: 채널별 뮤트 상태를 보존한 채 두 채널을 모두 무음으로 */
  masterMuted: boolean
  loop: LoopRange | null
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
  toggleVocalMute: () => void
  toggleMasterMute: () => void
  setLoop: (range: LoopRange | null) => void
  setPitch: (semitones: number) => void
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

  const applyGains = (): void => {
    const { instDb, vocalDb, masterDb, instMuted, vocalMuted, masterMuted } = get()
    engine.setGain('inst', masterMuted || instMuted ? Number.NEGATIVE_INFINITY : instDb + masterDb)
    engine.setGain(
      'vocal',
      masterMuted || vocalMuted ? Number.NEGATIVE_INFINITY : vocalDb + masterDb
    )
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
    loop: null,
    pitch: 0,
    loadError: null,

    loadTrack: async (track) => {
      set({ track, loadError: null, loop: null, engineState: 'loading', position: 0 })
      try {
        const files = await window.api.trackFiles(track.id)
        await engine.load(files)
        applyGains()
        set({ duration: engine.duration, engineState: engine.state })
      } catch (error) {
        set({
          track: null,
          duration: 0,
          engineState: engine.state,
          loadError: error instanceof Error ? error.message : String(error)
        })
      }
    },
    unload: () => {
      engine.stop()
      set({ track: null, duration: 0, position: 0, loop: null, engineState: engine.state })
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
      set({ instDb: db })
      applyGains()
    },
    setVocalDb: (db) => {
      set({ vocalDb: db })
      applyGains()
    },
    setMasterDb: (db) => {
      set({ masterDb: Math.max(-60, Math.min(0, Math.round(db))) })
      applyGains()
    },
    toggleInstMute: () => {
      set((state) => ({ instMuted: !state.instMuted }))
      applyGains()
    },
    toggleVocalMute: () => {
      set((state) => ({ vocalMuted: !state.vocalMuted }))
      applyGains()
    },
    toggleMasterMute: () => {
      set((state) => ({ masterMuted: !state.masterMuted }))
      applyGains()
    },
    setLoop: (range) => {
      set({ loop: range })
      engine.setLoop(range)
    },
    setPitch: (semitones) => {
      const clamped = Math.max(-6, Math.min(6, Math.round(semitones)))
      set({ pitch: clamped })
      engine.setPitch(clamped)
    }
  }
})
