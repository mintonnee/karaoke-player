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
    setLoop,
    loopMarkA,
    cycleLoopAB
  } = usePlayerStore()

  const barRef = useRef<HTMLDivElement>(null)
  /**
   * 통합 바 드래그 상태. 좌클릭(seek)은 놓을 때 한 번만 시크한다 — 누르는 동안은 썸만 따라간다.
   * 우클릭(loop)은 누른 지점부터 놓은 지점까지를 루프 구간으로 지정한다.
   */
  const [drag, setDrag] = useState<
    { kind: 'seek'; at: number } | { kind: 'loop'; start: number; end: number } | null
  >(null)

  // 상태와 무관하게 바 구조는 항상 동일하게 유지한다 (레이아웃 점프 방지).
  // 곡 없음/로딩/에러는 컨트롤 비활성화 + 아티스트 줄의 상태 텍스트로만 표현한다.
  const active = track !== null && engineState !== 'idle' && engineState !== 'loading'
  const playing = engineState === 'playing'
  const statusLine = loadError
    ? `재생 로드 실패: ${loadError}`
    : engineState === 'loading'
      ? '로딩 중…'
      : (track?.artist ?? ' ') // 아티스트가 없어도 줄 높이를 유지한다

  const timeAt = (event: PointerEvent): number => {
    const rect = barRef.current!.getBoundingClientRect()
    const fraction = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width))
    return fraction * duration
  }

  const onBarPointerDown = (event: PointerEvent): void => {
    if (!active || duration <= 0) return
    // 0: 좌클릭 → 시크, 2: 우클릭 → 루프. 가운데 버튼 등은 무시
    if (event.button !== 0 && event.button !== 2) return
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    const at = timeAt(event)
    // 루프 핸들을 좌클릭으로 잡으면 반대쪽 끝을 고정한 채 그 경계만 옮긴다
    const edge = (event.target as HTMLElement).dataset.loopEdge
    if (event.button === 0 && edge && loop) {
      setDrag({ kind: 'loop', start: edge === 'start' ? loop.end : loop.start, end: at })
      return
    }
    setDrag(event.button === 2 ? { kind: 'loop', start: at, end: at } : { kind: 'seek', at })
  }

  const onBarPointerMove = (event: PointerEvent): void => {
    if (!drag) return
    const at = timeAt(event)
    setDrag(drag.kind === 'seek' ? { kind: 'seek', at } : { ...drag, end: at })
  }

  const onBarPointerUp = (event: PointerEvent): void => {
    if (!drag) return
    // 마지막 move 이후 놓은 좌표까지 반영하도록 이벤트 좌표를 다시 읽는다
    const at = timeAt(event)
    if (drag.kind === 'seek') seek(at)
    else setLoop(normalizeLoop(drag.start, at, duration))
    setDrag(null)
  }

  const bpmText = track ? formatBpmDisplay(track.bpm, track.bpmConf) : null

  const shownPosition = drag?.kind === 'seek' ? drag.at : position
  const shownLoop =
    drag?.kind === 'loop'
      ? { start: Math.min(drag.start, drag.end), end: Math.max(drag.start, drag.end) }
      : loop
  const pct = (seconds: number): string => `${duration > 0 ? (seconds / duration) * 100 : 0}%`

  return (
    <div className={`player-bar${active ? '' : ' player-bar-idle'}`}>
      {/* 시크바 + 루프 바 통합: 좌클릭 드래그 → 시크, 우클릭 드래그 → 루프 구간. 양 끝에 경과/총 시간 */}
      <div className="seek-row">
        <span className="seek-time">{formatTime(active ? shownPosition : 0)}</span>
        <div
          ref={barRef}
          className={`seek-loop-bar${drag ? ` dragging-${drag.kind}` : ''}${
            shownLoop ? ' has-loop' : ''
          }`}
          title="좌클릭: 이동 · 우클릭 드래그: 루프 구간 지정 · 핸들 드래그: 루프 경계 조정"
          onPointerDown={onBarPointerDown}
          onPointerMove={onBarPointerMove}
          onPointerUp={onBarPointerUp}
          onPointerCancel={() => setDrag(null)}
          onContextMenu={(e) => e.preventDefault()}
        >
          <div className="seek-track">
            {active && <div className="seek-fill" style={{ width: pct(shownPosition) }} />}
            {shownLoop && duration > 0 && (
              <div
                className="loop-region"
                style={{ left: pct(shownLoop.start), width: pct(shownLoop.end - shownLoop.start) }}
              />
            )}
            {/* 루프 구간 중 이미 재생한 부분: 진행 채움과 겹치는 곳을 더 진한 색으로 강조 */}
            {active && shownLoop && shownPosition > shownLoop.start && (
              <div
                className="loop-region-played"
                style={{
                  left: pct(shownLoop.start),
                  width: pct(Math.min(shownPosition, shownLoop.end) - shownLoop.start)
                }}
              />
            )}
          </div>
          {/* A-B 반복: A만 찍힌 상태 표시 */}
          {active && loopMarkA !== null && !shownLoop && (
            <div className="loop-mark-a" style={{ left: pct(loopMarkA) }}>
              A
            </div>
          )}
          {/* 루프 양 끝 핸들 + 시각 라벨. 좌클릭 드래그로 경계 조정 */}
          {active && shownLoop && (
            <>
              <div
                className="loop-handle start"
                data-loop-edge="start"
                style={{ left: pct(shownLoop.start) }}
              >
                <span className="loop-handle-time">{formatTime(shownLoop.start)}</span>
              </div>
              <div
                className="loop-handle end"
                data-loop-edge="end"
                style={{ left: pct(shownLoop.end) }}
              >
                <span className="loop-handle-time">{formatTime(shownLoop.end)}</span>
              </div>
            </>
          )}
          {active && <div className="seek-thumb" style={{ left: pct(shownPosition) }} />}
        </div>
        <span className="seek-time">{formatTime(active ? duration : 0)}</span>
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
          <span
            className={`transport-bpm${bpmText ? '' : ' transport-bpm-empty'}`}
            title="BPM (분석값 또는 메타 편집값)"
          >
            {bpmText ?? '—'}
          </span>
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
            className={`loop-ab${loop ? ' loop-on' : loopMarkA !== null ? ' loop-armed' : ''}`}
            title={
              loop
                ? '루프 해제 (L)'
                : loopMarkA !== null
                  ? `A 지점 ${formatTime(loopMarkA)} — 한 번 더 누르면 현재 위치까지 루프 (L)`
                  : 'A-B 반복: 누르면 현재 위치가 A, 다시 누르면 B (L)'
            }
            disabled={!active}
            onClick={cycleLoopAB}
          >
            <MdRepeat />
            {!loop && loopMarkA !== null && <span className="loop-ab-badge">A</span>}
          </button>
        </div>
      </div>
    </div>
  )
}

export default Transport
