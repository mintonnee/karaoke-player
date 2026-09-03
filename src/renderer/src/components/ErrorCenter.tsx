import { useEffect, useState } from 'react'
import { MdClose, MdDeleteOutline, MdOpenInNew } from 'react-icons/md'
import { buildIssueUrl, sourceLabel } from '../../../shared/issueReport'
import type { AppInfo } from '../../../shared/types'
import { useErrorStore } from '../stores/errorStore'
import type { AppErrorEntry } from '../stores/errorStore'

interface ErrorCenterProps {
  onClose: () => void
}

function formatAt(iso: string): string {
  const date = new Date(iso)
  const hh = String(date.getHours()).padStart(2, '0')
  const mm = String(date.getMinutes()).padStart(2, '0')
  const ss = String(date.getSeconds()).padStart(2, '0')
  return `${hh}:${mm}:${ss}`
}

/**
 * 오류 센터 모달. 이번 세션의 실패 목록을 보여주고, 항목별 또는 전체를
 * GitHub 새 이슈 링크(제목·본문 미리 채움)로 보낸다. 본문에서 홈 경로는 가려진다.
 */
function ErrorCenter({ onClose }: ErrorCenterProps): React.JSX.Element {
  const { entries, remove, clear } = useErrorStore()
  const [info, setInfo] = useState<AppInfo | null>(null)

  useEffect(() => {
    void window.api.getAppInfo().then(setInfo)
  }, [])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  const report = (targets: AppErrorEntry[]): void => {
    if (!info || targets.length === 0) return
    void window.api.openExternal(buildIssueUrl(targets, info))
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal modal-sm error-center" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>오류 기록</h2>
          <div className="error-center-actions">
            {entries.length > 0 && (
              <>
                <button
                  className="icon-btn text-btn"
                  disabled={!info}
                  onClick={() => report(entries)}
                >
                  <MdOpenInNew /> 전체 보고
                </button>
                <button className="icon-btn text-btn" onClick={clear}>
                  <MdDeleteOutline /> 모두 지우기
                </button>
              </>
            )}
            <button className="icon-btn" title="닫기" onClick={onClose}>
              <MdClose />
            </button>
          </div>
        </div>
        <div className="modal-body">
          {entries.length === 0 ? (
            <p className="error-center-empty">이번 세션에 기록된 오류가 없습니다.</p>
          ) : (
            <ul className="error-list">
              {entries.map((entry) => (
                <li key={entry.id} className={`error-item${entry.seen ? '' : ' unseen'}`}>
                  <div className="error-item-head">
                    <span className="error-item-time">{formatAt(entry.at)}</span>
                    <span className="error-item-source">{sourceLabel(entry.source)}</span>
                    <span className="error-item-spacer" />
                    <button
                      className="icon-btn"
                      title="GitHub 이슈로 보고"
                      disabled={!info}
                      onClick={() => report([entry])}
                    >
                      <MdOpenInNew />
                    </button>
                    <button className="icon-btn" title="지우기" onClick={() => remove(entry.id)}>
                      <MdDeleteOutline />
                    </button>
                  </div>
                  <p className="error-item-message">{entry.message}</p>
                </li>
              ))}
            </ul>
          )}
          <p className="error-center-note">
            보고 링크는 브라우저에서 GitHub 새 이슈 페이지를 엽니다. 제목과 본문이 미리 채워지며,
            사용자 폴더 경로는 가려집니다. 제출 전에 내용을 확인해 주세요.
          </p>
        </div>
      </div>
    </div>
  )
}

export default ErrorCenter
