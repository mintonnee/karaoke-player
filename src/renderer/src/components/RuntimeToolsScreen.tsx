import { MdCheckCircle, MdErrorOutline } from 'react-icons/md'
import {
  TOOL_IDS,
  type ToolId,
  type ToolReadinessSnapshot,
  type ToolReadinessState
} from '../../../shared/runtimeTools'

const TOOL_LABEL: Record<ToolId, string> = {
  uv: 'uv',
  deno: 'Deno',
  'yt-dlp': 'yt-dlp'
}

const STATUS_LABEL: Record<ToolReadinessState['status'], string> = {
  pending: '준비 대기 중',
  downloading: '다운로드 중',
  verifying: '검증 중',
  ready: '준비 완료',
  error: '준비 실패',
  disabled: '이 배포판에서 사용 안 함'
}

export interface RuntimeToolsScreenProps {
  snapshot: ToolReadinessSnapshot
  loaded: boolean
  loadError: string | null
  retrying: Record<ToolId, boolean>
  retryErrors: Record<ToolId, string | null>
  onRetry: (toolId: ToolId) => void
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function progressText(state: ToolReadinessState): string | null {
  if (state.status !== 'downloading' || state.downloadedBytes == null) return null
  const downloaded = formatBytes(state.downloadedBytes)
  return state.totalBytes == null ? downloaded : `${downloaded} / ${formatBytes(state.totalBytes)}`
}

function RuntimeToolsScreen({
  snapshot,
  loaded,
  loadError,
  retrying,
  retryErrors,
  onRetry
}: RuntimeToolsScreenProps): React.JSX.Element {
  return (
    <section className="notification-tools" aria-labelledby="notification-tools-title">
      <div className="notification-tools-head">
        <div>
          <p className="notification-section-label">다운로드 도구</p>
          <h3 id="notification-tools-title">도구 준비 상태</h3>
        </div>
        {!loaded && <span className="notification-status-progress" aria-hidden="true" />}
      </div>

      {loadError && (
        <p className="notification-retry-error" role="alert">
          {loadError}
        </p>
      )}

      <ul className="notification-tool-list">
        {TOOL_IDS.map((toolId) => {
          const state = snapshot.tools[toolId]
          const progress = progressText(state)
          const failed = state.status === 'error'
          const inProgress =
            state.status === 'pending' ||
            state.status === 'downloading' ||
            state.status === 'verifying'
          return (
            <li key={toolId} className={`notification-tool is-${state.status}`}>
              <div className="notification-tool-main">
                <span className="notification-tool-icon" aria-hidden="true">
                  {failed ? (
                    <MdErrorOutline />
                  ) : state.status === 'ready' ? (
                    <MdCheckCircle />
                  ) : inProgress ? (
                    <span className="notification-status-progress" />
                  ) : null}
                </span>
                <span className="notification-tool-name">{TOOL_LABEL[toolId]}</span>
                <span className="notification-tool-status" role="status">
                  {STATUS_LABEL[state.status]}
                  {progress ? ` · ${progress}` : ''}
                </span>
                {failed && state.retryable && (
                  <button
                    type="button"
                    className="bootstrap-retry"
                    disabled={retrying[toolId]}
                    onClick={() => onRetry(toolId)}
                  >
                    {retrying[toolId] ? '다시 시도 중…' : '다시 시도'}
                  </button>
                )}
              </div>
              {state.error && <p className="notification-technical-error">{state.error}</p>}
              {retryErrors[toolId] && (
                <p className="notification-retry-error" role="alert">
                  {retryErrors[toolId]}
                </p>
              )}
              {failed && (
                <p className="notification-tool-stage">
                  tool={toolId} · stage={state.status} · retryable={String(state.retryable)}
                </p>
              )}
            </li>
          )
        })}
      </ul>
    </section>
  )
}

export default RuntimeToolsScreen
