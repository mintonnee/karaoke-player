import { useEffect, useRef } from 'react'
import { MdMic, MdMicOff, MdMusicNote, MdMusicOff, MdVolumeOff, MdVolumeUp } from 'react-icons/md'
import type { AudioLevels } from '../audio/AudioEngine'
import { usePlayerStore } from '../stores/playerStore'

const HOT_THRESHOLD_DB = -12

/** dB(-60..0) -> 미터 높이(0..100%) */
function levelToPercent(db: number): number {
  const clamped = Math.max(-60, Math.min(0, db))
  return ((clamped + 60) / 60) * 100
}

/**
 * 사이드 컬럼 믹서 패널 (스펙 003 §4.2).
 * 메인/반주/보컬 세로 페이더 + 뮤트 + 재생 레벨 미터.
 * 레벨은 30 Hz로 push되므로 React 상태로 올리지 않고 ref를 통해 DOM만 갱신한다.
 */
function MixerPanel(): React.JSX.Element {
  const {
    track,
    engineState,
    instDb,
    vocalDb,
    masterDb,
    instMuted,
    vocalMuted,
    masterMuted,
    setInstDb,
    setVocalDb,
    setMasterDb,
    toggleInstMute,
    toggleVocalMute,
    toggleMasterMute,
    subscribeLevels
  } = usePlayerStore()

  const active = track !== null && engineState !== 'idle' && engineState !== 'loading'

  const masterMeterRef = useRef<HTMLDivElement>(null)
  const instMeterRef = useRef<HTMLDivElement>(null)
  const vocalMeterRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const applyLevel = (el: HTMLDivElement | null, db: number): void => {
      if (!el) return
      el.style.height = `${levelToPercent(db)}%`
      el.classList.toggle('hot', db > HOT_THRESHOLD_DB)
    }
    const onLevels = (levels: AudioLevels): void => {
      applyLevel(masterMeterRef.current, levels.master)
      applyLevel(instMeterRef.current, levels.inst)
      applyLevel(vocalMeterRef.current, levels.vocal)
    }
    return subscribeLevels(onLevels)
  }, [subscribeLevels])

  return (
    <div className="mixer-panel">
      <span className="mixer-panel-title">믹서</span>
      <div className="mixer-strips">
        <div className="mixer-strip">
          <span className="mixer-label">메인</span>
          <div className="mixer-body">
            <input
              className="mixer-fader"
              type="range"
              min={-60}
              max={0}
              step={1}
              value={masterDb}
              disabled={!active || masterMuted}
              onChange={(e) => setMasterDb(Number(e.target.value))}
            />
            <div className="meter">
              <div ref={masterMeterRef} className="meter-fill" />
            </div>
          </div>
          <span className={`mixer-db${masterMuted ? ' muted' : ''}`}>{masterDb} dB</span>
          <button
            className={`icon-btn${masterMuted ? ' muted-on' : ''}`}
            title={masterMuted ? '메인 뮤트 해제 (M)' : '메인 뮤트 (M)'}
            disabled={!active}
            onClick={toggleMasterMute}
          >
            {masterMuted ? <MdVolumeOff /> : <MdVolumeUp />}
          </button>
        </div>

        <div className="mixer-strip">
          <span className="mixer-label">반주</span>
          <div className="mixer-body">
            <input
              className="mixer-fader"
              type="range"
              min={-60}
              max={0}
              step={1}
              value={instDb}
              disabled={!active || instMuted}
              onChange={(e) => setInstDb(Number(e.target.value))}
            />
            <div className="meter">
              <div ref={instMeterRef} className="meter-fill" />
            </div>
          </div>
          <span className={`mixer-db${instMuted ? ' muted' : ''}`}>{instDb} dB</span>
          <button
            className={`icon-btn${instMuted ? ' muted-on' : ''}`}
            title={instMuted ? '반주 뮤트 해제' : '반주 뮤트'}
            disabled={!active}
            onClick={toggleInstMute}
          >
            {instMuted ? <MdMusicOff /> : <MdMusicNote />}
          </button>
        </div>

        <div className="mixer-strip">
          <span className="mixer-label">보컬</span>
          <div className="mixer-body">
            <input
              className="mixer-fader"
              type="range"
              min={-60}
              max={0}
              step={1}
              value={vocalDb}
              disabled={!active || vocalMuted}
              onChange={(e) => setVocalDb(Number(e.target.value))}
            />
            <div className="meter">
              <div ref={vocalMeterRef} className="meter-fill" />
            </div>
          </div>
          <span className={`mixer-db${vocalMuted ? ' muted' : ''}`}>{vocalDb} dB</span>
          <button
            className={`icon-btn${vocalMuted ? ' muted-on' : ''}`}
            title={vocalMuted ? '보컬 뮤트 해제 (V)' : '보컬 뮤트 (V)'}
            disabled={!active}
            onClick={toggleVocalMute}
          >
            {vocalMuted ? <MdMicOff /> : <MdMic />}
          </button>
        </div>
      </div>
    </div>
  )
}

export default MixerPanel
