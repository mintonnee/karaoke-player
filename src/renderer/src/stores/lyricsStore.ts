import { create } from 'zustand'
import { parseLrc } from '../../../shared/lrc'
import type { LyricLine } from '../../../shared/lrc'
import type { LyricsSource } from '../../../shared/types'

interface LyricsState {
  /** 파싱된 싱크 가사. 없으면 빈 배열 */
  lines: LyricLine[]
  source: LyricsSource
  /** 싱크는 없지만 plain 가사는 있는 경우 (S5 정렬 대상) */
  plain: string | null
  loading: boolean
  load: (trackId: string) => Promise<void>
  refetch: (trackId: string) => Promise<void>
  clear: () => void
}

export const useLyricsStore = create<LyricsState>((set) => {
  const apply = (payload: {
    source: LyricsSource
    lrc: string | null
    plain: string | null
  }): void =>
    set({
      source: payload.source,
      lines: payload.lrc ? parseLrc(payload.lrc) : [],
      plain: payload.plain,
      loading: false
    })

  return {
    lines: [],
    source: 'none',
    plain: null,
    loading: false,
    load: async (trackId) => {
      set({ loading: true })
      try {
        apply(await window.api.getLyrics(trackId))
      } catch {
        set({ lines: [], source: 'none', plain: null, loading: false })
      }
    },
    refetch: async (trackId) => {
      set({ loading: true })
      try {
        apply(await window.api.refetchLyrics(trackId))
      } catch {
        set({ loading: false })
      }
    },
    clear: () => set({ lines: [], source: 'none', plain: null, loading: false })
  }
})
