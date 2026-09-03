import { create } from 'zustand'
import { parseLrc } from '../../../shared/lrc'
import type { LyricLine } from '../../../shared/lrc'
import type {
  AlignLang,
  LyricsPayload,
  LyricsProgressEvent,
  LyricsSource,
  PronunciationLine
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
  /** 줄별 한글 발음 힌트. 생성 전이거나 매칭되는 힌트가 없으면 null */
  hints: (string | null)[] | null
  /** 힌트 표시 여부 (세션 단위 토글) */
  showHints: boolean
  loading: boolean
  /** 정렬/전사/발음 생성 진행 상태 */
  working: 'align' | 'transcribe' | 'pronounce' | null
  progress: LyricsProgressEvent | null
  workError: string | null
  /** S5.3 수동 보정 모드 */
  correcting: boolean
  selectedIndex: number

  load: (trackId: string) => Promise<void>
  refetch: (trackId: string) => Promise<void>
  align: (trackId: string, text: string, lang: AlignLang, fromLrclibPlain: boolean) => Promise<void>
  transcribe: (trackId: string) => Promise<string>
  /** 일본어 가사에 한글 발음 힌트 생성 (사이드카 pronounce) */
  pronounce: (trackId: string) => Promise<void>
  /** 가사 초기화: 저장된 가사·정렬·보정·발음 힌트를 지우고 설정 화면으로 돌아간다 */
  reset: (trackId: string) => Promise<void>
  toggleHints: () => void
  toggleCorrection: () => void
  selectLine: (index: number) => void
  /** 재생 중 탭: 선택 줄 시작점을 현재 위치로 지정하고 저장 후 다음 줄 선택 */
  tap: (trackId: string, positionSec: number) => Promise<void>
  clear: () => void
}

function fromPayload(
  payload: LyricsPayload
): Pick<LyricsState, 'lines' | 'confs' | 'source' | 'plain' | 'hints'> {
  const aligned = payload.lines && payload.lines.length > 0 ? payload.lines : null
  const lines: LyricLine[] = aligned
    ? aligned.map((line) => ({ time: line.t, text: line.text }))
    : payload.lrc
      ? parseLrc(payload.lrc)
      : []
  return {
    lines,
    confs: aligned ? aligned.map((line) => line.conf) : null,
    source: payload.source,
    plain: payload.plain,
    hints: resolveHints(lines, payload.pronunciation)
  }
}

/** 발음 힌트를 표시 줄에 인덱스로 매칭한다. 생성 후 가사가 바뀐 줄의 힌트는 버린다 */
function resolveHints(
  lines: LyricLine[],
  pronunciation: PronunciationLine[] | null
): (string | null)[] | null {
  if (!pronunciation) return null
  const hints = lines.map((line, i) => {
    const entry = pronunciation[i]
    return entry && entry.text === line.text && entry.hint !== '' ? entry.hint : null
  })
  return hints.some((hint) => hint !== null) ? hints : null
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
    hints: null,
    showHints: true,
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
        set({ lines: [], confs: null, source: 'none', plain: null, hints: null, loading: false })
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
    pronounce: async (trackId) => {
      set({ working: 'pronounce', workError: null, progress: null })
      try {
        apply(await window.api.pronounceLyrics(trackId))
      } catch (error) {
        set({
          working: null,
          progress: null,
          workError: error instanceof Error ? error.message : String(error)
        })
      }
    },
    reset: async (trackId) => {
      set({ loading: true, correcting: false, workError: null })
      try {
        apply(await window.api.resetLyrics(trackId))
      } catch (error) {
        set({
          loading: false,
          workError: error instanceof Error ? error.message : String(error)
        })
      }
    },
    toggleHints: () => set((state) => ({ showHints: !state.showHints })),
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
        hints: null,
        loading: false,
        working: null,
        progress: null,
        workError: null,
        correcting: false,
        selectedIndex: 0
      })
  }
})
