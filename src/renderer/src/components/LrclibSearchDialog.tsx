import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { LrclibRecord } from '../../../shared/lrclib'
import type { LyricsPayload, Track } from '../../../shared/types'

interface Props {
  track: Track
  onClose: () => void
  onApply: (payload: LyricsPayload) => void
}

export default function LrclibSearchDialog({ track, onClose, onApply }: Props): React.JSX.Element {
  const [query, setQuery] = useState(() => [track.title, track.artist].filter(Boolean).join(' '))
  const [submitted, setSubmitted] = useState(query)
  const [attempt, setAttempt] = useState(0)
  const [results, setResults] = useState<LrclibRecord[]>([])
  const [selected, setSelected] = useState<LrclibRecord | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const dialog = useRef<HTMLDialogElement>(null)
  const alive = useRef(false)
  const savingRef = useRef(false)

  useEffect(() => {
    alive.current = true
    const element = dialog.current!
    element.showModal()
    return () => {
      alive.current = false
      element.close()
    }
  }, [])

  useEffect(() => {
    let current = true
    window.api.searchLyrics(submitted).then(
      (records) => {
        if (!current) return
        setResults(records)
        setLoading(false)
      },
      (reason: unknown) => {
        if (!current) return
        setError(String(reason))
        setLoading(false)
      }
    )
    return () => {
      current = false
    }
  }, [submitted, attempt])

  const apply = async (): Promise<void> => {
    if (!selected || savingRef.current) return
    savingRef.current = true
    setSaving(true)
    setError(null)
    try {
      const payload = await window.api.selectLyrics(track.id, selected.id)
      if (!alive.current) return
      onApply(payload)
      onClose()
    } catch (reason) {
      if (alive.current) setError(String(reason))
    } finally {
      savingRef.current = false
      if (alive.current) setSaving(false)
    }
  }

  return createPortal(
    <dialog
      ref={dialog}
      className="lrclib-dialog"
      aria-labelledby="lrclib-heading"
      onKeyDown={(event) => event.stopPropagation()}
      onCancel={(event) => {
        event.preventDefault()
        if (!savingRef.current) onClose()
      }}
    >
      <header className="modal-header">
        <h2 id="lrclib-heading">LRCLIB에서 찾기</h2>
        <button type="button" disabled={saving} onClick={onClose}>
          닫기
        </button>
      </header>
      <div className="lrclib-body">
        <div className="lrclib-search-panel">
          <form
            className="lrclib-search"
            onSubmit={(event) => {
              event.preventDefault()
              if (!query.trim() || saving) return
              setLoading(true)
              setError(null)
              setResults([])
              setSelected(null)
              setSubmitted(query.trim())
              setAttempt((value) => value + 1)
            }}
          >
            <input
              aria-label="LRCLIB 검색어"
              value={query}
              disabled={saving}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="노래 제목, 아티스트"
            />
            <button disabled={saving || !query.trim()}>검색</button>
          </form>
          <p className="lyrics-note">검색 결과를 선택해 가사를 확인한 뒤 적용하세요.</p>
          {error && (
            <p className="lyrics-error" role="alert">
              {error}
            </p>
          )}
          <p role="status">
            {loading
              ? '검색 중…'
              : error
                ? ''
                : results.length
                  ? `${results.length}개 결과`
                  : '검색 결과가 없습니다. 검색어를 바꿔보세요.'}
          </p>
          <ul className="lrclib-results" aria-label="가사 검색 결과">
            {results.map((record) => {
              const usable =
                !record.instrumental &&
                Boolean(record.syncedLyrics?.trim() || record.plainLyrics?.trim())
              return (
                <li key={record.id}>
                  <button
                    type="button"
                    disabled={saving || !usable}
                    aria-pressed={selected?.id === record.id}
                    onClick={() => setSelected(record)}
                  >
                    <strong>{record.trackName}</strong>
                    <span>
                      {record.artistName || '아티스트 미상'} · {record.albumName || '앨범 미상'} ·{' '}
                      {Math.floor(record.duration / 60)}:
                      {String(Math.floor(record.duration % 60)).padStart(2, '0')}
                    </span>
                    <span>
                      {record.instrumental
                        ? '연주곡'
                        : record.syncedLyrics
                          ? '동기 가사'
                          : record.plainLyrics
                            ? '일반 가사 · 정렬 필요'
                            : '가사 없음'}
                    </span>
                  </button>
                </li>
              )
            })}
          </ul>
        </div>
        <section
          key={selected?.id ?? 'empty'}
          className={`lrclib-preview${selected ? '' : ' lrclib-preview-empty'}`}
          aria-label="가사 프리뷰"
        >
          {selected ? (
            <>
              <h3>{selected.trackName}</h3>
              <pre>{selected.syncedLyrics || selected.plainLyrics}</pre>
              {!selected.syncedLyrics && <p>일반 가사를 정렬 입력란에 넣습니다.</p>}
            </>
          ) : (
            <p>가사 프리뷰</p>
          )}
        </section>
      </div>
      <footer className="lrclib-footer">
        <button disabled={!selected || saving || loading} onClick={() => void apply()}>
          {saving ? '적용 중…' : '선택한 가사 적용'}
        </button>
      </footer>
    </dialog>,
    document.body
  )
}
