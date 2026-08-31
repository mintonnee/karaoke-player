import { create } from 'zustand'
import { parseLrc } from '../../../shared/lrc'
import type { LyricLine } from '../../../shared/lrc'
import type {
  AlignLang,
  LyricsPayload,
  LyricsProgressEvent,
  LyricsSource
} from '../../../shared/types'

/** §4.4: 가창 특성상 이 값 미만이면 정렬을 의심하고 UI에 경고한다 */
export const CONF_WARN_THRESHOLD = 0.1

interface LyricsState {
  /** 표시용 싱크 가사. 없으면 빈 배열 */
  lines: LyricLine[]
  /** 정렬을 거친 경우 줄별 신뢰도(0..1). LRCLIB synced 가사는 null */
  confs: number[] | null
  source: LyricsSource
  /** 싱크는 없지만 plain 가사는 있는 경우 (정렬 입력으로 사용) */
  plain: string | null
  loading: boolean
  /** 정렬/전사 진행 상태 */
  working: 'align' | 'transcribe' | null
  progress: LyricsProgressEvent | null
  workError: string | null
  /** S5.3 수동 보정 모드 */
  correcting: boolean
  selectedIndex: number

  load: (trackId: string) => Promise<void>
  refetch: (trackId: string) => Promise<void>
  align: (trackId: string, text: string, lang: AlignLang, fromLrclibPlain: boolean) => Promise<void>
  transcribe: (trackId: string) => Promise<string>
  toggleCorrection: () => void
  selectLine: (index: number) => void
  /** 재생 중 탭: 선택 줄 시작점을 현재 위치로 지정하고 저장 후 다음 줄 선택 */
  tap: (trackId: string, positionSec: number) => Promise<void>
  clear: () => void
}

function fromPayload(
  payload: LyricsPayload
): Pick<LyricsState, 'lines' | 'confs' | 'source' | 'plain'> {
  if (payload.lines && payload.lines.length > 0) {
    return {
      lines: payload.lines.map((line) => ({ time: line.t, text: line.text })),
      confs: payload.lines.map((line) => line.conf),
      source: payload.source,
      plain: payload.plain
    }
  }
  return {
    lines: payload.lrc ? parseLrc(payload.lrc) : [],
    confs: null,
    source: payload.source,
    plain: payload.plain
  }
}

export const useLyricsStore = create<LyricsState>((set, get) => {
  window.api.onLyricsProgress((event) => {
    set({ progress: event })
  })

  const apply = (payload: LyricsPayload): void =>
    set({ ...fromPayload(payload), loading: false, working: null, progress: null })

  return {
    lines: [],
    confs: null,
    source: 'none',
    plain: null,
    loading: false,
    working: null,
    progress: null,
    workError: null,
    correcting: false,
    selectedIndex: 0,

    load: async (trackId) => {
      set({ loading: true, correcting: false, workError: null })
      try {
        apply(await window.api.getLyrics(trackId))
      } catch {
        set({ lines: [], confs: null, source: 'none', plain: null, loading: false })
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
    align: async (trackId, text, lang, fromLrclibPlain) => {
      set({ working: 'align', workError: null, progress: null })
      try {
        apply(await window.api.alignLyrics(trackId, text, lang, fromLrclibPlain))
      } catch (error) {
        set({
          working: null,
          progress: null,
          workError: error instanceof Error ? error.message : String(error)
        })
      }
    },
    transcribe: async (trackId) => {
      set({ working: 'transcribe', workError: null, progress: null })
      try {
        const text = await window.api.transcribeLyrics(trackId)
        set({ working: null, progress: null })
        return text
      } catch (error) {
        set({
          working: null,
          progress: null,
          workError: error instanceof Error ? error.message : String(error)
        })
        return ''
      }
    },
    toggleCorrection: () => set((state) => ({ correcting: !state.correcting, selectedIndex: 0 })),
    selectLine: (index) => set({ selectedIndex: index }),
    tap: async (trackId, positionSec) => {
      const { lines, confs, selectedIndex } = get()
      if (selectedIndex < 0 || selectedIndex >= lines.length) return

      const nextLines = [...lines]
      nextLines[selectedIndex] = { ...nextLines[selectedIndex], time: positionSec }
      const nextConfs = confs ? [...confs] : lines.map(() => 1)
      nextConfs[selectedIndex] = 1

      set({
        lines: nextLines,
        confs: nextConfs,
        selectedIndex: Math.min(selectedIndex + 1, lines.length - 1)
      })
      await window.api.saveLyricsLines(
        trackId,
        nextLines.map((line, i) => ({ t: line.time, text: line.text, conf: nextConfs[i] }))
      )
    },
    clear: () =>
      set({
        lines: [],
        confs: null,
        source: 'none',
        plain: null,
        loading: false,
        working: null,
        progress: null,
        workError: null,
        correcting: false,
        selectedIndex: 0
      })
  }
})
