import { MdErrorOutline } from 'react-icons/md'
import {
  BOOTSTRAP_STAGE_LABEL,
  bootstrapDisplayStage,
  bootstrapStatusMessage,
  isBootstrapRetryable
} from '../../../shared/bootstrap'
import type { BootstrapState } from '../../../shared/types'

interface BootstrapScreenProps {
  state: BootstrapState | null
  retrying: boolean
  retryError: string | null
  onRetry: () => void
}

function statusTitle(state: BootstrapState | null): string {
  if (!state) return '준비 상태 확인 중'
  const stage = bootstrapDisplayStage(state)
  const label = stage ? BOOTSTRAP_STAGE_LABEL[stage] : '실행 환경'
  return state.status === 'error' ? `${label} 실패` : (bootstrapStatusMessage(state) ?? label)
}

/** 알림 센터 상단의 현재 준비 상태 카드. ready 상태에서는 호출자가 숨긴다. */
function BootstrapScreen({
  state,
  retrying,
  retryError,
  onRetry
}: BootstrapScreenProps): React.JSX.Element {
  const failed = state?.status === 'error'
  const stage = bootstrapDisplayStage(state)
  const runtimeFailure = failed && stage !== 'model-prep'
  const retryable = runtimeFailure && isBootstrapRetryable(state)
  const title = statusTitle(state)

  return (
    <section className={`notification-status${failed ? ' is-failed' : ''}`}>
      <div className="notification-status-head">
        <div>
          <p className="notification-section-label">현재 상태</p>
          <p
            className="notification-status-title"
            role="status"
            aria-live="polite"
            aria-atomic="true"
          >
            {failed && <MdErrorOutline aria-hidden="true" />}
            {title}
          </p>
        </div>
        {!failed && <span className="notification-status-progress" aria-hidden="true" />}
      </div>

      {failed && (
        <p className="notification-status-note">
          실행 환경이 필요한 작업은 사용할 수 없습니다. 기존 곡 재생은 계속할 수 있습니다.
        </p>
      )}

      {retryable && (
        <button type="button" className="bootstrap-retry" disabled={retrying} onClick={onRetry}>
          {retrying ? '다시 시도 중…' : '다시 시도'}
        </button>
      )}
      {retryError && (
        <p className="notification-retry-error" role="alert">
          {retryError}
        </p>
      )}

      {state && (
        <details className="notification-status-details">
          <summary>상세 보기</summary>
          <div className="notification-status-detail-body">
            <p>
              id={state.logicalId ?? 'runtime'} · stage={stage ?? state.status} · retryable=
              {String(state.retryable === true)}
            </p>
            {state.message && <p>{state.message}</p>}
            {state.error && <p className="notification-technical-error">{state.error}</p>}
            {state.log.length > 0 && <pre>{state.log.join('\n')}</pre>}
          </div>
        </details>
      )}
    </section>
  )
}

export default BootstrapScreen
