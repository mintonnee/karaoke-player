import { useState } from 'react'
import { useLyricsStore } from '../stores/lyricsStore'
import type { AlignLang } from '../../../shared/types'

function guessLang(text: string): AlignLang {
  if (/[가-힣]/.test(text)) return 'ko'
  if (/[ぁ-んァ-ヶ]/.test(text)) return 'ja'
  return 'en'
}

interface LyricsSetupProps {
  trackId: string
}

/** S5.2/S5.4: 동기 가사가 없을 때 — 붙여넣기(또는 전사) → 정렬 실행 */
function LyricsSetup({ trackId }: LyricsSetupProps): React.JSX.Element {
  const { plain, working, progress, workError, refetch, align, transcribe } = useLyricsStore()
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
      <p className="lyrics-note">
        동기 가사가 없습니다. 가사를 붙여넣고 정렬하거나, LRCLIB에서 다시 찾아보세요.
      </p>
      {workError && <p className="lyrics-error">실패: {workError}</p>}
      <textarea
        value={text}
        placeholder="여기에 가사를 붙여넣으세요 (한 줄 = 한 하이라이트)"
        onChange={(e) => onTextChange(e.target.value)}
        rows={8}
      />
      <div className="lyrics-setup-actions">
        <select value={lang} onChange={(e) => setPickedLang(e.target.value as AlignLang)}>
          <option value="ko">한국어</option>
          <option value="ja">일본어</option>
          <option value="en">영어</option>
        </select>
        <button
          disabled={!text.trim()}
          onClick={() => void align(trackId, text, lang, text === (plain ?? ''))}
        >
          정렬 실행
        </button>
        <button onClick={() => void refetch(trackId)}>LRCLIB 재조회</button>
        <button onClick={() => void runTranscribe()}>가사가 없어요 (받아쓰기)</button>
      </div>
    </div>
  )
}

export default LyricsSetup
