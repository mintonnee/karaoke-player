import { useEffect, useRef, useState } from 'react'
import { MdClose, MdDownload } from 'react-icons/md'
import { useLibraryStore } from '../stores/libraryStore'

interface UrlImportFormProps {
  onClose: () => void
}

/**
 * URL 임포트 입력 줄 (스펙 001 §4.3). Enter 제출 / Esc 닫기.
 * 다운로드 중에는 yt-dlp 진행률을 표시하고, 성공하면 스스로 닫힌다.
 * 실패 사유는 기존 rejections 목록으로 표면화되므로 여기서는 다루지 않는다.
 */
function UrlImportForm({ onClose }: UrlImportFormProps): React.JSX.Element {
  const importUrl = useLibraryStore((s) => s.importUrl)
  const importing = useLibraryStore((s) => s.urlImporting)
  const progress = useLibraryStore((s) => s.urlImportProgress)
  const [url, setUrl] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const submit = async (): Promise<void> => {
    const trimmed = url.trim()
    if (!trimmed || importing) return
    if (await importUrl(trimmed)) {
      setUrl('')
      onClose()
    }
  }

  return (
    <div className="url-import">
      <div className="url-import-row">
        <input
          ref={inputRef}
          className="url-import-input"
          type="text"
          spellCheck={false}
          placeholder="YouTube 주소를 붙여넣고 Enter (오디오만 내려받습니다)"
          value={url}
          disabled={importing}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              void submit()
            } else if (e.key === 'Escape') {
              e.preventDefault()
              onClose()
            }
          }}
        />
        <button
          className="icon-btn"
          title="가져오기"
          disabled={importing || url.trim() === ''}
          onClick={() => void submit()}
        >
          <MdDownload />
        </button>
        <button className="icon-btn" title="닫기" disabled={importing} onClick={onClose}>
          <MdClose />
        </button>
      </div>
      {importing && (
        <div className="url-import-status">
          <div className="progress">
            <div className="progress-fill" style={{ width: `${progress?.pct ?? 0}%` }} />
            <span className="progress-label">{Math.round(progress?.pct ?? 0)}%</span>
          </div>
          <span className="url-import-msg">{progress?.msg ?? '다운로드 준비 중…'}</span>
        </div>
      )}
    </div>
  )
}

export default UrlImportForm
