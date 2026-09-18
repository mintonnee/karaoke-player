import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { MdClose } from 'react-icons/md'
import type { Track } from '../../../shared/types'
import { useLyricsStore } from '../stores/lyricsStore'
import LyricsSetup from './LyricsSetup'

export default function LyricsSetupDialog({ track }: { track: Track }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const dialog = useRef<HTMLDialogElement>(null)
  const plain = useLyricsStore((state) => state.plain)
  const working = useLyricsStore((state) => state.working)

  useEffect(() => {
    const element = dialog.current!
    if (open) element.showModal()
    else element.close()
    return () => element.close()
  }, [open])

  return (
    <>
      <div className="lyrics lyrics-empty">
        <p className="lyrics-note">
          {working ? '가사 작업 중…' : plain ? '동기 가사가 없습니다.' : '가사가 없습니다.'}
        </p>
        <button onClick={() => setOpen(true)}>{working ? '진행 상태 보기' : '가사 편집'}</button>
      </div>
      {createPortal(
        <dialog
          ref={dialog}
          className="lyrics-editor-dialog"
          aria-labelledby="lyrics-editor-heading"
          onKeyDown={(event) => event.stopPropagation()}
          onCancel={(event) => {
            if (event.target !== event.currentTarget) return
            event.preventDefault()
            setOpen(false)
          }}
        >
          <header className="modal-header">
            <h2 id="lyrics-editor-heading">가사 편집 · {track.title}</h2>
            <button
              type="button"
              className="icon-btn"
              aria-label="닫기"
              title="닫기"
              onClick={() => setOpen(false)}
            >
              <MdClose aria-hidden="true" />
            </button>
          </header>
          <div className="lyrics-editor-body">
            {track.guideKind === 'full_mix' && (
              <p className="lyrics-ar-warn">
                반주가 포함된 가이드여서 정렬·받아쓰기의 정확도가 낮을 수 있습니다.
              </p>
            )}
            <LyricsSetup track={track} noGuide={track.guideKind === 'none'} />
          </div>
        </dialog>,
        document.body
      )}
    </>
  )
}
