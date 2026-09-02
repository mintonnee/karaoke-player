/** §4.2 probe 결과. 사이드카 done.result와 1:1 대응 */
export interface ProbeResult {
  duration: number
  sample_rate: number
  channels: number
  title?: string
  artist?: string
  album?: string
}

/** §4.3 SQLite tracks 스키마와 1:1 대응 (camelCase 매핑) */
export type TrackStatus = 'imported' | 'separating' | 'ready' | 'failed'

export type LyricsSource = 'lrclib_synced' | 'lrclib_plain_aligned' | 'user_aligned' | 'none'

export interface Track {
  id: string
  title: string
  artist: string | null
  album: string | null
  duration: number
  sourcePath: string
  status: TrackStatus
  lyricsSource: LyricsSource
  createdAt: string
  updatedAt: string
}

/** 정렬 결과 한 줄 (§4.2 align.lines). conf는 0..1, 수동 보정된 줄은 1 */
export interface AlignedLine {
  t: number
  text: string
  conf: number
}

export type AlignLang = 'ja' | 'ko' | 'en'

/** 한글 발음 힌트 한 줄 (pronunciation.json). text는 생성 시점의 가사 원문(스테일 검출용) */
export interface PronunciationLine {
  text: string
  hint: string
}

/** 트랙의 저장된 가사 (§4.3 lyrics.lrc / lyrics.txt / align.json) */
export interface LyricsPayload {
  source: LyricsSource
  /** 싱크 가사(LRC 원문). 없으면 null */
  lrc: string | null
  /** plain 가사 원문 (정렬 입력). 없으면 null */
  plain: string | null
  /** 정렬 결과(conf 포함). forced alignment를 거친 경우에만 존재 */
  lines: AlignedLine[] | null
  /** 일본어 가사의 한글 발음 힌트. 생성한 경우에만 존재 */
  pronunciation: PronunciationLine[] | null
}

export interface LyricsProgressEvent {
  trackId: string
  stage: 'align' | 'transcribe' | 'pronounce'
  pct: number
  msg?: string
}

/** 메타 편집 입력 (S3.2). LRCLIB 조회 정확도에 영향 */
export interface TrackMetaInput {
  title: string
  artist: string | null
  album: string | null
}

export interface ImportRejection {
  filePath: string
  reason: string
}

export interface ImportFilesResponse {
  imported: Track[]
  rejected: ImportRejection[]
}

export interface ImportProgressEvent {
  trackId: string
  pct: number
  msg?: string
}

/**
 * 실행 환경에 따라 켜고 끄는 기능 (스펙 001 §4.3, 기준 6).
 * zip판에만 yt-dlp.exe·deno.exe가 동봉되므로 URL 임포트는 배포 채널별로 갈린다.
 */
export interface AppCapabilities {
  urlImport: boolean
}

/** URL 임포트 다운로드 진행률 (스펙 001 §4.3). id는 요청마다 새로 발급 */
export interface UrlImportProgressEvent {
  id: string
  url: string
  pct: number
  msg?: string
}

/** 분리 산출물 절대 경로 (§4.3 tracks/<id>/) */
export interface TrackFiles {
  inst: string
  vocal: string
}

/**
 * 사이드카 부트스트랩 상태 (스펙 001 §4.1). 패키징된 앱의 첫 실행에서
 * 번들 sidecar/ 복사 → uv sync 를 거친다. dev·준비 완료 상태는 즉시 ready.
 */
export type BootstrapStatus = 'checking' | 'copying' | 'syncing' | 'ready' | 'error'

export interface BootstrapState {
  status: BootstrapStatus
  /** 사용자에게 보여줄 단계 설명 */
  message: string
  /** status === 'error' 일 때 원인 */
  error: string | null
  /** uv stderr 최근 몇 줄 */
  log: string[]
}

/** 앱 설정 (<userData>/settings.json). 설정창에서 변경한다 */
export interface AppSettings {
  /** Demucs 분리 모델. 새로 임포트하는 곡부터 적용 */
  demucsModel: string
}

/** 설정창에서 고를 수 있는 Demucs 모델 (§3 분리 스택) */
export const DEMUCS_MODELS = [
  { id: 'htdemucs_ft', label: 'htdemucs_ft — 고품질 (기본, 느림)' },
  { id: 'htdemucs', label: 'htdemucs — 표준 (빠름)' },
  { id: 'hdemucs_mmi', label: 'hdemucs_mmi — Hybrid v3' },
  { id: 'mdx_extra', label: 'mdx_extra — MDX 대회 모델' },
  { id: 'mdx_extra_q', label: 'mdx_extra_q — MDX 양자화 (경량)' }
] as const

/** §6 KARAOKE_GUIDE_VOCAL_DB 기본값 */
export const DEFAULT_GUIDE_VOCAL_DB = -20

/** AudioEngine이 재생 파일을 읽는 커스텀 프로토콜 (§4.1) */
export const MEDIA_PROTOCOL_SCHEME = 'media'

export const IPC_CHANNELS = {
  importFiles: 'library:import-files',
  importDialog: 'library:import-dialog',
  listTracks: 'library:list',
  trackFiles: 'library:track-files',
  deleteTrack: 'library:delete',
  updateTrackMeta: 'library:update-meta',
  lyricsGet: 'lyrics:get',
  lyricsRefetch: 'lyrics:refetch',
  lyricsAlign: 'lyrics:align',
  lyricsTranscribe: 'lyrics:transcribe',
  lyricsSaveLines: 'lyrics:save-lines',
  lyricsPronounce: 'lyrics:pronounce',
  lyricsProgress: 'lyrics:progress',
  trackUpdated: 'library:track-updated',
  importProgress: 'library:import-progress',
  settingsGet: 'settings:get',
  settingsSet: 'settings:set',
  tracksDir: 'library:tracks-dir',
  bootstrapGet: 'bootstrap:get',
  bootstrapRetry: 'bootstrap:retry',
  bootstrapState: 'bootstrap:state',
  capabilities: 'app:capabilities',
  importUrl: 'library:import-url',
  urlImportProgress: 'library:url-import-progress'
} as const
