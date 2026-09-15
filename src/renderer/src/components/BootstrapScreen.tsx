import { MdErrorOutline } from 'react-icons/md'
import {
  BOOTSTRAP_STAGE_LABEL,
  bootstrapDisplayStage,
  isBootstrapRetryable
} from '../../../shared/bootstrap'
import type { BootstrapState } from '../../../shared/types'

export type BootstrapBannerVariant = 'panel' | 'strip'

interface BootstrapScreenProps {
  state: BootstrapState
  onRetry: () => void
  variant?: BootstrapBannerVariant
}

function stageText(state: BootstrapState): string {
  const stage = bootstrapDisplayStage(state)
  const label = stage ? BOOTSTRAP_STAGE_LABEL[stage] : null
  if (label && state.message && !state.message.includes(label)) {
    return `${label} — ${state.message}`
  }
  return state.message || label || '준비 중'
}

/** 라이브러리를 막지 않는 준비 배너/상태 줄 (스펙 008 기준 10) */
function BootstrapScreen({
  state,
  onRetry,
  variant = 'panel'
}: BootstrapScreenProps): React.JSX.Element {
  const failed = state.status === 'error'
  const retryable = isBootstrapRetryable(state)
  const stage = bootstrapDisplayStage(state)
  const logicalId = state.logicalId

  return (
    <div
      className={`bootstrap-banner bootstrap-${variant}${failed ? ' bootstrap-failed' : ''}`}
      role="status"
    >
      <div className="bootstrap-banner-body">
        <p className={`bootstrap-stage${failed ? ' bootstrap-stage-error' : ''}`}>
          {failed && <MdErrorOutline />}
          {stageText(state)}
        </p>
        {(logicalId || stage) && (
          <p className="bootstrap-meta">
            {logicalId ? `id=${logicalId}` : null}
            {logicalId && stage ? ' · ' : null}
            {stage ? `stage=${stage}` : null}
            {failed ? ` · retryable=${retryable}` : null}
          </p>
        )}
        {failed ? (
          <>
            {state.error && <p className="bootstrap-error">{state.error}</p>}
            <p className="bootstrap-note">
              네트워크 연결을 확인한 뒤 다시 시도하세요. 이미 받은 파일은 재사용됩니다.
            </p>
            {retryable && (
              <button type="button" className="bootstrap-retry" onClick={onRetry}>
                다시 시도
              </button>
            )}
          </>
        ) : (
          <>
            <div className="bootstrap-progress">
              <span />
            </div>
            {variant === 'panel' && (
              <p className="bootstrap-note">
                Python 환경을 준비하는 동안 기존 곡은 재생할 수 있습니다. 가져오기·가사 정렬은 준비
                후에 사용할 수 있습니다.
              </p>
            )}
          </>
        )}
      </div>
      {state.log.length > 0 && variant === 'panel' && (
        <pre className="bootstrap-log">{state.log.join('\n')}</pre>
      )}
    </div>
  )
}

export default BootstrapScreen
