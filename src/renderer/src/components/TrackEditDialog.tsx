import { useEffect, useId, useRef, useState } from 'react'
import type { DragEvent } from 'react'
import { MdClose, MdInfoOutline, MdMusicNote } from 'react-icons/md'
import { BPM_MAX, BPM_MIN } from '../../../shared/types'
import type { Track } from '../../../shared/types'
import {
  applySaveError,
  buildSaveRequest,
  canRemoveCoverDraft,
  canSaveTrackEdit,
  classifyCoverDrop,
  classifySaveError,
  coverSelectLabel,
  emptyTrackEditErrors,
  fieldsFromSnapshot,
  isCoverDraftChanged,
  keepCoverDraft,
  removeCoverDraft,
  replaceCoverDraft,
  snapshotFromTrack,
  validateTrackEditFields,
  type CoverDraft,
  type TrackEditErrors,
  type TrackEditFields
} from '../trackEdit/form'
import { useLibraryStore } from '../stores/libraryStore'
import CoverArt from './CoverArt'

interface TrackEditDialogProps {
  track: Track
  onClose: () => void
  fallbackFocus: () => void
}

const FOCUSABLE =
  'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])'

function droppedPaths(event: DragEvent): string[] {
  return Array.from(event.dataTransfer.files).map((file) => window.api.getPathForFile(file))
}

function TrackEditDialog({
  track,
  onClose,
  fallbackFocus
}: TrackEditDialogProps): React.JSX.Element {
  const saveTrackEdit = useLibraryStore((s) => s.saveTrackEdit)
  const snapshot = snapshotFromTrack(track)
  const [fields, setFields] = useState<TrackEditFields>(() => fieldsFromSnapshot(snapshot))
  const [cover, setCover] = useState<CoverDraft>(keepCoverDraft)
  const [originalHasCover, setOriginalHasCover] = useState<boolean | null>(null)
  const [serverErrors, setServerErrors] = useState<TrackEditErrors>(emptyTrackEditErrors)
  const [saving, setSaving] = useState(false)
  const [notFound, setNotFound] = useState(false)
  /** 연속 미리보기에서 마지막 선택만 반영 */
  const previewGen = useRef(0)
  const savingRef = useRef(false)
  const closeRef = useRef(onClose)
  const fallbackRef = useRef(fallbackFocus)
  const panelRef = useRef<HTMLDivElement>(null)
  const titleRef = useRef<HTMLInputElement>(null)
  const titleId = useId()
  const artistId = useId()
  const bpmId = useId()
  const keyId = useId()
  const headingId = useId()
  const fieldErrors = validateTrackEditFields(fields)
  const displayed: TrackEditErrors = {
    title: serverErrors.title ?? fieldErrors.title,
    bpm: serverErrors.bpm ?? fieldErrors.bpm,
    musicKey: serverErrors.musicKey ?? fieldErrors.musicKey,
    cover: serverErrors.cover,
    general: serverErrors.general
  }
  const saveReady = canSaveTrackEdit(snapshot, fields, cover) && !saving && !notFound

  useEffect(() => {
    closeRef.current = onClose
  }, [onClose])

  useEffect(() => {
    fallbackRef.current = fallbackFocus
  }, [fallbackFocus])

  useEffect(() => {
    savingRef.current = saving
  }, [saving])

  useEffect(() => {
    const previouslyFocused =
      document.activeElement instanceof HTMLElement ? document.activeElement : null
    const panel = panelRef.current
    const focusables = (): HTMLElement[] =>
      panel ? Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)) : []
    titleRef.current?.focus()

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopImmediatePropagation()
        if (!savingRef.current) closeRef.current()
        return
      }
      if (event.key !== 'Tab' || !panel) return
      const items = focusables()
      if (items.length === 0) {
        event.preventDefault()
        return
      }
      const first = items[0]
      const last = items[items.length - 1]
      if (!first || !last) {
        event.preventDefault()
        return
      }
      const active = document.activeElement
      if (event.shiftKey) {
        if (active === first || !panel.contains(active)) {
          event.preventDefault()
          last.focus()
        }
      } else if (active === last || !panel.contains(active)) {
        event.preventDefault()
        first.focus()
      }
    }

    document.addEventListener('keydown', onKeyDown, true)
    return () => {
      document.removeEventListener('keydown', onKeyDown, true)
      if (previouslyFocused && document.contains(previouslyFocused)) previouslyFocused.focus()
      else fallbackRef.current()
    }
  }, [])

  const setField = (patch: Partial<TrackEditFields>): void => {
    if (savingRef.current) return
    setFields((current) => ({ ...current, ...patch }))
    setServerErrors((current) => {
      const next = { ...current }
      if (patch.title !== undefined) next.title = null
      if (patch.bpm !== undefined) next.bpm = null
      if (patch.musicKey !== undefined) next.musicKey = null
      next.general = null
      return next
    })
  }

  const applyCoverPath = (path: string): void => {
    if (savingRef.current) return
    const gen = ++previewGen.current
    setServerErrors((current) => ({ ...current, cover: null, general: null }))
    void window.api.previewCoverDetailed(path).then(
      (result) => {
        if (gen !== previewGen.current) return
        if (!result.ok) {
          setServerErrors((current) => ({ ...current, cover: result.message }))
          return
        }
        setCover(replaceCoverDraft(path, result.dataUrl))
      },
      (error) => {
        if (gen !== previewGen.current) return
        setServerErrors((current) => ({
          ...current,
          cover: error instanceof Error ? error.message : String(error)
        }))
      }
    )
  }

  const pickCover = async (): Promise<void> => {
    if (savingRef.current) return
    const picked = await window.api.pickImageFile()
    if (picked == null) return
    applyCoverPath(picked)
  }

  const revertCover = (): void => {
    if (savingRef.current) return
    previewGen.current += 1
    setCover(keepCoverDraft())
    setServerErrors((current) => ({ ...current, cover: null, general: null }))
  }

  const removeCover = (): void => {
    if (savingRef.current || !canRemoveCoverDraft(cover, originalHasCover)) return
    previewGen.current += 1
    setCover(removeCoverDraft())
    setServerErrors((current) => ({ ...current, cover: null, general: null }))
  }

  const onCoverDrop = (event: DragEvent): void => {
    event.preventDefault()
    event.stopPropagation()
    if (savingRef.current) return
    const classified = classifyCoverDrop(droppedPaths(event))
    if (classified.kind === 'empty') return
    if (classified.kind === 'error') {
      setServerErrors((current) => ({ ...current, cover: classified.message, general: null }))
      return
    }
    applyCoverPath(classified.path)
  }

  const submit = async (): Promise<void> => {
    if (savingRef.current || !saveReady) return
    savingRef.current = true
    setSaving(true)
    setServerErrors(emptyTrackEditErrors())
    try {
      await saveTrackEdit(buildSaveRequest(track.id, snapshot, fields, cover))
      closeRef.current()
    } catch (error) {
      const classified = classifySaveError(error)
      setServerErrors(applySaveError(classified))
      if (classified.notFound) setNotFound(true)
      savingRef.current = false
      setSaving(false)
    }
  }

  const blocked = saving || notFound
  const inputsLocked = saving

  return (
    <div
      className="modal-overlay"
      onDragOver={(event) => {
        event.preventDefault()
        event.stopPropagation()
      }}
      onDrop={(event) => {
        event.preventDefault()
        event.stopPropagation()
      }}
    >
      <div
        className="modal track-edit-dialog"
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={headingId}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-header">
          <h2 id={headingId}>곡 수정</h2>
          <button
            type="button"
            className="icon-btn"
            title="닫기"
            disabled={saving}
            onClick={onClose}
          >
            <MdClose />
          </button>
        </div>
        <form
          className="modal-body track-edit-body"
          onSubmit={(event) => {
            event.preventDefault()
            void submit()
          }}
        >
          <div className="track-edit-content">
            <div
              className={`track-edit-cover${displayed.cover ? ' has-error' : ''}`}
              onDragOver={(event) => {
                event.preventDefault()
                event.stopPropagation()
              }}
              onDrop={onCoverDrop}
            >
              <div className="track-edit-preview" aria-hidden="true">
                {cover.type === 'replace' ? (
                  <img src={cover.dataUrl} alt="" />
                ) : cover.type === 'remove' ? (
                  <MdMusicNote />
                ) : (
                  <CoverArt
                    trackId={track.id}
                    version={track.updatedAt}
                    className="track-edit-cover-art"
                    onAvailability={setOriginalHasCover}
                  />
                )}
              </div>
              <div className="track-edit-cover-actions">
                <button type="button" disabled={inputsLocked} onClick={() => void pickCover()}>
                  {coverSelectLabel(cover, originalHasCover)}
                </button>
                <button
                  type="button"
                  disabled={inputsLocked || !canRemoveCoverDraft(cover, originalHasCover)}
                  onClick={removeCover}
                >
                  커버 제거
                </button>
                {isCoverDraftChanged(cover) && (
                  <button type="button" disabled={inputsLocked} onClick={revertCover}>
                    변경 취소
                  </button>
                )}
              </div>
              {displayed.cover && (
                <p className="track-edit-field-error" role="alert">
                  {displayed.cover}
                </p>
              )}
            </div>

            <div className="track-edit-fields">
              <label htmlFor={titleId}>제목</label>
              <input
                id={titleId}
                ref={titleRef}
                type="text"
                spellCheck={false}
                required
                value={fields.title}
                disabled={inputsLocked}
                aria-invalid={displayed.title !== null}
                aria-describedby={displayed.title ? `${titleId}-error` : undefined}
                onChange={(event) => setField({ title: event.target.value })}
              />
              {displayed.title && (
                <p id={`${titleId}-error`} className="track-edit-field-error" role="alert">
                  {displayed.title}
                </p>
              )}

              <label htmlFor={artistId}>아티스트</label>
              <input
                id={artistId}
                type="text"
                spellCheck={false}
                value={fields.artist}
                disabled={inputsLocked}
                onChange={(event) => setField({ artist: event.target.value })}
              />

              <div className="track-edit-bpm-key">
                <div className="track-edit-field">
                  <label htmlFor={bpmId}>BPM</label>
                  <input
                    id={bpmId}
                    type="number"
                    min={BPM_MIN}
                    max={BPM_MAX}
                    step={1}
                    value={fields.bpm}
                    disabled={inputsLocked}
                    placeholder={`${BPM_MIN}–${BPM_MAX}`}
                    title={`BPM (${BPM_MIN}–${BPM_MAX}, 비우면 값 없음)`}
                    aria-invalid={displayed.bpm !== null}
                    aria-describedby={displayed.bpm ? `${bpmId}-error` : undefined}
                    onChange={(event) => setField({ bpm: event.target.value })}
                  />
                  {displayed.bpm && (
                    <p id={`${bpmId}-error`} className="track-edit-field-error" role="alert">
                      {displayed.bpm}
                    </p>
                  )}
                </div>
                <div className="track-edit-field">
                  <label htmlFor={keyId}>원키</label>
                  <input
                    id={keyId}
                    type="text"
                    spellCheck={false}
                    value={fields.musicKey}
                    disabled={inputsLocked}
                    placeholder="C#m"
                    title="원키 (예: C, F#, Am, C#m. 비우면 값 없음)"
                    aria-invalid={displayed.musicKey !== null}
                    aria-describedby={
                      displayed.musicKey ? `${keyId}-hint ${keyId}-error` : `${keyId}-hint`
                    }
                    onChange={(event) => setField({ musicKey: event.target.value })}
                  />
                  {displayed.musicKey && (
                    <p id={`${keyId}-error`} className="track-edit-field-error" role="alert">
                      {displayed.musicKey}
                    </p>
                  )}
                </div>
              </div>
              <aside id={`${keyId}-hint`} className="track-edit-notice" aria-label="원키 안내">
                <span className="track-edit-notice-icon" aria-hidden="true">
                  <MdInfoOutline />
                </span>
                <p>
                  <strong>알림</strong> 원키는 곡이 작곡된 조를 가리킵니다.
                </p>
              </aside>
            </div>
          </div>

          {displayed.general && (
            <p className="track-edit-field-error track-edit-general-error" role="alert">
              {displayed.general}
            </p>
          )}
          {notFound && (
            <p className="track-edit-hint" role="status">
              이 곡은 삭제되어 다시 저장할 수 없습니다.
            </p>
          )}

          <div className="track-edit-actions">
            <button
              type="button"
              className="track-edit-secondary"
              disabled={saving}
              onClick={onClose}
            >
              {notFound ? '닫기' : '취소'}
            </button>
            <button type="submit" className="track-edit-submit" disabled={!saveReady || blocked}>
              {saving ? '저장 중…' : '저장'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

export default TrackEditDialog
