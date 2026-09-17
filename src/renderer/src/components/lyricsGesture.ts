import type { LyricLine } from '../../../shared/lrc'
import type { LoopRange } from '../audio/AudioEngine'
import { normalizeLoop } from '../audio/audioMath'

/** 가사 줄 드래그 선택. start/end는 lines 인덱스 */
export interface LyricDragSel {
  start: number
  end: number
}

export type LyricGesture =
  { type: 'seek'; time: number } | { type: 'loop'; range: LoopRange | null }

/**
 * 한 줄이면 그 줄 시작으로 시크, 여러 줄이면 [시작 줄, 끝 줄 다음 줄) 루프.
 * 예전 시크바처럼 같은 제스처에서 두 번 커밋되면 목표 구간이 다시 시작해 두 번 들린다.
 */
export function lyricGestureFromDrag(
  drag: LyricDragSel,
  lines: Pick<LyricLine, 'time'>[],
  duration: number
): LyricGesture | null {
  if (lines.length === 0) return null
  const last = lines.length - 1
  const lo = Math.min(last, Math.max(0, Math.min(drag.start, drag.end)))
  const hi = Math.min(last, Math.max(0, Math.max(drag.start, drag.end)))
  if (lo === hi) return { type: 'seek', time: lines[lo].time }
  const end = hi + 1 < lines.length ? lines[hi + 1].time : duration
  return { type: 'loop', range: normalizeLoop(lines[lo].time, end, duration) }
}

/** 슬롯을 비운 뒤 제스처를 돌려준다. 두 번째 pointerup은 null */
export function takeLyricDrag<T extends LyricDragSel>(
  slot: { current: T | null },
  lines: Pick<LyricLine, 'time'>[],
  duration: number
): LyricGesture | null {
  const drag = slot.current
  slot.current = null
  if (!drag) return null
  return lyricGestureFromDrag(drag, lines, duration)
}

/** 세로 좌표 → 줄 인덱스. clamp면 리스트 밖을 첫/마지막 줄로 붙인다. */
export function lyricIndexAtY(
  y: number,
  bands: ReadonlyArray<{ top: number; bottom: number }>,
  clamp = false
): number | null {
  if (bands.length === 0) return null
  for (let i = 0; i < bands.length; i++) {
    if (y >= bands[i].top && y <= bands[i].bottom) return i
  }
  if (!clamp) return null
  if (y < bands[0].top) return 0
  return bands.length - 1
}
