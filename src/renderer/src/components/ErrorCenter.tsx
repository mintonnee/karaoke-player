import { useEffect, useRef, useState } from 'react'
import { MdClose, MdDeleteOutline, MdOpenInNew } from 'react-icons/md'
import { buildIssueUrl, sourceLabel } from '../../../shared/issueReport'
import type { AppInfo, BootstrapState } from '../../../shared/types'
import { retryBootstrap, useBootstrapStore } from '../stores/bootstrapStore'
import { useErrorStore } from '../stores/errorStore'
import type { AppErrorEntry } from '../stores/errorStore'
import BootstrapScreen from './BootstrapScreen'

export interface ErrorCenterProps {
  onClose: () => void
}

export interface NotificationCenterProps extends ErrorCenterProps {
  entries: AppErrorEntry[]
  state: BootstrapState | null
  retrying: boolean
  retryError: string | null
  remove: (id: string) => void
  clear: () => void
  onRetry: () => void
}

const FOCUSABLE =
  'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], summary, [tabindex]:not([tabindex="-1"])'

function formatAt(iso: string): string {
  const date = new Date(iso)
  const hh = String(date.getHours()).padStart(2, '0')
  const mm = String(date.getMinutes()).padStart(2, '0')
  const ss = String(date.getSeconds()).padStart(2, '0')
  return `${hh}:${mm}:${ss}`
}

/** 현재 준비 상태와 이번 세션의 오류 기록을 함께 보여주는 알림 모달 본문. */
export function NotificationCenter({
  onClose,
  entries,
  state,
  retrying,
  retryError,
  remove,
  clear,
  onRetry
}: NotificationCenterProps): React.JSX.Element {
  const [info, setInfo] = useState<AppInfo | null>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const onCloseRef = useRef(onClose)

  useEffect(() => {
    onCloseRef.current = onClose
  }, [onClose])

  useEffect(() => {
    void window.api.getAppInfo().then(setInfo)
  }, [])

  useEffect(() => {
    closeRef.current?.focus()
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopImmediatePropagation()
        onCloseRef.current()
        return
      }
      if (event.key !== 'Tab') return
      const panel = panelRef.current
      if (!panel) return
      const items = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE))
      const first = items[0]
      const last = items[items.length - 1]
      if (!first || !last) {
        event.preventDefault()
        return
      }
      const active = document.activeElement
      if (event.shiftKey && (active === first || !panel.contains(active))) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && (active === last || !panel.contains(active))) {
        event.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => document.removeEventListener('keydown', onKeyDown, true)
  }, [])

  const report = (targets: AppErrorEntry[]): void => {
    if (!info || targets.length === 0) return
    void window.api.openExternal(buildIssueUrl(targets, info))
  }

  const showStatus = state?.status !== 'ready'

  return (
    <div className="modal-overlay" onMouseDown={onClose}>
      <div
        ref={panelRef}
        className="modal notification-center"
        role="dialog"
        aria-modal="true"
        aria-labelledby="notification-center-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="modal-header">
          <h2 id="notification-center-title">알림</h2>
          <button ref={closeRef} type="button" className="icon-btn" title="닫기" onClick={onClose}>
            <MdClose aria-hidden="true" />
          </button>
        </div>

        <div className="notification-center-body">
          {showStatus && (
            <BootstrapScreen
              state={state}
              retrying={retrying}
              retryError={retryError}
              onRetry={onRetry}
            />
          )}

          {entries.length > 0 ? (
            <section className="notification-errors" aria-labelledby="notification-errors-title">
              <div className="notification-errors-head">
                <h3 id="notification-errors-title">오류 기록</h3>
                <div className="notification-error-actions">
                  <button
                    type="button"
                    className="icon-btn text-btn"
                    disabled={!info}
                    onClick={() => report(entries)}
                  >
                    <MdOpenInNew aria-hidden="true" /> 전체 보고
                  </button>
                  <button type="button" className="icon-btn text-btn" onClick={clear}>
                    <MdDeleteOutline aria-hidden="true" /> 모두 지우기
                  </button>
                </div>
              </div>
              <ul className="error-list">
                {entries.map((entry) => (
                  <li key={entry.id} className={`error-item${entry.seen ? '' : ' unseen'}`}>
                    <div className="error-item-head">
                      <span className="error-item-time">{formatAt(entry.at)}</span>
                      <span className="error-item-source">{sourceLabel(entry.source)}</span>
                      <span className="error-item-spacer" />
                      <button
                        type="button"
                        className="icon-btn"
                        title="GitHub 이슈로 보고"
                        disabled={!info}
                        onClick={() => report([entry])}
                      >
                        <MdOpenInNew aria-hidden="true" />
                      </button>
                      <button
                        type="button"
                        className="icon-btn"
                        title="지우기"
                        onClick={() => remove(entry.id)}
                      >
                        <MdDeleteOutline aria-hidden="true" />
                      </button>
                    </div>
                    <p className="error-item-message">{entry.message}</p>
                  </li>
                ))}
              </ul>
              <p className="error-center-note">
                보고 링크는 브라우저에서 GitHub 새 이슈 페이지를 엽니다. 사용자 폴더 경로는
                가려지며, 제출 전에 내용을 확인할 수 있습니다.
              </p>
            </section>
          ) : !showStatus ? (
            <p className="notification-center-empty">새로운 알림이 없습니다.</p>
          ) : null}
        </div>
      </div>
    </div>
  )
}

function ErrorCenter({ onClose }: ErrorCenterProps): React.JSX.Element {
  const { entries, remove, clear } = useErrorStore()
  const { state, retrying, retryError } = useBootstrapStore()
  return (
    <NotificationCenter
      onClose={onClose}
      entries={entries}
      state={state}
      retrying={retrying}
      retryError={retryError}
      remove={remove}
      clear={clear}
      onRetry={() => void retryBootstrap()}
    />
  )
}

export default ErrorCenter
