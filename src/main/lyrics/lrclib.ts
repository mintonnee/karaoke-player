/** LRCLIB API 응답 및 후보 선택 로직 (§4.4). 네트워크와 무관한 순수 부분. */

export interface LrclibRecord {
  id: number
  trackName: string
  artistName: string
  albumName: string
  duration: number
  instrumental: boolean
  plainLyrics: string | null
  syncedLyrics: string | null
}

/** /api/search 결과에서 duration이 가장 근접한 사용 가능 후보를 고른다 */
export function chooseSearchResult(
  records: LrclibRecord[],
  durationSec: number,
  toleranceSec = 5
): LrclibRecord | null {
  const usable = records.filter(
    (r) =>
      (r.instrumental || r.syncedLyrics || r.plainLyrics) &&
      Math.abs(r.duration - durationSec) <= toleranceSec
  )
  if (usable.length === 0) return null

  const byCloseness = [...usable].sort(
    (a, b) => Math.abs(a.duration - durationSec) - Math.abs(b.duration - durationSec)
  )
  // 같은 근접도라면 syncedLyrics 있는 쪽 우선
  const best = byCloseness[0]
  const bestDiff = Math.abs(best.duration - durationSec)
  const syncedAtBestDiff = byCloseness.find(
    (r) => Math.abs(r.duration - durationSec) === bestDiff && r.syncedLyrics
  )
  return syncedAtBestDiff ?? best
}
