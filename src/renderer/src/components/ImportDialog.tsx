import { useEffect, useId, useRef, useState } from 'react'
import type { DragEvent } from 'react'
import { MdClose, MdFolderOpen, MdImage } from 'react-icons/md'
import { DEMUCS_MODELS, type AppSettings } from '../../../shared/types'
import {
  applyAudioTags,
  applyDropToForm,
  applyRejections,
  applySlotDrop,
  assignUnassigned,
  canSubmit,
  clearSlot,
  emptyImportForm,
  fileNameFromPath,
  isSupportedAudioPath,
  isSupportedCoverPath,
  PAIR_STAGE_LABEL,
  setCoverPath,
  setSongArtist,
  setSongTitle,
  songMetaFromForm,
  switchImportMethod,
  type ImportFormState,
  type ImportMethod,
  type SongMetaOrigin
} from '../import/form'
import { parseImportYoutubeUrl } from '../import/youtube'
import { useLibraryStore } from '../stores/libraryStore'

interface ImportDialogProps {
  initialPaths: string[]
  onClose: () => void
}

const FOCUSABLE =
  'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])'

const METHODS: Array<{ id: ImportMethod; title: string; hint: string; urlOnly?: boolean }> = [
  { id: 'general', title: '보컬 포함 음원', hint: '스템 분리 진행' },
  { id: 'pair', title: 'MR + 가이드 보컬', hint: '가이드 선택 · 스템 분리 안 함' },
  { id: 'url', title: 'YouTube URL', hint: '스템 분리 진행', urlOnly: true }
]

function droppedPaths(event: DragEvent): string[] {
  return Array.from(event.dataTransfer.files).map((file) => window.api.getPathForFile(file))
}

function ImportDialog({ initialPaths, onClose }: ImportDialogProps): React.JSX.Element {
  const urlImportAvailable = useLibraryStore((s) => s.urlImportAvailable)
  const importing = useLibraryStore((s) => s.importing)
  const urlImporting = useLibraryStore((s) => s.urlImporting)
  const urlImportProgress = useLibraryStore((s) => s.urlImportProgress)
  const pairImporting = useLibraryStore((s) => s.pairImporting)
  const pairImportProgress = useLibraryStore((s) => s.pairImportProgress)
  const importFiles = useLibraryStore((s) => s.importFiles)
  const importPair = useLibraryStore((s) => s.importPair)
  const importUrl = useLibraryStore((s) => s.importUrl)

  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [settingsSaving, setSettingsSaving] = useState(false)
  const [settingsError, setSettingsError] = useState<string | null>(null)
  const [settingsAttempt, setSettingsAttempt] = useState(0)
  const busy = importing || urlImporting || pairImporting || settingsSaving
  const busyRef = useRef(busy)
  const [form, setForm] = useState<ImportFormState>(() =>
    applyDropToForm(emptyImportForm(), initialPaths)
  )
  const [coverPreview, setCoverPreview] = useState<{ path: string; url: string } | null>(null)
  const tagProbeGen = useRef(0)
  const panelRef = useRef<HTMLDivElement>(null)
  const closeRef = useRef(onClose)
  const typeName = useId()
  const guideKindName = useId()
  const modelInputId = useId()
  const titleInputId = useId()
  const artistInputId = useId()
  const separates = form.method === 'general' || form.method === 'url'
  const submitReady = canSubmit(form) && (!separates || settings !== null)

  const methods = METHODS.filter((method) => !method.urlOnly || urlImportAvailable)

  useEffect(() => {
    let active = true
    void window.api.getSettings().then(
      (value) => {
        if (active) {
          setSettings(value)
          setSettingsError(null)
        }
      },
      () => {
        if (active) setSettingsError('분리 설정을 불러오지 못했습니다')
      }
    )
    return () => {
      active = false
    }
  }, [settingsAttempt])

  const changeModel = async (demucsModel: string): Promise<void> => {
    if (busyRef.current) return
    busyRef.current = true
    setSettingsSaving(true)
    setSettingsError(null)
    try {
      setSettings(await window.api.setSettings({ demucsModel }))
    } catch {
      setSettingsError('설정을 저장하지 못했습니다. 기존 엔진이 유지됩니다')
    } finally {
      setSettingsSaving(false)
    }
  }

  useEffect(() => {
    busyRef.current = busy
  }, [busy])

  useEffect(() => {
    closeRef.current = onClose
  }, [onClose])

  useEffect(() => {
    const previouslyFocused =
      document.activeElement instanceof HTMLElement ? document.activeElement : null
    const panel = panelRef.current
    const focusables = (): HTMLElement[] =>
      panel ? Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)) : []
    focusables()[0]?.focus()

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopImmediatePropagation()
        if (!busyRef.current) closeRef.current()
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
      previouslyFocused?.focus()
    }
  }, [])

  const fillTagsFromFile = (path: string, source: Exclude<SongMetaOrigin, 'user'>): void => {
    if (!isSupportedAudioPath(path)) return
    const gen = ++tagProbeGen.current
    void window.api.probeAudioTags(path).then(
      (tags) => {
        if (gen !== tagProbeGen.current) return
        setForm((state) => applyAudioTags(state, tags, source))
      },
      () => undefined
    )
  }

  useEffect(() => {
    const start = applyDropToForm(emptyImportForm(), initialPaths)
    if (start.generalPath) fillTagsFromFile(start.generalPath, 'general')
    else if (start.mrPath && start.unassigned.length === 0) fillTagsFromFile(start.mrPath, 'mr')
    // 마운트 시 드롭으로 열린 파일의 태그만 채운다
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const path = form.coverPath
    if (!path) return
    let cancelled = false
    void window.api.previewCover(path).then(
      (url) => {
        if (!cancelled && url) setCoverPreview({ path, url })
      },
      () => undefined
    )
    return () => {
      cancelled = true
    }
  }, [form.coverPath])

  const selectMethod = (method: ImportMethod): void => {
    if (busy) return
    setForm((state) => switchImportMethod(state, method))
  }

  const pickCover = async (): Promise<void> => {
    if (busy) return
    const picked = await window.api.pickImageFile()
    if (picked == null) return
    setForm((state) => setCoverPath(state, picked))
  }

  const onCoverDrop = (event: DragEvent): void => {
    event.preventDefault()
    event.stopPropagation()
    if (busy) return
    const paths = droppedPaths(event).filter((path) => path !== '')
    if (paths.length !== 1 || !paths[0] || !isSupportedCoverPath(paths[0])) return
    setForm((state) => setCoverPath(state, paths[0]))
  }

  const pick = async (slot: 'general' | 'mr' | 'guide'): Promise<void> => {
    if (busy) return
    const picked = await window.api.pickAudioFile()
    if (picked == null) return
    setForm((state) => applySlotDrop(state, slot, [picked]))
    fillTagsFromFile(picked, slot)
  }

  const applyDroppedFiles = (paths: string[]): void => {
    setForm((state) => applyDropToForm(state, paths))
    const files = paths.filter((path) => path !== '')
    const only = files[0]
    if (files.length !== 1 || !only) return
    const source: Exclude<SongMetaOrigin, 'user'> =
      form.method === 'pair' && form.guideKind === 'none' ? 'mr' : 'general'
    fillTagsFromFile(only, source)
  }

  const onOverlayDrop = (event: DragEvent): void => {
    event.preventDefault()
    if (busy) return
    applyDroppedFiles(droppedPaths(event))
  }

  const onSlotDrop = (slot: 'general' | 'mr' | 'guide', event: DragEvent): void => {
    event.preventDefault()
    event.stopPropagation()
    if (busy) return
    const paths = droppedPaths(event)
    setForm((state) => applySlotDrop(state, slot, paths))
    if (paths.filter((path) => path !== '').length === 1 && paths[0]) {
      fillTagsFromFile(paths[0], slot)
    }
  }

  const submit = async (): Promise<void> => {
    if (busyRef.current || !submitReady) return
    const songMeta = songMetaFromForm(form)
    try {
      if (form.method === 'general' && form.generalPath) {
        const response = await importFiles([form.generalPath], songMeta)
        if (response.imported.length > 0) {
          onClose()
          return
        }
        setForm((state) =>
          response.rejected.length > 0
            ? applyRejections(state, response.rejected)
            : {
                ...state,
                errors: { ...state.errors, general: '가져오기에 실패했습니다' }
              }
        )
        return
      }
      if (form.method === 'pair' && form.mrPath && form.guideKind) {
        const response = await importPair({
          mrPath: form.mrPath,
          guidePath: form.guidePath,
          guideKind: form.guideKind,
          ...songMeta
        })
        if (response.imported.length > 0) {
          onClose()
          return
        }
        setForm((state) =>
          response.rejected.length > 0
            ? applyRejections(state, response.rejected)
            : {
                ...state,
                errors: { ...state.errors, pair: '가져오기에 실패했습니다' }
              }
        )
        return
      }
      if (form.method === 'url') {
        const parsed = parseImportYoutubeUrl(form.url)
        if (!parsed.ok) {
          setForm((state) => ({
            ...state,
            errors: { ...state.errors, url: parsed.reason }
          }))
          return
        }
        const response = await importUrl(parsed.href, songMeta)
        if (response.imported.length > 0) {
          onClose()
          return
        }
        setForm((state) =>
          response.rejected.length > 0
            ? applyRejections(state, response.rejected)
            : {
                ...state,
                errors: { ...state.errors, url: '가져오기에 실패했습니다' }
              }
        )
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setForm((state) => {
        const field = state.method === 'url' ? 'url' : state.method === 'pair' ? 'pair' : 'general'
        return { ...state, errors: { ...state.errors, [field]: message } }
      })
    }
  }

  const pairPct = pairImportProgress?.pct
  const pairIndeterminate = pairImporting && pairPct === undefined
  const submitLabel =
    form.method === 'pair' && pairImporting
      ? PAIR_STAGE_LABEL[pairImportProgress?.stage ?? 'queued']
      : urlImporting
        ? '다운로드 중…'
        : importing
          ? '가져오는 중…'
          : '가져오기'

  return (
    <div
      className="modal-overlay"
      onDragOver={(event) => {
        event.preventDefault()
      }}
      onDrop={onOverlayDrop}
    >
      <div
        className="modal import-dialog"
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="import-dialog-title"
        onClick={(event) => event.stopPropagation()}
        onDrop={(event) => {
          event.preventDefault()
          event.stopPropagation()
          if (busy) return
          applyDroppedFiles(droppedPaths(event))
        }}
      >
        <div className="modal-header">
          <h2 id="import-dialog-title">가져오기</h2>
          <button type="button" className="icon-btn" title="닫기" disabled={busy} onClick={onClose}>
            <MdClose />
          </button>
        </div>
        <form
          className="modal-body import-dialog-body"
          onSubmit={(event) => {
            event.preventDefault()
            void submit()
          }}
        >
          <fieldset className="import-type" aria-label="가져오기 유형">
            <div className="import-methods">
              {methods.map((method) => (
                <label
                  key={method.id}
                  className={`import-method${form.method === method.id ? ' selected' : ''}`}
                >
                  <input
                    type="radio"
                    name={typeName}
                    value={method.id}
                    checked={form.method === method.id}
                    disabled={busy}
                    onChange={() => selectMethod(method.id)}
                  />
                  <span>
                    <span className="import-method-title">{method.title}</span>
                    <span className="import-method-hint">{method.hint}</span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>

          <div className="import-detail">
            {form.errors.count && (
              <p className="import-error" role="alert">
                {form.errors.count}
              </p>
            )}

            {form.method === 'general' && (
              <FileSlot
                label="음원 파일"
                path={form.generalPath}
                error={form.errors.general}
                disabled={busy}
                onPick={() => void pick('general')}
                onClear={() => setForm((state) => clearSlot(state, 'general'))}
                onDrop={(event) => onSlotDrop('general', event)}
              />
            )}

            {form.method === 'pair' && (
              <div className="import-pair">
                <FileSlot
                  label="MR (반주)"
                  path={form.mrPath}
                  error={form.errors.mr}
                  disabled={busy}
                  onPick={() => void pick('mr')}
                  onClear={() => setForm((state) => clearSlot(state, 'mr'))}
                  onDrop={(event) => onSlotDrop('mr', event)}
                />
                {form.guideKind !== 'none' && (
                  <FileSlot
                    label="가이드 보컬 파일"
                    path={form.guidePath}
                    error={form.errors.guide}
                    disabled={busy}
                    onPick={() => void pick('guide')}
                    onClear={() => setForm((state) => clearSlot(state, 'guide'))}
                    onDrop={(event) => onSlotDrop('guide', event)}
                  />
                )}

                {form.unassigned.length > 0 && (
                  <div className="import-unassigned">
                    <p className="import-unassigned-title">미지정 파일</p>
                    <ul>
                      {form.unassigned.map((path) => (
                        <li key={path}>
                          <span title={path}>{fileNameFromPath(path)}</span>
                          <span className="import-unassigned-actions">
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => {
                                setForm((state) => assignUnassigned(state, path, 'mr'))
                                fillTagsFromFile(path, 'mr')
                              }}
                            >
                              MR로
                            </button>
                            <button
                              type="button"
                              disabled={busy || form.guideKind === 'none'}
                              onClick={() => {
                                setForm((state) => assignUnassigned(state, path, 'guide'))
                                fillTagsFromFile(path, 'guide')
                              }}
                            >
                              가이드로
                            </button>
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                <fieldset className="import-guide-kind" disabled={busy}>
                  <legend>가이드 종류</legend>
                  <label>
                    <input
                      type="radio"
                      name={guideKindName}
                      checked={form.guideKind === 'vocal_only'}
                      onChange={() => setForm((state) => ({ ...state, guideKind: 'vocal_only' }))}
                    />
                    <span>
                      보컬만 있는 파일
                      <span className="import-method-hint">MR과 함께 재생</span>
                    </span>
                  </label>
                  <label>
                    <input
                      type="radio"
                      name={guideKindName}
                      checked={form.guideKind === 'none'}
                      onChange={() =>
                        setForm((state) => ({
                          ...state,
                          guideKind: 'none',
                          guidePath: null,
                          errors: { ...state.errors, guide: null, pair: null }
                        }))
                      }
                    />
                    <span>
                      가이드 보컬 없음
                      <span className="import-method-hint">MR 파일 하나만 가져오기</span>
                    </span>
                  </label>
                </fieldset>

                <aside className="import-notice" aria-label="MR 가져오기 주의사항">
                  <p>
                    <strong>주의사항</strong> 가이드 보컬이 없으면 자동 가사 정렬·받아쓰기를 사용할
                    수 없습니다.
                  </p>
                  <p>
                    MR·보컬의 편집본과 시작 시각을 맞춰주세요. 정렬 품질은 보컬 상태에 따라
                    달라집니다.
                  </p>
                </aside>
                {form.errors.pair && (
                  <p className="import-error" role="alert">
                    {form.errors.pair}
                  </p>
                )}
              </div>
            )}

            {form.method === 'url' && urlImportAvailable && (
              <div className="import-url">
                <label className="import-url-label" htmlFor="import-youtube-url">
                  YouTube URL
                </label>
                <input
                  id="import-youtube-url"
                  className="import-url-input"
                  type="text"
                  spellCheck={false}
                  placeholder="https://www.youtube.com/watch?v=…"
                  value={form.url}
                  disabled={busy}
                  onChange={(event) =>
                    setForm((state) => ({
                      ...state,
                      url: event.target.value,
                      errors: { ...state.errors, url: null }
                    }))
                  }
                />
                {form.errors.url && (
                  <p className="import-error" role="alert">
                    {form.errors.url}
                  </p>
                )}
              </div>
            )}

            <div className="import-song-meta">
              <p className="import-song-meta-head">곡 정보 (선택)</p>
              <label htmlFor={titleInputId}>제목</label>
              <input
                id={titleInputId}
                type="text"
                spellCheck={false}
                placeholder="파일 태그 또는 파일명"
                value={form.title}
                disabled={busy}
                onChange={(event) => setForm((state) => setSongTitle(state, event.target.value))}
              />
              <label htmlFor={artistInputId}>아티스트</label>
              <input
                id={artistInputId}
                type="text"
                spellCheck={false}
                placeholder="파일 태그"
                value={form.artist}
                disabled={busy}
                onChange={(event) => setForm((state) => setSongArtist(state, event.target.value))}
              />
              <span className="import-cover-label">커버</span>
              <div
                className="import-cover"
                onDragOver={(event) => {
                  event.preventDefault()
                  event.stopPropagation()
                }}
                onDrop={onCoverDrop}
              >
                <div className="import-cover-thumb" aria-hidden="true">
                  {coverPreview?.path === form.coverPath ? (
                    <img src={coverPreview.url} alt="" />
                  ) : (
                    <MdImage />
                  )}
                </div>
                {form.coverPath ? (
                  <div className="import-cover-file">
                    <span className="import-slot-name" title={form.coverPath}>
                      {fileNameFromPath(form.coverPath)}
                    </span>
                    <button type="button" disabled={busy} onClick={() => void pickCover()}>
                      바꾸기
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => setForm((state) => setCoverPath(state, null))}
                    >
                      제거
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    className="import-slot-pick"
                    disabled={busy}
                    onClick={() => void pickCover()}
                  >
                    <MdFolderOpen /> 이미지 선택
                  </button>
                )}
              </div>
            </div>

            {separates && (
              <div className="import-separation">
                <label htmlFor={modelInputId}>분리 엔진</label>
                <select
                  id={modelInputId}
                  value={settings?.demucsModel ?? ''}
                  disabled={busy || !settings}
                  onChange={(event) => void changeModel(event.target.value)}
                >
                  {!settings && <option value="">설정 불러오는 중…</option>}
                  {settings &&
                    !DEMUCS_MODELS.some((model) => model.id === settings.demucsModel) && (
                      <option value={settings.demucsModel}>
                        {settings.demucsModel} (현재 설정)
                      </option>
                    )}
                  {DEMUCS_MODELS.map((model) => (
                    <option key={model.id} value={model.id}>
                      {model.label}
                    </option>
                  ))}
                </select>
                <p className="import-hint">
                  설정창과 공유되며 대기 중인 분리 작업에도 적용됩니다. 처음 쓰는 모델은 자동
                  다운로드됩니다.
                </p>
                {settingsError && (
                  <p className="import-error" role="alert">
                    {settingsError}
                  </p>
                )}
                {!settings && settingsError && (
                  <button
                    type="button"
                    className="import-secondary"
                    onClick={() => {
                      setSettingsError(null)
                      setSettingsAttempt((value) => value + 1)
                    }}
                  >
                    다시 불러오기
                  </button>
                )}
              </div>
            )}

            {pairImporting && (
              <div className="import-progress" aria-live="polite">
                {pairIndeterminate ? (
                  <div className="import-progress-indet">
                    <span />
                  </div>
                ) : (
                  <div className="progress">
                    <div className="progress-fill" style={{ width: `${pairPct ?? 0}%` }} />
                    <span className="progress-label">{Math.round(pairPct ?? 0)}%</span>
                  </div>
                )}
                <span className="import-progress-msg">
                  {PAIR_STAGE_LABEL[pairImportProgress?.stage ?? 'queued']}
                  {pairImportProgress?.msg ? ` — ${pairImportProgress.msg}` : ''}
                </span>
              </div>
            )}

            {urlImporting && (
              <div className="import-progress" aria-live="polite">
                <div className="progress">
                  <div
                    className="progress-fill"
                    style={{ width: `${urlImportProgress?.pct ?? 0}%` }}
                  />
                  <span className="progress-label">{Math.round(urlImportProgress?.pct ?? 0)}%</span>
                </div>
                <span className="import-progress-msg">
                  {urlImportProgress?.msg ?? '다운로드 준비 중…'}
                </span>
              </div>
            )}
          </div>

          <div className="import-actions">
            <button type="button" className="import-secondary" disabled={busy} onClick={onClose}>
              닫기
            </button>
            <button type="submit" className="import-submit" disabled={busy || !submitReady}>
              {submitLabel}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

interface FileSlotProps {
  label: string
  path: string | null
  error: string | null
  disabled: boolean
  onPick: () => void
  onClear: () => void
  onDrop: (event: DragEvent) => void
}

function FileSlot({
  label,
  path,
  error,
  disabled,
  onPick,
  onClear,
  onDrop
}: FileSlotProps): React.JSX.Element {
  const [over, setOver] = useState(false)

  return (
    <div
      className={`import-slot${over ? ' drag-over' : ''}${error ? ' has-error' : ''}`}
      onDragOver={(event) => {
        event.preventDefault()
        event.stopPropagation()
        if (!disabled) setOver(true)
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(event) => {
        setOver(false)
        onDrop(event)
      }}
    >
      <div className="import-slot-head">{label}</div>
      {path ? (
        <div className="import-slot-file">
          <span className="import-slot-name" title={path}>
            {fileNameFromPath(path)}
          </span>
          <button type="button" disabled={disabled} onClick={onPick}>
            바꾸기
          </button>
          <button type="button" disabled={disabled} onClick={onClear}>
            제거
          </button>
        </div>
      ) : (
        <button type="button" className="import-slot-pick" disabled={disabled} onClick={onPick}>
          <MdFolderOpen /> 파일 선택
        </button>
      )}
      {error && (
        <p className="import-error" role="alert">
          {error}
        </p>
      )}
    </div>
  )
}

export default ImportDialog
