import { useEffect, useId, useRef, useState } from 'react'
import type { DragEvent } from 'react'
import {
  MdCheckCircle,
  MdClose,
  MdInfoOutline,
  MdMusicNote,
  MdSync,
  MdWarning
} from 'react-icons/md'
import { BPM_MAX, BPM_MIN } from '../../../shared/types'
import type { Track } from '../../../shared/types'
import type { PreviewAnalysisField } from '../../../shared/previewAnalysis'
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
import {
  applyPreviewAnalysisResult,
  applyPreviewSuccess,
  areIdentityInputsLockedByPreview,
  canDismissTrackEditDuringPreview,
  emptyPreviewDraftHints,
  hintsAfterManualEdit,
  hintsAfterPreviewSuccess,
  isSaveBlockedByPreview,
  PREVIEW_ANALYSIS_HINT,
  PREVIEW_ANALYSIS_IN_FLIGHT,
  PREVIEW_BPM_BUTTON_LABEL,
  PREVIEW_KEY_BUTTON_LABEL,
  previewButtonDisableCause,
  previewButtonDisableReason,
  previewFieldStatus,
  type PreviewDraftHints,
  type PreviewInputStatus
} from '../trackEdit/preview'
import { useBootstrapStore } from '../stores/bootstrapStore'
import { useLibraryStore } from '../stores/libraryStore'
import CoverArt from './CoverArt'

interface TrackEditDialogProps {
  track: Track
  onClose: () => void
  fallbackFocus: () => void
}

const FOCUSABLE =
  'button:not([disabled]), input:not([disabled]):not([readonly]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])'

function PreviewInputStatusIcon({
  id,
  status
}: {
  id: string
  status: PreviewInputStatus | null
}): React.JSX.Element | null {
  if (!status) return null
  const Icon =
    status.kind === 'pending' ? MdSync : status.kind === 'uncertain' ? MdWarning : MdCheckCircle
  return (
    <span
      id={id}
      className={`track-edit-status-icon is-${status.kind}`}
      title={status.message}
      data-tooltip={status.message}
      aria-label={status.message}
      role="img"
      tabIndex={0}
    >
      <Icon size={16} aria-hidden="true" />
    </span>
  )
}

function droppedPaths(event: DragEvent): string[] {
  return Array.from(event.dataTransfer.files).map((file) => window.api.getPathForFile(file))
}

function TrackEditDialog({
  track,
  onClose,
  fallbackFocus
}: TrackEditDialogProps): React.JSX.Element {
  const saveTrackEdit = useLibraryStore((s) => s.saveTrackEdit)
  const bootstrap = useBootstrapStore((s) => s.state)
  const [openedTrack] = useState(track)
  const [snapshot] = useState(() => snapshotFromTrack(track))
  const [fields, setFields] = useState<TrackEditFields>(() =>
    fieldsFromSnapshot(snapshotFromTrack(track))
  )
  const [cover, setCover] = useState<CoverDraft>(keepCoverDraft)
  const [originalHasCover, setOriginalHasCover] = useState<boolean | null>(null)
  const [serverErrors, setServerErrors] = useState<TrackEditErrors>(emptyTrackEditErrors)
  const [saving, setSaving] = useState(false)
  const [notFound, setNotFound] = useState(false)
  const [previewInFlight, setPreviewInFlight] = useState<PreviewAnalysisField | null>(null)
  const [previewHints, setPreviewHints] = useState<PreviewDraftHints>(emptyPreviewDraftHints)
  const [analysisEpoch, setAnalysisEpoch] = useState(0)
  /** 연속 미리보기에서 마지막 선택만 반영 */
  const previewGen = useRef(0)
  const analysisGen = useRef(0)
  const analysisAlive = useRef(true)
  const analysisInFlightRef = useRef(false)
  const savingRef = useRef(false)
  const notFoundRef = useRef(false)
  const fieldsRef = useRef(fields)
  const hintsRef = useRef(previewHints)
  const closeRef = useRef(onClose)
  const fallbackRef = useRef(fallbackFocus)
  const panelRef = useRef<HTMLDivElement>(null)
  const titleRef = useRef<HTMLInputElement>(null)
  const titleId = useId()
  const artistId = useId()
  const bpmId = useId()
  const keyId = useId()
  const headingId = useId()
  const previewStatusId = useId()
  const fieldErrors = validateTrackEditFields(fields)
  const displayed: TrackEditErrors = {
    title: serverErrors.title ?? fieldErrors.title,
    bpm: serverErrors.bpm ?? fieldErrors.bpm,
    musicKey: serverErrors.musicKey ?? fieldErrors.musicKey,
    cover: serverErrors.cover,
    general: serverErrors.general
  }
  const previewBusy = previewInFlight !== null
  const saveBlocked = saving || notFound || isSaveBlockedByPreview(previewBusy)
  const saveReady = canSaveTrackEdit(snapshot, fields, cover) && !saveBlocked
  const previewCause = previewButtonDisableCause({
    trackStatus: openedTrack.status,
    bootstrap,
    inFlight: previewBusy,
    saving,
    notFound
  })
  const previewReason = previewButtonDisableReason(previewCause, { field: 'bpm', bootstrap })
  const identityLocked = saving || areIdentityInputsLockedByPreview(previewBusy)

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
    fieldsRef.current = fields
  }, [fields])

  useEffect(() => {
    hintsRef.current = previewHints
  }, [previewHints])

  useEffect(() => {
    notFoundRef.current = notFound
  }, [notFound])

  useEffect(() => {
    analysisAlive.current = true
    return () => {
      analysisAlive.current = false
      analysisGen.current += 1
    }
  }, [])

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
        if (canDismissTrackEditDuringPreview(savingRef.current)) closeRef.current()
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
    setPreviewHints((current) => hintsAfterManualEdit(current, patch))
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

  const requestPreview = (field: PreviewAnalysisField): void => {
    if (
      previewButtonDisableCause({
        trackStatus: openedTrack.status,
        bootstrap: useBootstrapStore.getState().state,
        inFlight: analysisInFlightRef.current,
        saving: savingRef.current,
        notFound: notFoundRef.current
      }) !== null
    ) {
      return
    }

    const gen = ++analysisGen.current
    analysisInFlightRef.current = true
    setPreviewInFlight(field)
    setServerErrors((current) => ({
      ...current,
      general: null,
      ...(field === 'bpm' ? { bpm: null } : { musicKey: null })
    }))

    const finish = (raw: unknown): void => {
      const outcome = applyPreviewAnalysisResult({
        fields: fieldsRef.current,
        hints: hintsRef.current,
        requestedField: field,
        result: raw,
        guard: {
          alive: analysisAlive.current,
          generation: analysisGen.current,
          responseGeneration: gen
        }
      })
      if (outcome.status === 'stale') return
      analysisInFlightRef.current = false
      setPreviewInFlight(null)
      if (outcome.status === 'applied') {
        setFields((current) => applyPreviewSuccess(current, outcome.result))
        setPreviewHints((current) => hintsAfterPreviewSuccess(current, outcome.result))
        setAnalysisEpoch((current) => current + 1)
        setServerErrors((current) => ({
          ...current,
          general: null,
          ...(field === 'bpm' ? { bpm: null } : { musicKey: null })
        }))
        return
      }
      setServerErrors((current) => {
        const next: TrackEditErrors = { ...current, general: null }
        next[outcome.error.target] = outcome.error.message
        return next
      })
      if (outcome.error.notFound) {
        notFoundRef.current = true
        setNotFound(true)
      }
    }

    void window.api.previewTrackAnalysis({ trackId: openedTrack.id, field }).then(
      (raw) => finish(raw),
      () => finish(null)
    )
  }

  const submit = async (): Promise<void> => {
    if (savingRef.current || analysisInFlightRef.current || !saveReady) return
    savingRef.current = true
    setSaving(true)
    setServerErrors(emptyTrackEditErrors())
    try {
      await saveTrackEdit(buildSaveRequest(openedTrack.id, snapshot, fields, cover))
      closeRef.current()
    } catch (error) {
      const classified = classifySaveError(error)
      setServerErrors(applySaveError(classified))
      if (classified.notFound) {
        notFoundRef.current = true
        setNotFound(true)
      }
      savingRef.current = false
      setSaving(false)
    }
  }

  const bpmStatus = previewFieldStatus('bpm', previewInFlight, previewHints)
  const keyStatus = previewFieldStatus('key', previewInFlight, previewHints)
  const bpmDescribedBy = [
    displayed.bpm ? `${bpmId}-error` : null,
    bpmStatus ? `${bpmId}-status` : null
  ]
    .filter((id): id is string => id !== null)
    .join(' ')
  const keyDescribedBy = [
    `${keyId}-notice`,
    displayed.musicKey ? `${keyId}-error` : null,
    keyStatus ? `${keyId}-status` : null
  ]
    .filter((id): id is string => id !== null)
    .join(' ')

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
                    trackId={openedTrack.id}
                    version={openedTrack.updatedAt}
                    className="track-edit-cover-art"
                    onAvailability={setOriginalHasCover}
                  />
                )}
              </div>
              <div className="track-edit-cover-actions">
                <button type="button" disabled={identityLocked} onClick={() => void pickCover()}>
                  {coverSelectLabel(cover, originalHasCover)}
                </button>
                <button
                  type="button"
                  disabled={identityLocked || !canRemoveCoverDraft(cover, originalHasCover)}
                  onClick={removeCover}
                >
                  커버 제거
                </button>
                {isCoverDraftChanged(cover) && (
                  <button type="button" disabled={identityLocked} onClick={revertCover}>
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
                disabled={identityLocked}
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
                disabled={identityLocked}
                onChange={(event) => setField({ artist: event.target.value })}
              />

              <div className="track-edit-bpm-key">
                <div className="track-edit-field">
                  <label htmlFor={bpmId}>BPM</label>
                  <div className="track-edit-field-row">
                    <div className="track-edit-input-wrap">
                      <input
                        key={`${bpmId}-${analysisEpoch}`}
                        id={bpmId}
                        type="number"
                        min={BPM_MIN}
                        max={BPM_MAX}
                        step={1}
                        value={fields.bpm}
                        disabled={saving}
                        readOnly={previewBusy}
                        placeholder={`${BPM_MIN}–${BPM_MAX}`}
                        title={`BPM (${BPM_MIN}–${BPM_MAX}, 비우면 값 없음)`}
                        aria-invalid={displayed.bpm !== null}
                        aria-describedby={bpmDescribedBy || undefined}
                        onChange={(event) => setField({ bpm: event.target.value })}
                      />
                      <PreviewInputStatusIcon id={`${bpmId}-status`} status={bpmStatus} />
                    </div>
                    <button
                      type="button"
                      disabled={previewCause !== null}
                      title={previewReason ?? PREVIEW_ANALYSIS_HINT}
                      onClick={() => requestPreview('bpm')}
                    >
                      {PREVIEW_BPM_BUTTON_LABEL}
                    </button>
                  </div>
                  {displayed.bpm && (
                    <p id={`${bpmId}-error`} className="track-edit-field-error" role="alert">
                      {displayed.bpm}
                    </p>
                  )}
                </div>
                <div className="track-edit-field">
                  <label htmlFor={keyId}>원키</label>
                  <div className="track-edit-field-row">
                    <div className="track-edit-input-wrap">
                      <input
                        key={`${keyId}-${analysisEpoch}`}
                        id={keyId}
                        type="text"
                        spellCheck={false}
                        value={fields.musicKey}
                        disabled={saving}
                        readOnly={previewBusy}
                        placeholder="C#m"
                        title="원키 (예: C, F#, Am, C#m. 비우면 값 없음)"
                        aria-invalid={displayed.musicKey !== null}
                        aria-describedby={keyDescribedBy}
                        onChange={(event) => setField({ musicKey: event.target.value })}
                      />
                      <PreviewInputStatusIcon id={`${keyId}-status`} status={keyStatus} />
                    </div>
                    <button
                      type="button"
                      disabled={previewCause !== null}
                      title={previewReason ?? PREVIEW_ANALYSIS_HINT}
                      onClick={() => requestPreview('key')}
                    >
                      {PREVIEW_KEY_BUTTON_LABEL}
                    </button>
                  </div>
                  {displayed.musicKey && (
                    <p id={`${keyId}-error`} className="track-edit-field-error" role="alert">
                      {displayed.musicKey}
                    </p>
                  )}
                </div>
              </div>
              <p id={previewStatusId} className="a11y-only" role="status" aria-live="polite">
                {previewBusy ? PREVIEW_ANALYSIS_IN_FLIGHT : null}
              </p>
              <aside id={`${keyId}-notice`} className="track-edit-notice" aria-label="원키 안내">
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
            <button type="submit" className="track-edit-submit" disabled={!saveReady}>
              {saving ? '저장 중…' : '저장'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

export default TrackEditDialog
