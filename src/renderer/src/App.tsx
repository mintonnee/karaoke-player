import { useEffect, useRef, useState } from 'react'
import type { DragEvent } from 'react'
import {
  MdAutorenew,
  MdCheckCircle,
  MdDeleteOutline,
  MdDragIndicator,
  MdEdit,
  MdErrorOutline,
  MdHelpOutline,
  MdNotificationsNone,
  MdSchedule,
  MdSettings
} from 'react-icons/md'
import BootstrapScreen from './components/BootstrapScreen'
import CoverArt from './components/CoverArt'
import ErrorCenter from './components/ErrorCenter'
import ImportDialog from './components/ImportDialog'
import KeyPanel from './components/KeyPanel'
import LyricsView from './components/LyricsView'
import MixerPanel from './components/MixerPanel'
import SettingsModal from './components/SettingsModal'
import ShortcutHelp from './components/ShortcutHelp'
import TrackEditDialog from './components/TrackEditDialog'
import Transport from './components/Transport'
import { useErrorStore } from './stores/errorStore'
import { useLibraryStore } from './stores/libraryStore'
import { useLyricsStore } from './stores/lyricsStore'
import { usePlayerStore } from './stores/playerStore'
import { formatBpmDisplay } from '../../shared/analysisFormat'
import { formatKeyDisplay } from '../../shared/musicKey'
import type { BootstrapState, Track } from '../../shared/types'

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${m}:${String(s).padStart(2, '0')}`
}

const STATUS_LABEL: Record<Track['status'], string> = {
  imported: '대기 중',
  separating: '분리 중',
  ready: '준비됨',
  failed: '실패'
}

const STATUS_ICON: Record<Track['status'], React.JSX.Element> = {
  imported: <MdSchedule />,
  separating: <MdAutorenew />,
  ready: <MdCheckCircle />,
  failed: <MdErrorOutline />
}

/** 행 드래그 정렬 핸들러 (네이티브 DnD). 파일 드롭과 구분하기 위해 전용 MIME 타입을 쓴다 */
interface RowReorderHandlers {
  onDragStart: (event: DragEvent) => void
  onDragOver: (event: DragEvent) => void
  onDrop: (event: DragEvent) => void
  onDragEnd: () => void
}

const ROW_DRAG_MIME = 'application/x-karaoke-track'

interface TrackRowProps {
  track: Track
  /** 목록 순번 (1부터) */
  index: number
  progressPct: number | undefined
  isCurrent: boolean
  /** 현재 곡이면서 재생 중 — 순번 자리에 이퀄라이저 애니메이션 */
  isPlaying: boolean
  /** 드래그 정렬 핸들러. 검색 필터 중에는 null (부분 목록의 순서는 저장할 수 없다) */
  reorder: RowReorderHandlers | null
  /** 드래그 중인 행 자신 */
  dragging: boolean
  /** 드롭 위치 안내선: 이 행의 위/아래 */
  dropHint: 'before' | 'after' | null
  onLoad: () => void
  onDelete: () => void
  onEdit: (opener: HTMLButtonElement) => void
}

function TrackRow({
  track,
  index,
  progressPct,
  isCurrent,
  isPlaying,
  reorder,
  dragging,
  dropHint,
  onLoad,
  onDelete,
  onEdit
}: TrackRowProps): React.JSX.Element {
  const playable = track.status === 'ready'
  const bpmText = formatBpmDisplay(track.bpm, track.bpmConf)
  const keyText = formatKeyDisplay(track.musicKey)

  return (
    <li
      className={`track-item${playable ? ' playable' : ''}${isCurrent ? ' current' : ''}${
        dragging ? ' dragging' : ''
      }${dropHint ? ` drop-${dropHint}` : ''}`}
      onClick={playable ? onLoad : undefined}
      onDragOver={reorder?.onDragOver}
      onDrop={reorder?.onDrop}
    >
      <div className="track-main">
        {/* 드래그 핸들: 여기서만 끌 수 있다 (행 클릭=재생과 충돌 방지). 검색 중에는 없다 */}
        <span
          className={`track-drag-handle${reorder ? '' : ' hidden-slot'}`}
          title={reorder ? '끌어서 순서 변경' : undefined}
          draggable={reorder !== null}
          onDragStart={reorder?.onDragStart}
          onDragEnd={reorder?.onDragEnd}
          onClick={(e) => e.stopPropagation()}
          aria-hidden={reorder === null}
        >
          <MdDragIndicator />
        </span>
        {/* 순번 칸: 재생 중이면 이퀄라이저 바, 현재 곡(일시정지)은 강조색 번호 */}
        <span className="track-index" aria-label={isPlaying ? '재생 중' : undefined}>
          {isPlaying ? (
            <span className="track-eq" aria-hidden="true">
              <i />
              <i />
              <i />
            </span>
          ) : (
            index
          )}
        </span>
        <CoverArt trackId={track.id} version={track.updatedAt} className="track-cover" />
        <div className="track-info">
          <span className="track-title">{track.title}</span>
          <span className="track-meta">
            {track.artist ?? '(아티스트 없음)'} · {formatDuration(track.duration)}
            {bpmText !== null && ` · ${bpmText}`}
            {keyText !== null && ` · ${keyText}`}
          </span>
        </div>
      </div>
      <div className="track-side" onClick={(e) => e.stopPropagation()}>
        {track.status === 'separating' ? (
          <div className="progress">
            <div className="progress-fill" style={{ width: `${progressPct ?? 0}%` }} />
            <span className="progress-label">{progressPct ?? 0}%</span>
          </div>
        ) : (
          <span
            className={`track-status status-${track.status}`}
            title={STATUS_LABEL[track.status]}
          >
            {STATUS_ICON[track.status]}
          </span>
        )}
        <button
          className="icon-btn"
          title="편집"
          onClick={(event) => {
            event.stopPropagation()
            onEdit(event.currentTarget)
          }}
        >
          <MdEdit />
        </button>
        <button
          className="icon-btn danger"
          disabled={track.status === 'separating'}
          onClick={onDelete}
          title={track.status === 'separating' ? '분리 중에는 삭제할 수 없습니다' : '삭제'}
        >
          <MdDeleteOutline />
        </button>
      </div>
    </li>
  )
}

function App(): React.JSX.Element {
  const {
    tracks,
    progress,
    rejections,
    importing,
    urlImporting,
    pairImporting,
    search,
    refresh,
    setSearch,
    loadCapabilities,
    deleteTrack,
    reorderTracks,
    dismissRejections
  } = useLibraryStore()
  const loadTrack = usePlayerStore((s) => s.loadTrack)
  const unload = usePlayerStore((s) => s.unload)
  const currentTrackId = usePlayerStore((s) => s.track?.id)
  const isPlaying = usePlayerStore((s) => s.engineState === 'playing')
  const loadLyrics = useLyricsStore((s) => s.load)
  const clearLyrics = useLyricsStore((s) => s.clear)
  const [dragOver, setDragOver] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [showHelp, setShowHelp] = useState(false)
  const [showErrors, setShowErrors] = useState(false)
  const unseenErrors = useErrorStore((s) => s.entries.filter((e) => !e.seen).length)
  const markErrorsSeen = useErrorStore((s) => s.markAllSeen)
  const [showImport, setShowImport] = useState(false)
  const [importDropPaths, setImportDropPaths] = useState<string[]>([])
  const [editingTrack, setEditingTrack] = useState<Track | null>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const trackListRef = useRef<HTMLUListElement>(null)
  const modalOpen = showSettings || showImport || editingTrack !== null
  // null = 아직 조회 전. ready가 아니면 라이브러리 대신 부트스트랩 화면 (스펙 001 §4.1)
  const [bootstrap, setBootstrap] = useState<BootstrapState | null>(null)
  const importBusy = importing || urlImporting || pairImporting

  useEffect(() => {
    // 구독을 먼저 걸어 조회와 이벤트 사이의 상태 변화를 놓치지 않는다
    const unsubscribe = window.api.onBootstrapState(setBootstrap)
    void window.api.getBootstrapState().then(setBootstrap)
    return unsubscribe
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  // yt-dlp 동봉 여부는 실행 중 바뀌지 않으므로 1회만 조회한다 (스펙 001 §4.3)
  useEffect(() => {
    void loadCapabilities()
  }, [loadCapabilities])

  // 재생 단축키: Space 재생/일시정지, ←/→ 시크, ↑/↓(+Ctrl/Alt) 음량, −/= 키, M/V/L, / 도움말
  useEffect(() => {
    const clampDb = (db: number): number => Math.max(-60, Math.min(0, db))

    const onKeyDown = (event: KeyboardEvent): void => {
      if (showSettings || showImport || editingTrack) return
      if (event.metaKey) return
      const target = event.target as HTMLElement
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement ||
        target.isContentEditable
      ) {
        return
      }

      // 도움말 토글은 트랙이 없어도 동작
      if (event.code === 'Slash' && !event.ctrlKey && !event.altKey) {
        event.preventDefault()
        setShowHelp((visible) => !visible)
        return
      }

      const player = usePlayerStore.getState()
      const active =
        player.track !== null && player.engineState !== 'idle' && player.engineState !== 'loading'
      if (!active) return

      // 음량: ↑/↓ 메인, Ctrl+↑/↓ 반주, Alt+↑/↓ 보컬 (2 dB 스텝)
      if (event.code === 'ArrowUp' || event.code === 'ArrowDown') {
        event.preventDefault()
        const delta = event.code === 'ArrowUp' ? 2 : -2
        if (event.ctrlKey) player.setInstDb(clampDb(player.instDb + delta))
        else if (event.altKey) player.setVocalDb(clampDb(player.vocalDb + delta))
        else player.setMasterDb(player.masterDb + delta)
        return
      }
      if (event.ctrlKey || event.altKey) return

      switch (event.code) {
        case 'Space':
          // 보정 모드의 탭(Space)과 포커스된 버튼의 네이티브 활성화가 우선
          if (useLyricsStore.getState().correcting) return
          if (target instanceof HTMLButtonElement) return
          event.preventDefault()
          if (player.engineState === 'playing') player.pause()
          else player.play()
          break
        case 'ArrowLeft':
          event.preventDefault()
          player.seek(Math.max(0, player.position - 5))
          break
        case 'ArrowRight':
          event.preventDefault()
          player.seek(Math.min(player.duration, player.position + 5))
          break
        case 'Minus':
          player.setPitch(player.pitch - 1)
          break
        case 'Equal':
          player.setPitch(player.pitch + 1)
          break
        case 'KeyM':
          player.toggleMasterMute()
          break
        case 'KeyV':
          player.toggleVocalMute()
          break
        case 'KeyL':
          player.cycleLoopAB()
          break
        case 'KeyR':
          // 처음으로: 재생 상태는 유지한 채 0초로
          player.seek(0)
          break
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [showSettings, showImport, editingTrack])

  useEffect(() => {
    if (currentTrackId) void loadLyrics(currentTrackId)
    else clearLyrics()
  }, [currentTrackId, loadLyrics, clearLyrics])

  const onDrop = (event: DragEvent): void => {
    event.preventDefault()
    setDragOver(false)
    // 행 드래그가 목록 밖에 떨어진 경우: 파일 임포트로 오인하지 않는다
    if (event.dataTransfer.types.includes(ROW_DRAG_MIME)) return
    if (importBusy || modalOpen) return
    const paths = Array.from(event.dataTransfer.files).map((file) =>
      window.api.getPathForFile(file)
    )
    if (paths.length === 0) return
    setImportDropPaths(paths)
    setShowImport(true)
  }

  const openImport = (): void => {
    if (importBusy || modalOpen) return
    setImportDropPaths([])
    setShowImport(true)
  }

  const openEdit = (track: Track): void => {
    if (modalOpen) return
    setEditingTrack(track)
  }

  const closeEdit = (): void => {
    setEditingTrack(null)
  }

  const focusEditFallback = (): void => {
    if (searchInputRef.current) {
      searchInputRef.current.focus()
      return
    }
    trackListRef.current?.focus()
  }

  const closeImport = (): void => {
    const state = useLibraryStore.getState()
    if (state.importing || state.urlImporting || state.pairImporting) return
    setShowImport(false)
    setImportDropPaths([])
  }

  // 행 드래그 정렬 상태: 끌고 있는 행 id와 현재 드롭 후보(대상 행 id, 위/아래)
  const [rowDrag, setRowDrag] = useState<{
    id: string
    overId: string | null
    after: boolean
  } | null>(null)
  const canReorder = search.trim() === ''

  const rowReorder = (trackId: string): RowReorderHandlers => ({
    onDragStart: (event) => {
      event.dataTransfer.setData(ROW_DRAG_MIME, trackId)
      event.dataTransfer.effectAllowed = 'move'
      setRowDrag({ id: trackId, overId: null, after: false })
    },
    onDragOver: (event) => {
      if (!event.dataTransfer.types.includes(ROW_DRAG_MIME)) return
      event.preventDefault()
      event.stopPropagation() // 패널의 파일 드롭 하이라이트를 막는다
      event.dataTransfer.dropEffect = 'move'
      const rect = event.currentTarget.getBoundingClientRect()
      const after = event.clientY > rect.top + rect.height / 2
      setRowDrag((prev) =>
        prev && (prev.overId !== trackId || prev.after !== after)
          ? { ...prev, overId: trackId, after }
          : prev
      )
    },
    onDrop: (event) => {
      if (!event.dataTransfer.types.includes(ROW_DRAG_MIME)) return
      event.preventDefault()
      event.stopPropagation()
      const draggedId = event.dataTransfer.getData(ROW_DRAG_MIME)
      setRowDrag(null)
      if (!draggedId || draggedId === trackId) return
      const rect = event.currentTarget.getBoundingClientRect()
      const after = event.clientY > rect.top + rect.height / 2
      const ids = tracks.map((t) => t.id).filter((id) => id !== draggedId)
      const targetIndex = ids.indexOf(trackId)
      if (targetIndex === -1) return
      ids.splice(targetIndex + (after ? 1 : 0), 0, draggedId)
      void reorderTracks(ids)
    },
    onDragEnd: () => setRowDrag(null)
  })

  const onDelete = async (track: Track): Promise<void> => {
    if (!window.confirm(`"${track.title}" 곡과 분리된 파일을 삭제할까요?`)) return
    if (track.id === currentTrackId) unload()
    await deleteTrack(track.id)
  }

  if (bootstrap === null) return <div className="app" />
  if (bootstrap.status !== 'ready') {
    return <BootstrapScreen state={bootstrap} onRetry={() => void window.api.retryBootstrap()} />
  }

  return (
    <div className="app">
      <div className="main-area">
        <section
          className={`panel library-panel${dragOver ? ' drag-over' : ''}`}
          onDragOver={(e) => {
            // 행 정렬 드래그는 파일 드롭 하이라이트 대상이 아니다
            if (e.dataTransfer.types.includes(ROW_DRAG_MIME)) return
            e.preventDefault()
            if (importBusy || modalOpen) return
            setDragOver(true)
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={onDrop}
        >
          <div className="panel-header">
            <h2>노래 리스트</h2>
            <div className="panel-header-actions">
              <button type="button" onClick={openImport} disabled={importBusy || modalOpen}>
                {importBusy ? '임포트 중…' : '+ 가져오기'}
              </button>
            </div>
          </div>

          <input
            ref={searchInputRef}
            className="search"
            type="search"
            placeholder="제목/아티스트/앨범 검색"
            value={search}
            onChange={(e) => void setSearch(e.target.value)}
          />

          {rejections.length > 0 && (
            <div className="rejections">
              {rejections.map((rejection, i) => (
                <p key={i}>
                  {rejection.filePath} — {rejection.reason}
                </p>
              ))}
              <button onClick={dismissRejections}>닫기</button>
            </div>
          )}

          <ul className="track-list" ref={trackListRef} tabIndex={-1}>
            {tracks.map((track, i) => (
              <TrackRow
                key={track.id}
                track={track}
                index={i + 1}
                progressPct={progress[track.id]?.pct}
                isCurrent={track.id === currentTrackId}
                isPlaying={track.id === currentTrackId && isPlaying}
                reorder={canReorder ? rowReorder(track.id) : null}
                dragging={rowDrag?.id === track.id}
                dropHint={
                  rowDrag && rowDrag.overId === track.id && rowDrag.id !== track.id
                    ? rowDrag.after
                      ? 'after'
                      : 'before'
                    : null
                }
                onLoad={() => void loadTrack(track)}
                onDelete={() => void onDelete(track)}
                onEdit={() => openEdit(track)}
              />
            ))}
            {tracks.length === 0 && (
              <li className="track-empty">
                {search
                  ? '검색 결과가 없습니다.'
                  : '오디오 파일을 이 패널에 끌어다 놓거나 [+ 가져오기]를 누르세요 (MP3/WAV/FLAC/M4A)'}
              </li>
            )}
          </ul>
        </section>

        <section className="panel lyrics-panel">
          <div className="panel-header">
            <h2>가사</h2>
          </div>
          {currentTrackId ? (
            <LyricsView />
          ) : (
            <div className="lyrics-placeholder">노래 리스트에서 곡을 선택하세요</div>
          )}
        </section>
      </div>

      <Transport />

      {/* 사이드 컬럼 (스펙 003 §4.1·§4.4): 설정·도움말 툴바, 믹서, 키 패널 */}
      <aside className="side-column">
        <div className="side-toolbar">
          <button
            className={`icon-btn icon-btn-badge-host${unseenErrors > 0 ? ' has-badge' : ''}`}
            title={unseenErrors > 0 ? `오류 ${unseenErrors}건 (보고하기)` : '오류 기록'}
            onClick={() => {
              markErrorsSeen()
              setShowErrors(true)
            }}
          >
            <MdNotificationsNone />
            {unseenErrors > 0 && (
              <span className="icon-btn-badge">{unseenErrors > 9 ? '9+' : unseenErrors}</span>
            )}
          </button>
          <button
            className="icon-btn"
            title="설정"
            disabled={editingTrack !== null || showImport}
            onClick={() => {
              if (editingTrack || showImport) return
              setShowSettings(true)
            }}
          >
            <MdSettings />
          </button>
          <button
            className="icon-btn"
            title="단축키 도움말 (/)"
            onClick={() => setShowHelp((visible) => !visible)}
          >
            <MdHelpOutline />
          </button>
        </div>
        <section className="panel mixer-panel-wrap">
          <MixerPanel />
        </section>
        <section className="panel">
          <KeyPanel />
        </section>
      </aside>

      {showSettings && <SettingsModal onClose={() => setShowSettings(false)} />}
      {showHelp && <ShortcutHelp onClose={() => setShowHelp(false)} />}
      {showErrors && <ErrorCenter onClose={() => setShowErrors(false)} />}
      {showImport && <ImportDialog initialPaths={importDropPaths} onClose={closeImport} />}
      {editingTrack && (
        <TrackEditDialog
          track={editingTrack}
          onClose={closeEdit}
          fallbackFocus={focusEditFallback}
        />
      )}
    </div>
  )
}

export default App
