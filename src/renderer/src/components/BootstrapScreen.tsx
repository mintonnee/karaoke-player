import { MdErrorOutline } from 'react-icons/md'
import type { BootstrapState } from '../../../shared/types'

interface BootstrapScreenProps {
  state: BootstrapState
  onRetry: () => void
}

/** 첫 실행 부트스트랩 화면 (스펙 001 §4.1): 단계 텍스트 + 불확정 진행 표시 + uv 로그 꼬리 */
function BootstrapScreen({ state, onRetry }: BootstrapScreenProps): React.JSX.Element {
  const failed = state.status === 'error'
  return (
    <div className="bootstrap-screen">
      <div className="bootstrap-card">
        <h1>Karaoke Player</h1>
        <p className={`bootstrap-stage${failed ? ' bootstrap-stage-error' : ''}`}>
          {failed && <MdErrorOutline />}
          {state.message}
        </p>
        {failed ? (
          <>
            {state.error && <p className="bootstrap-error">{state.error}</p>}
            <p className="bootstrap-note">
              네트워크 연결을 확인한 뒤 다시 시도하세요. 이미 받은 파일은 재사용됩니다.
            </p>
            <button className="bootstrap-retry" onClick={onRetry}>
              다시 시도
            </button>
          </>
        ) : (
          <>
            <div className="bootstrap-progress">
              <span />
            </div>
            <p className="bootstrap-note">
              첫 실행에서만 Python 환경을 내려받습니다. 창을 닫지 말고 기다려 주세요.
            </p>
          </>
        )}
        {state.log.length > 0 && <pre className="bootstrap-log">{state.log.join('\n')}</pre>}
      </div>
    </div>
  )
}

export default BootstrapScreen
