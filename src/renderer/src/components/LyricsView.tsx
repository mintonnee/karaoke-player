import { useEffect, useMemo, useRef, useState } from 'react'
import type { PointerEvent } from 'react'
import { currentLineIndex, lineProgress } from '../../../shared/lrc'
import LyricsSetupDialog from './LyricsSetupDialog'
import { lyricIndexAtY, takeLyricDrag, type LyricDragSel } from './lyricsGesture'
import { CONF_WARN_THRESHOLD, useLyricsStore } from '../stores/lyricsStore'
import { usePlayerStore } from '../stores/playerStore'

/** 현재 줄을 컨테이너 상단에서 이 비율 지점에 붙인다 (Apple Music 느낌) */
const ANCHOR_RATIO = 0.22

/** 전주 카운트다운 표기: 60초 미만은 "12초", 이상은 "1분 05초" */
function formatCountdown(seconds: number): string {
  const total = Math.max(0, Math.ceil(seconds))
  if (total < 60) return `${total}초`
  const m = Math.floor(total / 60)
  const s = total - m * 60
  return `${m}분 ${String(s).padStart(2, '0')}초`
}

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = seconds - m * 60
  return `${m}:${s.toFixed(1).padStart(4, '0')}`
}

/** AR 가이드는 반주가 섞여 있어 정렬·전사 품질이 떨어질 수 있다. Demucs는 제공하지 않는다. */
function ArLyricsWarn(): React.JSX.Element {
  return (
    <p className="lyrics-ar-warn">
      AR 파일은 반주가 포함되어 있어 가사 정렬·전사의 정확도가 낮을 수 있습니다. 보컬 추출로
      보완하지 않습니다.
    </p>
  )
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
    swapHints,
    working,
    workError,
    loading,
    correcting,
    selectedIndex,
    toggleCorrection,
    selectLine,
    tap,
    pronounce,
    reset,
    toggleHints
  } = useLyricsStore()

  const containerRef = useRef<HTMLDivElement>(null)
  const lineRefs = useRef<(HTMLParagraphElement | null)[]>([])
  /** 가사 줄 드래그 선택 (루프 설정). 한 줄에서 떼면 시크로 처리 */
  const [dragSel, setDragSel] = useState<LyricDragSel | null>(null)
  /** 제스처당 한 번만 커밋. window pointerup effect는 같은 클릭이 두 번 시크할 수 있다 */
  const dragRef = useRef<(LyricDragSel & { pointerId: number }) | null>(null)
  /** 가사 초기화 2단계 확인 (실수 클릭 방지). 확인을 띄운 트랙 id를 들고 있어 트랙이 바뀌면 자연히 해제된다 */
  const [resetArmedFor, setResetArmedFor] = useState<string | null>(null)
  const confirmReset = track !== null && resetArmedFor === track.id

  // 가나가 한 줄이라도 있으면 일본어 가사로 보고 발음 힌트 버튼을 노출한다
  const isJa = useMemo(() => lines.some((line) => /[ぁ-ゟ゠-ヿ]/.test(line.text)), [lines])

  const index = currentLineIndex(lines, position)
  const waitingIntro = lines.length > 0 && index === -1
  /** 첫 소절까지 남은 시간(초). 전주 대기 중이 아니면 0 */
  const introRemaining = waitingIntro ? Math.max(0, lines[0].time - position) : 0
  /** 전주 진행률 0..1 (게이지용). 첫 소절이 0초라면 대기 자체가 없다 */
  const introProgress = waitingIntro && lines[0].time > 0 ? 1 - introRemaining / lines[0].time : 0

  useEffect(() => {
    if (correcting) return
    const container = containerRef.current
    if (!container) return
    const target = index >= 0 ? lineRefs.current[index] : null
    const top = target ? target.offsetTop - container.clientHeight * ANCHOR_RATIO : 0
    container.scrollTo({ top: Math.max(0, top), behavior: 'smooth' })
  }, [index, lines, correcting])

  const lineBands = (): { top: number; bottom: number }[] => {
    const bands: { top: number; bottom: number }[] = []
    for (let i = 0; i < lines.length; i++) {
      const el = lineRefs.current[i]
      if (!el) break
      const rect = el.getBoundingClientRect()
      bands.push({ top: rect.top, bottom: rect.bottom })
    }
    return bands
  }

  const extendLyricDrag = (clientY: number, clamp: boolean): void => {
    const drag = dragRef.current
    if (!drag) return
    const index = lyricIndexAtY(clientY, lineBands(), clamp)
    if (index === null || drag.end === index) return
    drag.end = index
    setDragSel({ start: drag.start, end: index })
  }

  const commitLyricDrag = (): void => {
    const gesture = takeLyricDrag(dragRef, lines, duration)
    if (!gesture) return
    setDragSel(null)
    if (gesture.type === 'seek') seek(gesture.time)
    else setLoop(gesture.range)
  }

  const cancelLyricDrag = (pointerId: number): void => {
    if (dragRef.current?.pointerId !== pointerId) return
    dragRef.current = null
    setDragSel(null)
  }

  const onLyricsPointerDown = (event: PointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0 || dragRef.current) return
    const index = lyricIndexAtY(event.clientY, lineBands())
    if (index === null) return
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    dragRef.current = { pointerId: event.pointerId, start: index, end: index }
    setDragSel({ start: index, end: index })
  }

  const onLyricsPointerMove = (event: PointerEvent<HTMLDivElement>): void => {
    if (dragRef.current?.pointerId !== event.pointerId) return
    extendLyricDrag(event.clientY, true)
  }

  const onLyricsPointerUp = (event: PointerEvent<HTMLDivElement>): void => {
    if (dragRef.current?.pointerId !== event.pointerId) return
    extendLyricDrag(event.clientY, true)
    commitLyricDrag()
  }

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

  const arWarn = track.guideKind === 'full_mix'

  if (loading) {
    return <div className="lyrics lyrics-empty">가사 불러오는 중…</div>
  }

  if (lines.length === 0) {
    return (
      <div className="lyrics-pane">
        {arWarn && <ArLyricsWarn />}
        <LyricsSetupDialog key={track.id} track={track} />
      </div>
    )
  }

  const progress = lineProgress(lines, index, position, duration)

  if (correcting) {
    return (
      <div className="lyrics-correct">
        {arWarn && <ArLyricsWarn />}
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
      {arWarn && <ArLyricsWarn />}
      <div
        ref={containerRef}
        className="lyrics"
        onPointerDown={onLyricsPointerDown}
        onPointerMove={onLyricsPointerMove}
        onPointerUp={onLyricsPointerUp}
        onPointerCancel={(event) => cancelLyricDrag(event.pointerId)}
      >
        <div className={`lyrics-intro${waitingIntro ? ' active' : ''}`}>
          <span className="lyrics-intro-dot" />
          <span className="lyrics-intro-dot" />
          <span className="lyrics-intro-dot" />
          {waitingIntro && (
            <span className="lyrics-intro-countdown" title="첫 소절까지 남은 시간">
              {formatCountdown(introRemaining)}
              <span className="lyrics-intro-gauge">
                <span style={{ width: `${introProgress * 100}%` }} />
              </span>
            </span>
          )}
        </div>
        {lines.map((line, i) => {
          const state = i < index ? 'past' : i === index ? 'current' : 'future'
          const selected =
            dragSel !== null &&
            i >= Math.min(dragSel.start, dragSel.end) &&
            i <= Math.max(dragSel.start, dragSel.end)
          const inLoop = loop !== null && line.time >= loop.start && line.time < loop.end
          const hint = showHints && hints?.[i] ? hints[i] : null
          const primaryText = swapHints && hint ? hint : line.text === '' ? '♪' : line.text
          const secondaryText = hint
            ? swapHints
              ? line.text === ''
                ? '♪'
                : line.text
              : hint
            : null
          return (
            <p
              key={`${line.time}-${i}`}
              ref={(el) => {
                lineRefs.current[i] = el
              }}
              className={`lyrics-line ${state}${selected ? ' drag-select' : ''}${
                inLoop ? ' in-loop' : ''
              }`}
            >
              {confs && confs[i] < CONF_WARN_THRESHOLD && (
                <span className="line-warn" title={`정렬 신뢰도 낮음 (${confs[i].toFixed(2)})`}>
                  ⚠{' '}
                </span>
              )}
              {primaryText}
              {secondaryText && (
                <span className={`lyrics-hint${swapHints ? ' lyrics-hint-original' : ''}`}>
                  {secondaryText}
                </span>
              )}
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
      {confirmReset ? (
        // 초기화 확인 단계: 다른 도구는 숨기고 확인/취소만 남긴다
        <div className="lyrics-tools">
          <span className="lyrics-tools-note">저장된 가사·정렬·보정을 모두 지웁니다</span>
          <button
            className="danger"
            onClick={() => {
              setResetArmedFor(null)
              void reset(track.id)
            }}
          >
            초기화 확인
          </button>
          <button onClick={() => setResetArmedFor(null)}>취소</button>
        </div>
      ) : (
        <div className="lyrics-tools">
          {workError && <span className="lyrics-error">실패: {workError}</span>}
          {/* 파괴적 동작은 왼쪽 끝에 링크 톤으로 낮춰 둔다 (다른 도구 버튼과 위계 분리) */}
          <button className="lyrics-tools-link" onClick={() => setResetArmedFor(track.id)}>
            가사 초기화
          </button>
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
