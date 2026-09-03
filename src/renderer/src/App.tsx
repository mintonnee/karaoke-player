import { useEffect, useState } from 'react'
import type { DragEvent } from 'react'
import {
  MdAutorenew,
  MdCheck,
  MdCheckCircle,
  MdClose,
  MdDeleteOutline,
  MdEdit,
  MdErrorOutline,
  MdHelpOutline,
  MdLink,
  MdSchedule,
  MdSettings
} from 'react-icons/md'
import BootstrapScreen from './components/BootstrapScreen'
import CoverArt from './components/CoverArt'
import KeyPanel from './components/KeyPanel'
import LyricsView from './components/LyricsView'
import MixerPanel from './components/MixerPanel'
import SettingsModal from './components/SettingsModal'
import ShortcutHelp from './components/ShortcutHelp'
import Transport from './components/Transport'
import UrlImportForm from './components/UrlImportForm'
import { useLibraryStore } from './stores/libraryStore'
import { useLyricsStore } from './stores/lyricsStore'
import { usePlayerStore } from './stores/playerStore'
import { formatBpmDisplay } from '../../shared/analysisFormat'
import { formatKeyDisplay } from '../../shared/musicKey'
import { BPM_MAX, BPM_MIN, MUSIC_KEY_RE } from '../../shared/types'
import type { BootstrapState, Track, TrackMetaInput } from '../../shared/types'

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${m}:${String(s).padStart(2, '0')}`
}

/**
 * 메인(LibraryStore.updateMeta)과 같은 규칙으로 미리 검사해 왕복 없이 오류를 보여준다.
 * 통과해도 메인이 최종 검증한다.
 */
function validateMetaForm(form: TrackMetaInput): string | null {
  const bpm = form.bpm
  if (bpm !== null && bpm !== undefined) {
    if (!Number.isFinite(bpm) || bpm < BPM_MIN || bpm > BPM_MAX) {
      return `BPM은 ${BPM_MIN}–${BPM_MAX} 사이여야 합니다`
    }
  }
  const key = form.musicKey?.trim() ?? ''
  if (key !== '' && !MUSIC_KEY_RE.test(key)) {
    return `키 형식이 올바르지 않습니다: ${key} (예: C, F#, Am, C#m)`
  }
  return null
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

interface TrackRowProps {
  track: Track
  progressPct: number | undefined
  isCurrent: boolean
  onLoad: () => void
  onDelete: () => void
  onSaveMeta: (meta: TrackMetaInput) => Promise<void>
}

function TrackRow({
  track,
  progressPct,
  isCurrent,
  onLoad,
  onDelete,
  onSaveMeta
}: TrackRowProps): React.JSX.Element {
  const [editing, setEditing] = useState(false)
  const [form, setForm] = useState<TrackMetaInput>({
    title: track.title,
    artist: track.artist,
    album: track.album,
    bpm: track.bpm,
    musicKey: track.musicKey
  })
  const [error, setError] = useState<string | null>(null)
  const playable = track.status === 'ready'
  const bpmText = formatBpmDisplay(track.bpm, track.bpmConf)
  const keyText = formatKeyDisplay(track.musicKey)

  const startEdit = (): void => {
    setForm({
      title: track.title,
      artist: track.artist,
      album: track.album,
      bpm: track.bpm,
      musicKey: track.musicKey
    })
    setError(null)
    setEditing(true)
  }

  const save = async (): Promise<void> => {
    if (!form.title.trim()) return
    const invalid = validateMetaForm(form)
    if (invalid) {
      setError(invalid)
      return
    }
    try {
      // 폼에서 편집했으므로 bpm·musicKey를 항상 함께 보낸다 (analysis_source='user')
      await onSaveMeta({ ...form, musicKey: form.musicKey?.trim() || null })
      setError(null)
      setEditing(false)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  if (editing) {
    return (
      <li className="track-item editing">
        <div className="track-edit-form">
          <input
            value={form.title}
            placeholder="제목"
            onChange={(e) => setForm({ ...form, title: e.target.value })}
          />
          <input
            value={form.artist ?? ''}
            placeholder="아티스트"
            onChange={(e) => setForm({ ...form, artist: e.target.value || null })}
          />
          <input
            value={form.album ?? ''}
            placeholder="앨범"
            onChange={(e) => setForm({ ...form, album: e.target.value || null })}
          />
          <input
            className="meta-narrow"
            type="number"
            min={BPM_MIN}
            max={BPM_MAX}
            step={1}
            value={form.bpm ?? ''}
            placeholder="BPM"
            title={`BPM (${BPM_MIN}–${BPM_MAX}, 비우면 값 없음)`}
            onChange={(e) =>
              setForm({ ...form, bpm: e.target.value === '' ? null : e.target.valueAsNumber })
            }
          />
          <input
            className="meta-narrow"
            type="text"
            value={form.musicKey ?? ''}
            placeholder="C#m"
            title="키 (예: C, F#, Am, C#m. 비우면 값 없음)"
            onChange={(e) => setForm({ ...form, musicKey: e.target.value || null })}
          />
          {error && <p className="track-edit-error">{error}</p>}
          <div className="track-edit-actions">
            <button
              className="icon-btn"
              title="저장"
              onClick={() => void save()}
              disabled={!form.title.trim()}
            >
              <MdCheck />
            </button>
            <button className="icon-btn" title="취소" onClick={() => setEditing(false)}>
              <MdClose />
            </button>
          </div>
        </div>
      </li>
    )
  }

  return (
    <li
      className={`track-item${playable ? ' playable' : ''}${isCurrent ? ' current' : ''}`}
      onClick={playable ? onLoad : undefined}
    >
      <div className="track-main">
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
        <button className="icon-btn" title="편집" onClick={startEdit}>
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
    search,
    urlImportAvailable,
    refresh,
    setSearch,
    importFiles,
    importViaDialog,
    loadCapabilities,
    deleteTrack,
    updateTrackMeta,
    dismissRejections
  } = useLibraryStore()
  const loadTrack = usePlayerStore((s) => s.loadTrack)
  const unload = usePlayerStore((s) => s.unload)
  const currentTrackId = usePlayerStore((s) => s.track?.id)
  const loadLyrics = useLyricsStore((s) => s.load)
  const clearLyrics = useLyricsStore((s) => s.clear)
  const [dragOver, setDragOver] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [showHelp, setShowHelp] = useState(false)
  const [showUrlImport, setShowUrlImport] = useState(false)
  // null = 아직 조회 전. ready가 아니면 라이브러리 대신 부트스트랩 화면 (스펙 001 §4.1)
  const [bootstrap, setBootstrap] = useState<BootstrapState | null>(null)

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
      if (showSettings) return
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
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [showSettings])

  useEffect(() => {
    if (currentTrackId) void loadLyrics(currentTrackId)
    else clearLyrics()
  }, [currentTrackId, loadLyrics, clearLyrics])

  const onDrop = (event: DragEvent): void => {
    event.preventDefault()
    setDragOver(false)
    const paths = Array.from(event.dataTransfer.files).map((file) =>
      window.api.getPathForFile(file)
    )
    if (paths.length > 0) void importFiles(paths)
  }

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
            e.preventDefault()
            setDragOver(true)
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={onDrop}
        >
          <div className="panel-header">
            <h2>노래 리스트</h2>
            <div className="panel-header-actions">
              <button onClick={() => void importViaDialog()} disabled={importing}>
                {importing ? '임포트 중…' : '+ 가져오기'}
              </button>
              {/* yt-dlp 리소스가 없는 실행에서는 진입점 자체가 없다 (스펙 001 기준 6) */}
              {urlImportAvailable && (
                <button
                  className="icon-btn"
                  title="URL로 가져오기"
                  onClick={() => setShowUrlImport((open) => !open)}
                >
                  <MdLink />
                </button>
              )}
            </div>
          </div>

          {urlImportAvailable && showUrlImport && (
            <UrlImportForm onClose={() => setShowUrlImport(false)} />
          )}

          <input
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

          <ul className="track-list">
            {tracks.map((track) => (
              <TrackRow
                key={track.id}
                track={track}
                progressPct={progress[track.id]?.pct}
                isCurrent={track.id === currentTrackId}
                onLoad={() => void loadTrack(track)}
                onDelete={() => void onDelete(track)}
                onSaveMeta={(meta) => updateTrackMeta(track.id, meta)}
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
          <button className="icon-btn" title="설정" onClick={() => setShowSettings(true)}>
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
    </div>
  )
}

export default App
