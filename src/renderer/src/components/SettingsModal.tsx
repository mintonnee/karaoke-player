import { useEffect, useState } from 'react'
import { MdClose } from 'react-icons/md'
import { DEMUCS_MODELS } from '../../../shared/types'
import type { AppSettings } from '../../../shared/types'
import notices from '../generated/third-party-notices.txt?raw'
import ShortcutList from './ShortcutList'

const REPO_URL = 'https://github.com/mintonnee/karaoke-player'

interface SettingsModalProps {
  onClose: () => void
}

/** 설정/정보 모달: 크레딧, 이슈 트래커 링크, 오픈소스 라이선스 고지 */
function SettingsModal({ onClose }: SettingsModalProps): React.JSX.Element {
  const [settings, setSettings] = useState<AppSettings | null>(null)

  useEffect(() => {
    void window.api.getSettings().then(setSettings)
  }, [])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  const changeModel = async (demucsModel: string): Promise<void> => {
    setSettings(await window.api.setSettings({ demucsModel }))
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>
            Karaoke Player <span className="app-version">v{__APP_VERSION__}</span>
          </h2>
          <button className="icon-btn" title="닫기" onClick={onClose}>
            <MdClose />
          </button>
        </div>
        <div className="modal-body">
          <section>
            <h3>분리 설정</h3>
            <label className="settings-field">
              <span>Demucs 모델</span>
              <select
                value={settings?.demucsModel ?? ''}
                disabled={!settings}
                onChange={(e) => void changeModel(e.target.value)}
              >
                {DEMUCS_MODELS.map((model) => (
                  <option key={model.id} value={model.id}>
                    {model.label}
                  </option>
                ))}
              </select>
            </label>
            <p className="settings-note">
              새로 임포트하는 곡부터 적용됩니다. 처음 쓰는 모델은 첫 분리 때 자동으로
              다운로드됩니다. 이미 분리된 곡을 새 모델로 다시 처리하려면 삭제 후 재임포트하세요.
            </p>
          </section>
          <section>
            <h3>단축키</h3>
            <ShortcutList />
          </section>
          <section>
            <h3>크레딧</h3>
            <p>
              로컬 노래방 데스크톱 앱 — Demucs 보컬 분리, 싱크 가사, 한글 발음 힌트, 키 변경. 모든
              처리는 로컬에서 수행되며 외부 업로드가 없습니다.
            </p>
            <p>만든이: mintonnee</p>
            <p>
              {/* 외부 링크는 메인의 setWindowOpenHandler가 기본 브라우저로 연다 */}
              <a href={REPO_URL} target="_blank" rel="noreferrer">
                GitHub 저장소
              </a>
              {' · '}
              <a href={`${REPO_URL}/issues`} target="_blank" rel="noreferrer">
                이슈 트래커
              </a>
            </p>
          </section>
          <section>
            <h3>오픈소스 라이선스</h3>
            <pre className="notices">{notices}</pre>
          </section>
        </div>
      </div>
    </div>
  )
}

export default SettingsModal
