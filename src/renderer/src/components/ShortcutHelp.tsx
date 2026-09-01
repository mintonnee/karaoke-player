import { useEffect } from 'react'
import { MdClose } from 'react-icons/md'
import ShortcutList from './ShortcutList'

interface ShortcutHelpProps {
  onClose: () => void
}

/** `/` 키로 토글되는 단축키 도움말 오버레이 */
function ShortcutHelp({ onClose }: ShortcutHelpProps): React.JSX.Element {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal modal-sm" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>단축키</h2>
          <button className="icon-btn" title="닫기" onClick={onClose}>
            <MdClose />
          </button>
        </div>
        <div className="modal-body">
          <ShortcutList />
        </div>
      </div>
    </div>
  )
}

export default ShortcutHelp
