// YtDlpService / YoutubePreviewService 테스트용 가짜 yt-dlp.
// 다운로드는 -o 템플릿의 스크래치에 파일을 만들고, 미리보기는 --dump-single-json JSON을 찍는다.
// 동영상 ID는 canonical URL의 v 파라미터에서만 읽는다 (경로 마지막 조각은 /watch 이므로 쓰지 않는다).
import { writeFileSync } from 'fs'
import { dirname, join } from 'path'

const args = process.argv.slice(2)
const dumpJson = args.includes('--dump-single-json')
const url = args[args.length - 1]
const videoId = videoIdFromUrl(url)

if (dumpJson) {
  handlePreview(videoId)
} else {
  handleDownload(videoId, args)
}

function videoIdFromUrl(raw) {
  try {
    const parsed = new URL(raw)
    const fromQuery = parsed.searchParams.get('v')
    if (fromQuery) return fromQuery
    if (parsed.hostname.toLowerCase() === 'youtu.be') {
      return parsed.pathname.split('/').filter(Boolean)[0] ?? ''
    }
  } catch {
    return ''
  }
  return ''
}

function m4aFormat(hasDrm) {
  const format = {
    format_id: '140',
    ext: 'm4a',
    acodec: 'mp4a.40.2',
    vcodec: 'none',
    audio_ext: 'm4a',
    video_ext: 'none',
    protocol: 'https'
  }
  if (hasDrm !== undefined) format.has_drm = hasDrm
  return format
}

function webmFormat() {
  return {
    format_id: '251',
    ext: 'webm',
    acodec: 'opus',
    vcodec: 'none',
    audio_ext: 'webm',
    video_ext: 'none',
    protocol: 'https',
    has_drm: false
  }
}

function dump(info, opts = {}) {
  const stderr = opts.stderr ?? ''
  const code = opts.code ?? 0
  if (stderr) process.stderr.write(stderr.endsWith('\n') ? stderr : `${stderr}\n`)
  if (info !== null && info !== undefined) process.stdout.write(JSON.stringify(info))
  process.exit(code)
}

function handlePreview(id) {
  switch (id) {
    case 'okM4aAudio0':
    case 'readyM4a000':
      dump({
        id,
        title: 'Ready Song',
        artist: 'Ready Artist - Topic',
        channel: 'Ready Channel',
        uploader: 'Ready Uploader',
        thumbnail: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
        is_live: false,
        live_status: 'not_live',
        availability: 'public',
        has_drm: false,
        formats: [m4aFormat(false)]
      })
      break
    case 'drmTrue0000':
      dump({
        id,
        title: 'DRM Title',
        artist: 'DRM Artist',
        availability: 'public',
        has_drm: true,
        formats: [m4aFormat(true)]
      })
      break
    case 'drmFalse000':
      dump({
        id,
        title: 'DRM False',
        channel: 'False Channel',
        has_drm: false,
        formats: [m4aFormat(false)]
      })
      break
    case 'drmMissing0':
      // 콘텐츠/포맷 has_drm 생략. 포맷이 있고 DRM 표시가 없으면 비보호 계약.
      dump({
        id,
        title: 'DRM Missing',
        uploader: 'Missing Uploader',
        formats: [m4aFormat()]
      })
      break
    case 'drmUnknown0':
      dump({
        id,
        title: 'DRM Unknown',
        has_drm: 'unknown',
        formats: [m4aFormat(false)]
      })
      break
    case 'drmMixed000':
      dump({
        id,
        title: 'DRM Mixed',
        artist: 'Mixed Artist',
        has_drm: false,
        formats: [
          {
            format_id: '999',
            ext: 'mp4',
            acodec: 'mp4a.40.2',
            vcodec: 'avc1.640028',
            has_drm: true
          },
          m4aFormat(false)
        ]
      })
      break
    case 'private0000':
      dump(
        {
          id,
          title: 'Private Title',
          availability: 'private',
          formats: []
        },
        {
          stderr: `ERROR: [youtube] ${id}: Private video\n`,
          code: 1
        }
      )
      break
    case 'deleted0000':
      dump(null, {
        stderr: `ERROR: [youtube] ${id}: Video unavailable. This video has been removed by the uploader\n`,
        code: 1
      })
      break
    case 'geoBlock000':
      dump(
        {
          id,
          title: 'Geo Title',
          availability: 'unavailable',
          formats: []
        },
        {
          stderr: `ERROR: [youtube] ${id}: The uploader has not made this video available in your country\n`,
          code: 1
        }
      )
      break
    case 'authNeed000':
      dump(
        {
          id,
          title: 'Auth Title',
          availability: 'needs_auth',
          age_limit: 18,
          formats: []
        },
        {
          stderr: `ERROR: [youtube] ${id}: Sign in to confirm your age\n`,
          code: 1
        }
      )
      break
    case 'liveNow0000':
      dump({
        id,
        title: 'Live Now',
        is_live: true,
        live_status: 'is_live',
        has_drm: false,
        formats: [m4aFormat(false)]
      })
      break
    case 'upcoming000':
      dump({
        id,
        title: 'Upcoming Live',
        is_live: false,
        live_status: 'is_upcoming',
        has_drm: false,
        formats: []
      })
      break
    case 'vodWasLive0':
      dump({
        id,
        title: 'Ended VOD',
        artist: 'Vod Artist',
        is_live: false,
        live_status: 'was_live',
        was_live: true,
        has_drm: false,
        formats: [m4aFormat(false)]
      })
      break
    case 'webmOnly000':
      dump({
        id,
        title: 'WebM Only',
        has_drm: false,
        formats: [webmFormat()]
      })
      break
    case 'noFormats00':
      dump({
        id,
        title: 'No Formats',
        has_drm: false,
        formats: []
      })
      break
    case 'badJson0000':
      process.stdout.write('{not-valid-json')
      process.exit(0)
      break
    case 'rateLimit00':
      dump(null, {
        stderr: `ERROR: [youtube] ${id}: HTTP Error 429: Too Many Requests\n`,
        code: 1
      })
      break
    case 'timeoutSim0':
      setInterval(() => {}, 1 << 30)
      break
    case 'hugeJson000': {
      process.stdout.write('{"id":"hugeJson000","title":"')
      process.stdout.write('a'.repeat(8 * 1024 * 1024))
      process.stdout.write('"}')
      break
    }
    case 'extractor00':
      dump(null, {
        stderr: `ERROR: [youtube] ${id}: Internal exception in extractor\n`,
        code: 1
      })
      break
    default:
      process.stderr.write(`unknown preview id: ${id}\n`)
      process.exit(2)
  }
}

function handleDownload(id, argv) {
  const outputTemplate = argv[argv.indexOf('-o') + 1]
  const scratch = dirname(outputTemplate)

  const emitProgress = () => {
    process.stdout.write('[download] Destination: fake\n')
    process.stdout.write('[download]   0.3% of  302.04KiB at  291.68KiB/s ETA 00:01\n')
    process.stdout.write('[download]  45.3% of  302.04KiB at    1.52MiB/s ETA 00:00\n')
    process.stdout.write('[download] 100% of  302.04KiB in 00:00:00 at 2.21MiB/s\n')
  }

  const mediaPath = join(scratch, 'Fake Song [abc123].m4a')
  const thumbPath = join(scratch, 'Fake Song [abc123].webp')

  switch (id) {
    case 'readyM4a000':
    case 'okM4aAudio0':
      emitProgress()
      writeFileSync(mediaPath, 'fake-m4a-bytes')
      writeFileSync(thumbPath, 'fake-webp-bytes')
      process.stdout.write(`${mediaPath}\n`)
      process.stdout.write('__artist__=Fake Artist - Topic\n')
      process.stdout.write('__title__=Fake Song\n')
      break
    case 'nothumb0000':
      emitProgress()
      writeFileSync(mediaPath, 'fake-m4a-bytes')
      process.stdout.write(`${mediaPath}\n`)
      process.stdout.write('__artist__=\n')
      break
    case 'noprint0000':
      emitProgress()
      writeFileSync(mediaPath, 'fake-m4a-bytes')
      writeFileSync(thumbPath, 'fake-webp-bytes')
      break
    case 'empty000000':
      emitProgress()
      break
    case 'fail0000000':
      process.stderr.write('WARNING: [youtube] some noisy warning\n')
      process.stderr.write('ERROR: [youtube] zzz: Requested format is not available\n')
      process.exit(1)
      break
    default:
      process.stderr.write(`unknown mode: ${id}\n`)
      process.exit(2)
  }
}
