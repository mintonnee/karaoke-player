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

/**
 * 시간 영역 샘플의 RMS를 dBFS로 변환한다. 미터 표시용.
 * 무음·빈 배열·비유한값은 floorDb, floorDb 미만은 floorDb, 0 dBFS 초과는 0으로 클램프.
 */
export function rmsDb(samples: Float32Array, floorDb = -60): number {
  if (samples.length === 0) return floorDb
  let sum = 0
  for (let i = 0; i < samples.length; i++) {
    const sample = samples[i]
    if (!Number.isFinite(sample)) return floorDb
    sum += sample * sample
  }
  const rms = Math.sqrt(sum / samples.length)
  if (!(rms > 0)) return floorDb
  const db = 20 * Math.log10(rms)
  if (!Number.isFinite(db)) return floorDb
  return Math.max(floorDb, Math.min(0, db))
}
