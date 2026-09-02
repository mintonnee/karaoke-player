import { useRef, useState } from 'react'
import type { PointerEvent } from 'react'
import { MdMusicNote, MdPause, MdPlayArrow, MdRepeat, MdStop } from 'react-icons/md'
import { normalizeLoop } from '../audio/audioMath'
import { usePlayerStore } from '../stores/playerStore'
import { formatBpmDisplay } from '../../../shared/analysisFormat'
import CoverArt from './CoverArt'

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${m}:${String(s).padStart(2, '0')}`
}

function Transport(): React.JSX.Element | null {
  const {
    track,
    engineState,
    position,
    duration,
    loop,
    loadError,
    play,
    pause,
    stop,
    seek,
    setLoop
  } = usePlayerStore()

  const loopBarRef = useRef<HTMLDivElement>(null)
  const [dragRange, setDragRange] = useState<{ start: number; end: number } | null>(null)
  // 시크바 스크럽: 포인터를 누르고 있는 동안은 썸만 움직이고, 놓을 때 한 번만 시크한다.
  // (클릭도 mousedown의 input과 mouseup의 change가 1px만 달라도 시크가 두 번 나가 시작 구간이 반복된다)
  const scrubRef = useRef<number | null>(null)
  const [scrub, setScrub] = useState<number | null>(null)

  const commitScrub = (): void => {
    const target = scrubRef.current
    scrubRef.current = null
    setScrub(null)
    if (target !== null) seek(target)
  }

  const onSeekPointerDown = (): void => {
    if (!active) return
    scrubRef.current = position
    setScrub(position)
    window.addEventListener('pointerup', commitScrub, { once: true })
  }

  const onSeekChange = (value: number): void => {
    if (scrubRef.current !== null) {
      scrubRef.current = value
      setScrub(value)
    } else {
      seek(value) // 키보드 조작 등 포인터 없는 변경은 즉시
    }
  }

  // 상태와 무관하게 바 구조는 항상 동일하게 유지한다 (레이아웃 점프 방지).
  // 곡 없음/로딩/에러는 컨트롤 비활성화 + 아티스트 줄의 상태 텍스트로만 표현한다.
  const active = track !== null && engineState !== 'idle' && engineState !== 'loading'
  const playing = engineState === 'playing'
  const statusLine = loadError
    ? `재생 로드 실패: ${loadError}`
    : engineState === 'loading'
      ? '로딩 중…'
      : (track?.artist ?? ' ') // 아티스트가 없어도 줄 높이를 유지한다

  const fractionAt = (event: PointerEvent): number => {
    const rect = loopBarRef.current!.getBoundingClientRect()
    return Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width))
  }

  const onLoopPointerDown = (event: PointerEvent): void => {
    if (!active) return
    event.currentTarget.setPointerCapture(event.pointerId)
    const at = fractionAt(event) * duration
    setDragRange({ start: at, end: at })
  }

  const onLoopPointerMove = (event: PointerEvent): void => {
    if (!dragRange) return
    setDragRange({ start: dragRange.start, end: fractionAt(event) * duration })
  }

  const onLoopPointerUp = (): void => {
    if (!dragRange) return
    setLoop(normalizeLoop(dragRange.start, dragRange.end, duration))
    setDragRange(null)
  }

  const bpmText = track ? formatBpmDisplay(track.bpm, track.bpmConf) : null

  const shownLoop = dragRange
    ? {
        start: Math.min(dragRange.start, dragRange.end),
        end: Math.max(dragRange.start, dragRange.end)
      }
    : loop

  return (
    <div className={`player-bar${active ? '' : ' player-bar-idle'}`}>
      <input
        className="seekbar"
        type="range"
        min={0}
        max={active ? duration : 1}
        step={0.1}
        value={active ? (scrub ?? position) : 0}
        disabled={!active}
        onPointerDown={onSeekPointerDown}
        onChange={(e) => onSeekChange(Number(e.target.value))}
      />

      <div className="loop-row">
        <div
          ref={loopBarRef}
          className="loop-bar"
          title="드래그해서 루프 구간 지정"
          onPointerDown={onLoopPointerDown}
          onPointerMove={onLoopPointerMove}
          onPointerUp={onLoopPointerUp}
        >
          {shownLoop && duration > 0 && (
            <div
              className="loop-region"
              style={{
                left: `${(shownLoop.start / duration) * 100}%`,
                width: `${((shownLoop.end - shownLoop.start) / duration) * 100}%`
              }}
            />
          )}
          {active && duration > 0 && (
            <div className="loop-playhead" style={{ left: `${(position / duration) * 100}%` }} />
          )}
        </div>
      </div>

      <div className="player-main">
        {track ? (
          <CoverArt trackId={track.id} version={track.updatedAt} className="player-art" />
        ) : (
          <div className="player-art" aria-hidden="true">
            <MdMusicNote />
          </div>
        )}
        <div className="player-track">
          <span className="player-title" title={track?.title}>
            {track?.title ?? '재생할 곡을 선택하세요'}
          </span>
          <span
            className={`player-artist${loadError ? ' player-artist-error' : ''}`}
            title={loadError ?? track?.artist ?? undefined}
          >
            {statusLine}
          </span>
        </div>

        <div className="player-transport">
          <button
            className="play-toggle"
            title={playing ? '일시정지 (Space)' : '재생 (Space)'}
            disabled={!active}
            onClick={playing ? pause : play}
          >
            {playing ? <MdPause /> : <MdPlayArrow />}
          </button>
          <button title="정지" disabled={!active} onClick={stop}>
            <MdStop />
          </button>
          <button
            className={loop ? 'loop-on' : ''}
            title={loop ? '루프 해제 (L)' : '루프 없음 — 시크바 아래 바를 드래그해 지정'}
            disabled={!loop}
            onClick={() => setLoop(null)}
          >
            <MdRepeat />
          </button>
          <span
            className={`transport-bpm${bpmText ? '' : ' transport-bpm-empty'}`}
            title="BPM (분석값 또는 메타 편집값)"
          >
            {bpmText ?? '—'}
          </span>
          <span className="transport-time">
            {formatTime(position)} / {formatTime(duration)}
          </span>
        </div>
      </div>
    </div>
  )
}

export default Transport
