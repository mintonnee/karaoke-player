import { formatKeyDisplay, transposeKey } from '../../../shared/musicKey'
import { usePlayerStore } from '../stores/playerStore'

/**
 * 사이드 컬럼 키 패널 (스펙 003 §4.3, §1 결정 기록).
 * 상단 = 원키(항상 파란 계열), 가운데 = -/리셋/+ , 하단 = 변경 키(이동 중이면 붉은 계열).
 * 곡이 없어도 구조는 동일하게 렌더링해 레이아웃 점프를 막는다.
 */
function KeyPanel(): React.JSX.Element {
  const { track, pitch, setPitch, engineState } = usePlayerStore()

  const active = track !== null && engineState !== 'idle' && engineState !== 'loading'
  const originalKey = formatKeyDisplay(track?.musicKey) ?? '—'
  const currentKey = transposeKey(track?.musicKey, pitch) ?? '—'
  const resetLabel = pitch > 0 ? `+${pitch}` : `${pitch}`

  return (
    <div className="key-panel">
      <div className="key-box key-original">
        <span className="key-box-label">원키</span>
        <span className="key-box-value">{originalKey}</span>
      </div>
      <div className="key-row">
        <button onClick={() => setPitch(pitch - 1)} disabled={!active || pitch <= -6}>
          −
        </button>
        <button
          className="key-reset"
          title="원키로 (−/= 로 조절)"
          onClick={() => setPitch(0)}
          disabled={!active || pitch === 0}
        >
          {resetLabel}
        </button>
        <button onClick={() => setPitch(pitch + 1)} disabled={!active || pitch >= 6}>
          +
        </button>
      </div>
      <div className={`key-box key-current${pitch !== 0 ? ' shifted' : ''}`}>
        <span className="key-box-label">조정키</span>
        <span className="key-box-value">{currentKey}</span>
      </div>
    </div>
  )
}

export default KeyPanel
