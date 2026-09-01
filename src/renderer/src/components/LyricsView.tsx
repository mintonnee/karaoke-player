import { useEffect, useMemo, useRef, useState } from 'react'
import { normalizeLoop } from '../audio/audioMath'
import { currentLineIndex, lineProgress } from '../../../shared/lrc'
import LyricsSetup from './LyricsSetup'
import { CONF_WARN_THRESHOLD, useLyricsStore } from '../stores/lyricsStore'
import { usePlayerStore } from '../stores/playerStore'

/** 현재 줄을 컨테이너 상단에서 이 비율 지점에 붙인다 (Apple Music 느낌) */
const ANCHOR_RATIO = 0.22

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = seconds - m * 60
  return `${m}:${s.toFixed(1).padStart(4, '0')}`
}

function LyricsView(): React.JSX.Element | null {
  const track = usePlayerStore((s) => s.track)
  const position = usePlayerStore((s) => s.position)
  const duration = usePlayerStore((s) => s.duration)
  const seek = usePlayerStore((s) => s.seek)
  const loop = usePlayerStore((s) => s.loop)
  const setLoop = usePlayerStore((s) => s.setLoop)
  const {
    lines,
    confs,
    hints,
    showHints,
    working,
    workError,
    loading,
    correcting,
    selectedIndex,
    toggleCorrection,
    selectLine,
    tap,
    pronounce,
    toggleHints
  } = useLyricsStore()

  const containerRef = useRef<HTMLDivElement>(null)
  const lineRefs = useRef<(HTMLParagraphElement | null)[]>([])
  /** 가사 줄 드래그 선택 (루프 설정). 한 줄에서 떼면 시크로 처리 */
  const [dragSel, setDragSel] = useState<{ start: number; end: number } | null>(null)

  // 가나가 한 줄이라도 있으면 일본어 가사로 보고 발음 힌트 버튼을 노출한다
  const isJa = useMemo(() => lines.some((line) => /[ぁ-ゟ゠-ヿ]/.test(line.text)), [lines])

  const index = currentLineIndex(lines, position)
  const waitingIntro = lines.length > 0 && index === -1

  useEffect(() => {
    if (correcting) return
    const container = containerRef.current
    if (!container) return
    const target = index >= 0 ? lineRefs.current[index] : null
    const top = target ? target.offsetTop - container.clientHeight * ANCHOR_RATIO : 0
    container.scrollTo({ top: Math.max(0, top), behavior: 'smooth' })
  }, [index, lines, correcting])

  // 드래그 종료: 여러 줄이면 [시작 줄 시각, 끝 줄 다음 줄 시각) 루프 설정, 한 줄이면 시크
  useEffect(() => {
    if (!dragSel) return
    const onPointerUp = (): void => {
      const lo = Math.min(dragSel.start, dragSel.end)
      const hi = Math.max(dragSel.start, dragSel.end)
      if (lo === hi) {
        seek(lines[lo].time)
      } else {
        const end = hi + 1 < lines.length ? lines[hi + 1].time : duration
        setLoop(normalizeLoop(lines[lo].time, end, duration))
      }
      setDragSel(null)
    }
    window.addEventListener('pointerup', onPointerUp)
    return () => window.removeEventListener('pointerup', onPointerUp)
  }, [dragSel, lines, duration, seek, setLoop])

  // 보정 모드: Space로 탭
  useEffect(() => {
    if (!correcting || !track) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.code !== 'Space' || event.target instanceof HTMLInputElement) return
      event.preventDefault()
      void tap(track.id, usePlayerStore.getState().position)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [correcting, track, tap])

  if (!track) return null

  if (loading) {
    return <div className="lyrics lyrics-empty">가사 불러오는 중…</div>
  }

  if (lines.length === 0) {
    return <LyricsSetup trackId={track.id} />
  }

  const progress = lineProgress(lines, index, position, duration)

  if (correcting) {
    return (
      <div className="lyrics-correct">
        <div className="lyrics-correct-toolbar">
          <span>
            보정 모드 — 재생하면서 줄이 시작되는 순간에 <b>탭(Space)</b>을 누르세요. 즉시
            저장됩니다.
          </span>
          <button onClick={() => void tap(track.id, position)}>탭</button>
          <button onClick={toggleCorrection}>완료</button>
        </div>
        <div className="lyrics-correct-list">
          {lines.map((line, i) => (
            <div
              key={`${i}-${line.text}`}
              className={`lyrics-correct-line${i === selectedIndex ? ' selected' : ''}${
                i === index ? ' playing' : ''
              }`}
              onClick={() => selectLine(i)}
            >
              <span className="line-time">{formatTime(line.time)}</span>
              {confs && confs[i] < CONF_WARN_THRESHOLD && (
                <span className="line-warn" title={`정렬 신뢰도 낮음 (${confs[i].toFixed(2)})`}>
                  ⚠
                </span>
              )}
              <span className="line-text">{line.text === '' ? '♪' : line.text}</span>
            </div>
          ))}
        </div>
      </div>
    )
  }

  return (
    <div className="lyrics-pane">
      <div ref={containerRef} className="lyrics">
        <div className={`lyrics-intro${waitingIntro ? ' active' : ''}`}>
          <span />
          <span />
          <span />
        </div>
        {lines.map((line, i) => {
          const state = i < index ? 'past' : i === index ? 'current' : 'future'
          const selected =
            dragSel !== null &&
            i >= Math.min(dragSel.start, dragSel.end) &&
            i <= Math.max(dragSel.start, dragSel.end)
          const inLoop = loop !== null && line.time >= loop.start && line.time < loop.end
          return (
            <p
              key={`${line.time}-${i}`}
              ref={(el) => {
                lineRefs.current[i] = el
              }}
              className={`lyrics-line ${state}${selected ? ' drag-select' : ''}${
                inLoop ? ' in-loop' : ''
              }`}
              onPointerDown={(e) => {
                e.preventDefault()
                setDragSel({ start: i, end: i })
              }}
              onPointerEnter={() => setDragSel((sel) => (sel ? { ...sel, end: i } : sel))}
            >
              {confs && confs[i] < CONF_WARN_THRESHOLD && (
                <span className="line-warn" title={`정렬 신뢰도 낮음 (${confs[i].toFixed(2)})`}>
                  ⚠{' '}
                </span>
              )}
              {line.text === '' ? '♪' : line.text}
              {showHints && hints?.[i] && <span className="lyrics-hint">{hints[i]}</span>}
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
      {(confs || isJa) && (
        <div className="lyrics-tools">
          {workError && <span className="lyrics-error">실패: {workError}</span>}
          {isJa &&
            (hints ? (
              <button onClick={toggleHints}>
                {showHints ? '한글 발음 끄기' : '한글 발음 켜기'}
              </button>
            ) : (
              <button disabled={working === 'pronounce'} onClick={() => void pronounce(track.id)}>
                {working === 'pronounce' ? '발음 생성 중…' : '한글 발음 달기'}
              </button>
            ))}
          {confs && <button onClick={toggleCorrection}>타이밍 보정</button>}
        </div>
      )}
    </div>
  )
}

export default LyricsView
