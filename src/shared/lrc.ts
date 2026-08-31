/** LRC 파서 (§4.4). 커뮤니티 소스 LRC의 포맷 편차를 감안해 관대하게 파싱한다. */

export interface LyricLine {
  /** 초 단위 시작 시각 */
  time: number
  text: string
}

const TIMESTAMP_RE = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g
const META_TAG_RE = /^\[(ar|ti|al|au|by|re|ve|length|offset):(.*)\]$/i

/**
 * LRC 본문을 시간순 정렬된 줄 배열로 파싱한다.
 * - 한 줄에 여러 타임스탬프([00:10.00][00:50.00] 후렴) 허용
 * - [offset:±ms] 메타 태그 적용, 그 외 메타 태그([ar:] 등)는 무시
 * - 타임스탬프 뒤 텍스트가 빈 줄(간주 표현)은 유지한다
 */
export function parseLrc(content: string): LyricLine[] {
  let offsetSec = 0
  const lines: LyricLine[] = []

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line === '') continue

    const metaMatch = META_TAG_RE.exec(line)
    if (metaMatch) {
      if (metaMatch[1].toLowerCase() === 'offset') {
        const ms = Number.parseInt(metaMatch[2].trim(), 10)
        if (Number.isFinite(ms)) offsetSec = ms / 1000
      }
      continue
    }

    TIMESTAMP_RE.lastIndex = 0
    const times: number[] = []
    let match: RegExpExecArray | null
    let lastEnd = 0
    while ((match = TIMESTAMP_RE.exec(line)) !== null) {
      if (match.index !== lastEnd) break // 타임스탬프 연속 구간이 끝나면 본문 시작
      const minutes = Number.parseInt(match[1], 10)
      const seconds = Number.parseInt(match[2], 10)
      const fracRaw = match[3] ?? '0'
      const frac = Number.parseInt(fracRaw, 10) / 10 ** fracRaw.length
      times.push(minutes * 60 + seconds + frac)
      lastEnd = TIMESTAMP_RE.lastIndex
    }
    if (times.length === 0) continue

    const text = line.slice(lastEnd).trim()
    for (const time of times) {
      lines.push({ time: Math.max(0, time + offsetSec), text })
    }
  }

  return lines.sort((a, b) => a.time - b.time)
}

/** LyricLine 배열을 LRC 본문으로 직렬화한다 (수동 보정 저장용) */
export function formatLrc(lines: LyricLine[]): string {
  return (
    lines
      .map((line) => {
        const t = Math.max(0, line.time)
        const minutes = Math.floor(t / 60)
        const seconds = t - minutes * 60
        const mm = String(minutes).padStart(2, '0')
        const ss = seconds.toFixed(2).padStart(5, '0')
        return `[${mm}:${ss}] ${line.text}`.trimEnd()
      })
      .join('\n') + '\n'
  )
}

/** 현재 재생 위치에 해당하는 줄 인덱스. 첫 줄 이전이면 -1. */
export function currentLineIndex(lines: LyricLine[], positionSec: number): number {
  let lo = 0
  let hi = lines.length - 1
  let result = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (lines[mid].time <= positionSec) {
      result = mid
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  return result
}

/** 줄 내 진행률(0..1): (다음 줄 시각 − 현재 줄 시각)에 비례 (§4.4) */
export function lineProgress(
  lines: LyricLine[],
  index: number,
  positionSec: number,
  durationSec: number
): number {
  if (index < 0 || index >= lines.length) return 0
  const start = lines[index].time
  const end = index + 1 < lines.length ? lines[index + 1].time : durationSec
  if (end <= start) return 1
  return Math.min(1, Math.max(0, (positionSec - start) / (end - start)))
}
