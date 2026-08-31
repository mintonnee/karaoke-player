import type { LoopRange } from './AudioEngine'

/** dB → 선형 게인. -Infinity는 무음(0). */
export function dbToGain(db: number): number {
  if (db === Number.NEGATIVE_INFINITY) return 0
  return Math.pow(10, db / 20)
}

/**
 * 네이티브 소스 루프 재생 중 경과시간 기반 위치를 루프 구간 안으로 되감는다.
 * 루프가 없거나 아직 loop end에 도달하지 않았으면 그대로 반환.
 */
export function wrapLoopPosition(position: number, loop: LoopRange | null): number {
  if (!loop || position <= loop.end) return position
  const length = loop.end - loop.start
  if (length <= 0) return position
  return loop.start + ((position - loop.start) % length)
}

/** 루프 구간 정규화: start < end 보장, [0, duration]으로 클램프. 너무 짧으면 null. */
export function normalizeLoop(
  start: number,
  end: number,
  duration: number,
  minLength = 0.5
): LoopRange | null {
  const lo = Math.max(0, Math.min(start, end))
  const hi = Math.min(duration, Math.max(start, end))
  if (hi - lo < minLength) return null
  return { start: lo, end: hi }
}
