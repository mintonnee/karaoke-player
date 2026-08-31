import { useRef, useState } from 'react'
import type { PointerEvent } from 'react'
import { normalizeLoop } from '../audio/audioMath'
import { usePlayerStore } from '../stores/playerStore'

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
    instDb,
    vocalDb,
    vocalMuted,
    loop,
    loadError,
    play,
    pause,
    stop,
    seek,
    setInstDb,
    setVocalDb,
    toggleVocalMute,
    setLoop
  } = usePlayerStore()

  const loopBarRef = useRef<HTMLDivElement>(null)
  const [dragRange, setDragRange] = useState<{ start: number; end: number } | null>(null)

  if (loadError) {
    return <div className="transport transport-error">재생 로드 실패: {loadError}</div>
  }
  if (!track || engineState === 'idle') return null
  if (engineState === 'loading') {
    return <div className="transport">로딩 중… — {track.title}</div>
  }

  const playing = engineState === 'playing'

  const fractionAt = (event: PointerEvent): number => {
    const rect = loopBarRef.current!.getBoundingClientRect()
    return Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width))
  }

  const onLoopPointerDown = (event: PointerEvent): void => {
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

  const shownLoop = dragRange
    ? {
        start: Math.min(dragRange.start, dragRange.end),
        end: Math.max(dragRange.start, dragRange.end)
      }
    : loop

  return (
    <div className="transport">
      <div className="transport-title">
        {track.title} <span className="transport-artist">{track.artist ?? ''}</span>
      </div>

      <div className="transport-controls">
        <button onClick={playing ? pause : play}>{playing ? '⏸' : '▶'}</button>
        <button onClick={stop}>⏹</button>
        <span className="transport-time">
          {formatTime(position)} / {formatTime(duration)}
        </span>
      </div>

      <input
        className="seekbar"
        type="range"
        min={0}
        max={duration}
        step={0.1}
        value={position}
        onChange={(e) => seek(Number(e.target.value))}
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
          <div className="loop-playhead" style={{ left: `${(position / duration) * 100}%` }} />
        </div>
        <button className="loop-clear" disabled={!loop} onClick={() => setLoop(null)}>
          루프 해제
        </button>
      </div>

      <div className="faders">
        <label className="fader">
          <span>반주 {instDb} dB</span>
          <input
            type="range"
            min={-60}
            max={0}
            step={1}
            value={instDb}
            onChange={(e) => setInstDb(Number(e.target.value))}
          />
        </label>
        <label className="fader">
          <span className={vocalMuted ? 'muted' : ''}>가이드 보컬 {vocalDb} dB</span>
          <input
            type="range"
            min={-60}
            max={0}
            step={1}
            value={vocalDb}
            disabled={vocalMuted}
            onChange={(e) => setVocalDb(Number(e.target.value))}
          />
        </label>
        <button className={`mute-toggle${vocalMuted ? ' active' : ''}`} onClick={toggleVocalMute}>
          {vocalMuted ? '보컬 켜기' : '보컬 뮤트'}
        </button>
      </div>
    </div>
  )
}

export default Transport
