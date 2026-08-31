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
  vocalMuted: boolean
  loop: LoopRange | null
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
  toggleVocalMute: () => void
  setLoop: (range: LoopRange | null) => void
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

  const applyVocalGain = (): void => {
    const { vocalDb, vocalMuted } = get()
    engine.setGain('vocal', vocalMuted ? Number.NEGATIVE_INFINITY : vocalDb)
  }

  return {
    track: null,
    engineState: engine.state,
    position: 0,
    duration: 0,
    instDb: 0,
    vocalDb: window.api.guideVocalDefaultDb,
    vocalMuted: false,
    loop: null,
    loadError: null,

    loadTrack: async (track) => {
      set({ track, loadError: null, loop: null, engineState: 'loading', position: 0 })
      try {
        const files = await window.api.trackFiles(track.id)
        await engine.load(files)
        engine.setGain('inst', get().instDb)
        applyVocalGain()
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
      engine.setGain('inst', db)
    },
    setVocalDb: (db) => {
      set({ vocalDb: db })
      applyVocalGain()
    },
    toggleVocalMute: () => {
      set((state) => ({ vocalMuted: !state.vocalMuted }))
      applyVocalGain()
    },
    setLoop: (range) => {
      set({ loop: range })
      engine.setLoop(range)
    }
  }
})
