import { useState } from 'react'
import { useRuntimeReady } from '../stores/bootstrapStore'
import { useLyricsStore } from '../stores/lyricsStore'
import type { AlignLang } from '../../../shared/types'

function guessLang(text: string): AlignLang {
  if (/[가-힣]/.test(text)) return 'ko'
  // 가나 외에 한자도 검사 — 한자 비중이 높은 일본어 가사가 en으로 오판되는 것을 막는다
  if (/[ぁ-んァ-ヶ一-鿿々]/.test(text)) return 'ja'
  return 'en'
}

interface LyricsSetupProps {
  trackId: string
  noGuide?: boolean
}

/** S5.2/S5.4: 동기 가사가 없을 때 — 붙여넣기(또는 전사) → 정렬 실행 */
function LyricsSetup({ trackId, noGuide = false }: LyricsSetupProps): React.JSX.Element {
  const { plain, working, progress, workError, refetch, align, transcribe } = useLyricsStore()
  const runtimeReady = useRuntimeReady()
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
        {noGuide
          ? '가이드 보컬이 없어 자동 정렬·받아쓰기를 사용할 수 없습니다. LRCLIB에서 동기 가사를 찾아보세요.'
          : !runtimeReady
            ? '런타임이 준비되면 가사 정렬·받아쓰기를 사용할 수 있습니다. LRCLIB 조회는 지금 가능합니다.'
            : '동기 가사가 없습니다. 가사를 붙여넣고 정렬하거나, LRCLIB에서 다시 찾아보세요.'}
      </p>
      {workError && <p className="lyrics-error">실패: {workError}</p>}
      <textarea
        disabled={alignDisabled}
        value={text}
        placeholder="여기에 가사를 붙여넣으세요 (한 줄 = 한 하이라이트)"
        onChange={(e) => onTextChange(e.target.value)}
        rows={8}
      />
      <div className="lyrics-setup-actions">
        <select
          disabled={alignDisabled}
          value={lang}
          onChange={(e) => setPickedLang(e.target.value as AlignLang)}
        >
          <option value="ko">한국어</option>
          <option value="ja">일본어</option>
          <option value="en">영어</option>
        </select>
        <button
          disabled={alignDisabled || !text.trim()}
          onClick={() => void align(trackId, text, lang, text === (plain ?? ''))}
        >
          정렬 실행
        </button>
        <button onClick={() => void refetch(trackId)}>LRCLIB 재조회</button>
        <button disabled={alignDisabled} onClick={() => void runTranscribe()}>
          가사가 없어요 (받아쓰기)
        </button>
      </div>
    </div>
  )
}

export default LyricsSetup
