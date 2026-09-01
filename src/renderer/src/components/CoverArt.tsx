import { useEffect, useState } from 'react'
import { MdMusicNote } from 'react-icons/md'
import { MEDIA_PROTOCOL_SCHEME } from '../../../shared/types'

// media:// URL 구성에 필요한 tracks 디렉토리. 모듈 로드 시 1회만 조회해 공유한다
let cachedTracksDir: string | null = null
const tracksDirPromise = window.api.getTracksDir().then((dir) => {
  cachedTracksDir = dir
  return dir
})

interface CoverArtProps {
  trackId: string
  /** 캐시 무효화 키. 트랙 갱신(updatedAt) 시 src가 바뀌어 이미지 로드를 재시도한다 */
  version: string
  className?: string
}

/**
 * <tracksDir>/<id>/cover.jpg 를 media:// 로 표시한다.
 * 커버가 없거나(404) 아직 추출 전이면 ♪ 플레이스홀더가 그대로 보인다.
 */
function CoverArt({ trackId, version, className }: CoverArtProps): React.JSX.Element {
  const [tracksDir, setTracksDir] = useState(cachedTracksDir)
  const [failed, setFailed] = useState(false)
  const [failedSrc, setFailedSrc] = useState<string | null>(null)

  useEffect(() => {
    if (tracksDir === null) void tracksDirPromise.then(setTracksDir)
  }, [tracksDir])

  const src = tracksDir
    ? `${MEDIA_PROTOCOL_SCHEME}://cover?path=${encodeURIComponent(
        `${tracksDir}/${trackId}/cover.jpg`
      )}&v=${encodeURIComponent(version)}`
    : null

  // src가 바뀌면 실패 상태를 렌더 단계에서 리셋한다 (React 권장 derived-state 패턴)
  if (failed && failedSrc !== src) {
    setFailed(false)
    setFailedSrc(null)
  }

  const onError = (): void => {
    setFailed(true)
    setFailedSrc(src)
  }

  return (
    <div className={`cover-art${className ? ` ${className}` : ''}`} aria-hidden="true">
      <MdMusicNote />
      {src !== null && !failed && <img src={src} alt="" onError={onError} />}
    </div>
  )
}

export default CoverArt
