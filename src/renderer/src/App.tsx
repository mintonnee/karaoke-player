import { useEffect, useState } from 'react'
import type { DragEvent } from 'react'
import Transport from './components/Transport'
import { useLibraryStore } from './stores/libraryStore'
import { usePlayerStore } from './stores/playerStore'
import type { Track } from '../../shared/types'

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

function App(): React.JSX.Element {
  const {
    tracks,
    progress,
    rejections,
    importing,
    refresh,
    importFiles,
    importViaDialog,
    dismissRejections
  } = useLibraryStore()
  const loadTrack = usePlayerStore((s) => s.loadTrack)
  const currentTrackId = usePlayerStore((s) => s.track?.id)
  const [dragOver, setDragOver] = useState(false)

  useEffect(() => {
    void refresh()
  }, [refresh])

  const onDrop = (event: DragEvent): void => {
    event.preventDefault()
    setDragOver(false)
    const paths = Array.from(event.dataTransfer.files).map((file) =>
      window.api.getPathForFile(file)
    )
    if (paths.length > 0) void importFiles(paths)
  }

  return (
    <div className="app">
      <h1>Karaoke Player</h1>

      <div
        className={`dropzone${dragOver ? ' drag-over' : ''}`}
        onClick={() => void importViaDialog()}
        onDragOver={(e) => {
          e.preventDefault()
          setDragOver(true)
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
      >
        {importing ? '임포트 중…' : '오디오 파일을 끌어다 놓거나 클릭해서 선택 (MP3/WAV/FLAC/M4A)'}
      </div>

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

      <Transport />

      <ul className="track-list">
        {tracks.map((track) => {
          const trackProgress = progress[track.id]
          const playable = track.status === 'ready'
          return (
            <li
              key={track.id}
              className={`track-item${playable ? ' playable' : ''}${
                track.id === currentTrackId ? ' current' : ''
              }`}
              onClick={playable ? () => void loadTrack(track) : undefined}
            >
              <div className="track-info">
                <span className="track-title">{track.title}</span>
                <span className="track-meta">
                  {track.artist ?? '(아티스트 없음)'} · {formatDuration(track.duration)}
                </span>
              </div>
              <div className="track-state">
                {track.status === 'separating' ? (
                  <div className="progress">
                    <div
                      className="progress-fill"
                      style={{ width: `${trackProgress?.pct ?? 0}%` }}
                    />
                    <span className="progress-label">{trackProgress?.pct ?? 0}%</span>
                  </div>
                ) : (
                  <span className={`status status-${track.status}`}>
                    {STATUS_LABEL[track.status]}
                  </span>
                )}
              </div>
            </li>
          )
        })}
        {tracks.length === 0 && <li className="track-empty">아직 임포트한 곡이 없습니다.</li>}
      </ul>
    </div>
  )
}

export default App
