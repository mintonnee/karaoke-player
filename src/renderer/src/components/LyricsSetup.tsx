import { useState } from 'react'
import { isRuntimeActionAllowed } from '../../../shared/bootstrap'
import { useBootstrapStore } from '../stores/bootstrapStore'
import { useLyricsStore } from '../stores/lyricsStore'
import type { AlignLang, Track } from '../../../shared/types'
import LrclibSearchDialog from './LrclibSearchDialog'

function guessLang(text: string): AlignLang {
  if (/[가-힣]/.test(text)) return 'ko'
  // 가나 외에 한자도 검사 — 한자 비중이 높은 일본어 가사가 en으로 오판되는 것을 막는다
  if (/[ぁ-んァ-ヶ一-鿿々]/.test(text)) return 'ja'
  return 'en'
}

interface LyricsSetupProps {
  track: Track
  noGuide?: boolean
}

/** S5.2/S5.4: 동기 가사가 없을 때 — 붙여넣기(또는 전사) → 정렬 실행 */
function LyricsSetup({ track, noGuide = false }: LyricsSetupProps): React.JSX.Element {
  const trackId = track.id
  const { plain, working, progress, workError, applySelection, align, transcribe } =
    useLyricsStore()
  const [searchOpen, setSearchOpen] = useState(false)
  const [browserError, setBrowserError] = useState<string | null>(null)
  const bootstrap = useBootstrapStore((s) => s.state)
  const runtimeReady = isRuntimeActionAllowed(bootstrap)
  const runtimeBlockedMessage =
    bootstrap?.status === 'error'
      ? '실행 환경 준비 실패 · 알림에서 확인'
      : '환경 준비 중 · 알림에서 확인'
  const alignDisabled = noGuide || !runtimeReady
  // 사용자가 건드리기 전에는 저장된 plain 가사를 따라간다 (로드 완료 시 자동 반영)
  const [editedText, setEditedText] = useState<string | null>(null)
  const [pickedLang, setPickedLang] = useState<AlignLang | null>(null)
  const text = editedText ?? plain ?? ''
  const lang = pickedLang ?? guessLang(text)

  const onTextChange = (value: string): void => setEditedText(value)

  const runTranscribe = async (): Promise<void> => {
    const transcript = await transcribe(trackId)
    if (transcript) onTextChange(transcript)
  }

  const searchGoogle = async (): Promise<void> => {
    setBrowserError(null)
    try {
      const params = new URLSearchParams({ q: `${track.title} lyrics` })
      await window.api.openExternal(`https://www.google.com/search?${params}`)
    } catch (error) {
      setBrowserError(`브라우저를 열지 못했습니다: ${String(error)}`)
    }
  }

  if (working) {
    return (
      <div className="lyrics lyrics-empty">
        <p className="lyrics-note">
          {working === 'align' ? '가사 정렬 중…' : '보컬 받아쓰는 중…'}{' '}
          {progress ? `${progress.pct}%` : ''}
        </p>
        <div className="progress lyrics-work-progress">
          <div className="progress-fill" style={{ width: `${progress?.pct ?? 0}%` }} />
        </div>
      </div>
    )
  }

  return (
    <div className="lyrics lyrics-empty lyrics-setup">
      <button className="lyrics-setup-primary" onClick={() => setSearchOpen(true)}>
        LRCLIB에서 찾기
      </button>
      <section className="lyrics-setup-section">
        <h3>가사 붙여넣고 정렬</h3>
        <p className="lyrics-note">
          {noGuide
            ? '가이드 보컬이 없어 자동 정렬·받아쓰기를 사용할 수 없습니다. LRCLIB에서 동기 가사를 찾아보세요.'
            : !runtimeReady
              ? `${runtimeBlockedMessage}. LRCLIB 조회는 지금 가능합니다.`
              : '가사를 붙여넣고 재생 시간에 맞춰 정렬하세요.'}
        </p>
        {workError && <p className="lyrics-error">실패: {workError}</p>}
        {browserError && (
          <p className="lyrics-error" role="alert">
            {browserError}
          </p>
        )}
        <div className="lyrics-setup-toolbar">
          <div className="lyrics-setup-toolbar-group">
            <button type="button" onClick={() => void searchGoogle()}>
              가사 구글 검색
            </button>
            <button type="button" disabled={alignDisabled} onClick={() => void runTranscribe()}>
              보컬 듣고 받아쓰기
            </button>
          </div>
          <div className="lyrics-setup-toolbar-group lyrics-setup-lang">
            <label className="lyrics-setup-lang-label">
              <span>언어</span>
              <select
                aria-label="가사 언어"
                disabled={alignDisabled}
                value={lang}
                onChange={(e) => setPickedLang(e.target.value as AlignLang)}
              >
                <option value="ko">한국어</option>
                <option value="ja">일본어</option>
                <option value="en">영어</option>
              </select>
            </label>
          </div>
        </div>
        <textarea
          aria-label="정렬할 가사"
          disabled={alignDisabled}
          value={text}
          placeholder="여기에 가사를 붙여넣으세요 (한 줄 = 한 하이라이트)"
          onChange={(e) => onTextChange(e.target.value)}
          rows={8}
        />
        <div className="lyrics-setup-actions">
          <button
            type="button"
            className="lyrics-setup-align-btn"
            disabled={alignDisabled || !text.trim()}
            onClick={() => void align(trackId, text, lang, text === (plain ?? ''))}
          >
            가사 정렬 실행
          </button>
        </div>
      </section>
      {searchOpen && (
        <LrclibSearchDialog
          track={track}
          onClose={() => setSearchOpen(false)}
          onApply={(payload) => {
            setEditedText(null)
            setPickedLang(null)
            applySelection(payload)
          }}
        />
      )}
    </div>
  )
}

export default LyricsSetup
