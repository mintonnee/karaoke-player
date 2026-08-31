import { useEffect, useRef } from 'react'
import { currentLineIndex, lineProgress } from '../../../shared/lrc'
import { useLyricsStore } from '../stores/lyricsStore'
import { usePlayerStore } from '../stores/playerStore'

/** 현재 줄을 컨테이너 상단에서 이 비율 지점에 붙인다 (Apple Music 느낌) */
const ANCHOR_RATIO = 0.22

function LyricsView(): React.JSX.Element | null {
  const track = usePlayerStore((s) => s.track)
  const position = usePlayerStore((s) => s.position)
  const duration = usePlayerStore((s) => s.duration)
  const seek = usePlayerStore((s) => s.seek)
  const { lines, plain, loading, refetch } = useLyricsStore()

  const containerRef = useRef<HTMLDivElement>(null)
  const lineRefs = useRef<(HTMLParagraphElement | null)[]>([])

  const index = currentLineIndex(lines, position)
  const waitingIntro = lines.length > 0 && index === -1

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const target = index >= 0 ? lineRefs.current[index] : null
    const top = target ? target.offsetTop - container.clientHeight * ANCHOR_RATIO : 0
    container.scrollTo({ top: Math.max(0, top), behavior: 'smooth' })
  }, [index, lines])

  if (!track) return null

  if (lines.length === 0) {
    return (
      <div className="lyrics lyrics-empty">
        {loading ? (
          <p>가사 불러오는 중…</p>
        ) : plain ? (
          <>
            <p className="lyrics-note">동기 가사가 없어 원문만 표시합니다 (정렬은 이후 지원)</p>
            <pre className="lyrics-plain">{plain}</pre>
          </>
        ) : (
          <>
            <p className="lyrics-note">가사를 찾지 못했습니다</p>
            <button onClick={() => void refetch(track.id)}>
              LRCLIB에서 다시 가져오기 (제목/아티스트를 정확히 편집하면 잘 찾습니다)
            </button>
          </>
        )}
      </div>
    )
  }

  const progress = lineProgress(lines, index, position, duration)

  return (
    <div ref={containerRef} className="lyrics">
      <div className={`lyrics-intro${waitingIntro ? ' active' : ''}`}>
        <span />
        <span />
        <span />
      </div>
      {lines.map((line, i) => {
        const state = i < index ? 'past' : i === index ? 'current' : 'future'
        return (
          <p
            key={`${line.time}-${i}`}
            ref={(el) => {
              lineRefs.current[i] = el
            }}
            className={`lyrics-line ${state}`}
            onClick={() => seek(line.time)}
          >
            {line.text === '' ? '♪' : line.text}
            {state === 'current' && (
              <span className="lyrics-line-progress">
                <span style={{ width: `${progress * 100}%` }} />
              </span>
            )}
          </p>
        )
      })}
      <div className="lyrics-tail" />
    </div>
  )
}

export default LyricsView
