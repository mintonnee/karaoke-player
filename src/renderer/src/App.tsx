import { useProbeStore } from './stores/probeStore'

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${m}:${String(s).padStart(2, '0')}`
}

function App(): React.JSX.Element {
  const { status, filePath, result, error, pickAndProbe } = useProbeStore()

  return (
    <div className="app">
      <h1>Karaoke Player</h1>
      <button onClick={pickAndProbe} disabled={status === 'probing'}>
        {status === 'probing' ? '분석 중…' : '오디오 파일 선택'}
      </button>

      {status === 'error' && (
        <div className="probe-error">
          <p>파일을 읽지 못했습니다.</p>
          <pre>{error}</pre>
        </div>
      )}

      {status === 'done' && result && (
        <dl className="probe-result">
          <dt>제목</dt>
          <dd>{result.title ?? '(태그 없음)'}</dd>
          <dt>아티스트</dt>
          <dd>{result.artist ?? '(태그 없음)'}</dd>
          <dt>앨범</dt>
          <dd>{result.album ?? '(태그 없음)'}</dd>
          <dt>길이</dt>
          <dd>{formatDuration(result.duration)}</dd>
          <dt>샘플레이트</dt>
          <dd>
            {result.sample_rate} Hz / {result.channels}ch
          </dd>
          <dt>경로</dt>
          <dd className="file-path">{filePath}</dd>
        </dl>
      )}
    </div>
  )
}

export default App
