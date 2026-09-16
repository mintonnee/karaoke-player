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

/** 가져오기 경로. 일반 음원·YouTube는 separated, MR+가이드는 paired */
export type ImportKind = 'separated' | 'paired'

/** 가이드 파일 의미. vocal_only=보컬 전용, full_mix=AR(반주+보컬). separated+full_mix는 금지 */
export type GuideKind = 'vocal_only' | 'full_mix' | 'none'

/** 곡별로 저장하는 믹서 페이더 값 (-60..0 dB)과 뮤트. 소스 선택은 제외한다. */
export interface TrackVolumes {
  masterDb: number
  instDb: number
  vocalDb: number
  masterMuted: boolean
  instMuted: boolean
  vocalMuted: boolean
}

/** 가이드 재생 파일명. AR은 vocal.wav로 저장하지 않는다 */
export function guideAudioFileName(guideKind: GuideKind): 'vocal.wav' | 'guide.wav' | null {
  if (guideKind === 'none') return null
  return guideKind === 'full_mix' ? 'guide.wav' : 'vocal.wav'
}

/** 두 파일 길이 차이 허용치 (ms). sidecar와 Main probe가 같은 값을 쓴다 */
export const PAIR_LENGTH_DELTA_MS = 100

/** prepare-pair 산출 meta.json의 준비 버전 */
export const PREPARE_PAIR_VERSION = 1

export type LyricsSource = 'lrclib_synced' | 'lrclib_plain_aligned' | 'user_aligned' | 'none'

/** BPM·키 값의 출처 (스펙 002 §4.2). user는 백필·재분석이 덮어쓰지 않는다 */
export type AnalysisSource = 'none' | 'auto' | 'user'

export interface Track {
  id: string
  title: string
  artist: string | null
  album: string | null
  duration: number
  sourcePath: string
  status: TrackStatus
  lyricsSource: LyricsSource
  /** v3: 분석 결과 (스펙 002). 미분석·추정 불가는 null */
  bpm: number | null
  /** 샤프 통일 12음 + 단조 'm' 접미 (예: 'C#m'). MUSIC_KEY_RE 형식 */
  musicKey: string | null
  /** 0..1. 사용자 입력 값은 null */
  bpmConf: number | null
  keyConf: number | null
  analysisSource: AnalysisSource
  /** v5: 가져오기 종류. 기존 행은 separated */
  importKind: ImportKind
  /** v5: 가이드 종류. 기존 행은 vocal_only */
  guideKind: GuideKind
  createdAt: string
  updatedAt: string
}

/**
 * 스펙 002 §1 결정 기록: 알고리즘 버전. 올리면 백필이 auto 트랙을 다시 분석한다.
 * 1 = Krumhansl–Kessler·55–2000 Hz·접기 상한 200, 2 = Bellman–Budge·110–2000 Hz·접기 상한 170
 */
// 3 = 모델 준비/추론 실패를 성공으로 저장하지 않음. 기존 실패 결과를 백필한다.
export const ANALYSIS_VERSION = 3
/**
 * BPM 신뢰도가 이 값 미만이면 표시에 '?' 접미 (스펙 002 §4.3). 비트 간격 분산 기반이라
 * 0–0.97로 넓게 분포한다. 키 신뢰도는 정답 여부와 상관이 약해 '?'를 붙이지 않는다(§1 v2).
 */
export const BPM_LOW_CONF = 0.5
/** 키 표기 형식: C C# D ... B (+ 'm') */
export const MUSIC_KEY_RE = /^[A-G]#?m?$/
export const BPM_MIN = 30
export const BPM_MAX = 300

/** 스펙 002 §4.1 사이드카 analyze done.result와 1:1 대응 */
export interface AnalyzeResult {
  bpm: number | null
  bpm_conf: number | null
  key: string | null
  key_conf: number | null
  version: number
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
  /** 스펙 002 §4.2: 생략(undefined)이면 기존 값 유지, 있으면 사용자 값(analysis_source='user')으로 저장. BPM_MIN..BPM_MAX */
  bpm?: number | null
  /** MUSIC_KEY_RE 형식. 빈 값은 null로 넘긴다 */
  musicKey?: string | null
}

/** 두 파일 가져오기에서 오류가 난 입력 역할. I3가 슬롯 옆에 표시한다 */
export type PairImportRole = 'mr' | 'guide' | 'pair'

export interface ImportRejection {
  filePath: string
  reason: string
  /** 두 파일 가져오기 실패 시 어느 슬롯/요청인지. 일반 파일·URL은 생략 */
  role?: PairImportRole
}

export interface ImportFilesResponse {
  imported: Track[]
  rejected: ImportRejection[]
}

/** 가져오기 팝업이 파일 태그로 미리 채울 때 쓰는 미리보기 */
export interface AudioTagPreview {
  title: string | null
  artist: string | null
}

/** 가져오기 팝업에서 사용자가 적은 곡 정보. 비우면 파일 태그·자동 추출을 쓴다 */
export interface ImportUserMeta {
  title?: string
  artist?: string
  /** 사용자가 고른 커버 이미지. 있으면 내장 아트·YouTube 썸네일보다 우선 */
  coverPath?: string
}

/** IPC로 들어온 값을 trim하고 빈 필드는 뺀다 */
export function sanitizeImportUserMeta(raw: unknown): ImportUserMeta | undefined {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const rec = raw as Record<string, unknown>
  const title = typeof rec.title === 'string' ? rec.title.trim() : ''
  const artist = typeof rec.artist === 'string' ? rec.artist.trim() : ''
  const coverPath = typeof rec.coverPath === 'string' ? rec.coverPath.trim() : ''
  if (title === '' && artist === '' && coverPath === '') return undefined
  const meta: ImportUserMeta = {}
  if (title !== '') meta.title = title
  if (artist !== '') meta.artist = artist
  if (coverPath !== '') meta.coverPath = coverPath
  return meta
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

/** capability urlImport=false 일 때 사용자 메시지 (스펙 001·004·009) */
export const URL_IMPORT_DISABLED_REASON = '이 배포판에서는 URL 가져오기를 쓸 수 없습니다'

/** 스펙 009 §4.2·§4.3 YouTube 사전 확인 결과 코드 */
export const YOUTUBE_PREVIEW_BLOCKED_CODES = [
  'DRM_PROTECTED',
  'UNAVAILABLE',
  'AUTH_REQUIRED',
  'LIVE_UNSUPPORTED',
  'NO_SUPPORTED_AUDIO'
] as const

export const YOUTUBE_PREVIEW_ERROR_CODES = [
  'NETWORK',
  'RATE_LIMITED',
  'TIMEOUT',
  'EXTRACTOR_ERROR',
  'UNKNOWN',
  'INVALID_URL',
  'DISABLED'
] as const

export const YOUTUBE_PREVIEW_CODES = [
  'READY',
  ...YOUTUBE_PREVIEW_BLOCKED_CODES,
  ...YOUTUBE_PREVIEW_ERROR_CODES,
  'CANCELLED'
] as const

export type YoutubePreviewBlockedCode = (typeof YOUTUBE_PREVIEW_BLOCKED_CODES)[number]
export type YoutubePreviewErrorCode = (typeof YOUTUBE_PREVIEW_ERROR_CODES)[number]
export type YoutubePreviewCode = (typeof YOUTUBE_PREVIEW_CODES)[number]
export type YoutubePreviewStatus = 'ready' | 'blocked' | 'error' | 'cancelled'

export interface YoutubePreviewRequest {
  requestId: string
  url: string
}

export interface YoutubePreviewCancelRequest {
  requestId: string
}

export interface YoutubePreviewMetadata {
  title: string | null
  artist: string | null
  thumbnailDataUrl: string | null
}

interface YoutubePreviewResultBase {
  requestId: string
  message: string
  metadata: YoutubePreviewMetadata | null
  thumbnailWarning: string | null
}

export interface YoutubePreviewReadyResult extends YoutubePreviewResultBase {
  status: 'ready'
  code: 'READY'
  canonicalUrl: string
  checkedAt: number
}

export interface YoutubePreviewBlockedResult extends YoutubePreviewResultBase {
  status: 'blocked'
  code: YoutubePreviewBlockedCode
  canonicalUrl: string | null
  checkedAt: number | null
}

export interface YoutubePreviewErrorResult extends YoutubePreviewResultBase {
  status: 'error'
  code: YoutubePreviewErrorCode
  canonicalUrl: string | null
  checkedAt: number | null
}

export interface YoutubePreviewCancelledResult extends YoutubePreviewResultBase {
  status: 'cancelled'
  code: 'CANCELLED'
  canonicalUrl: string | null
  checkedAt: number | null
}

export type YoutubePreviewResult =
  | YoutubePreviewReadyResult
  | YoutubePreviewBlockedResult
  | YoutubePreviewErrorResult
  | YoutubePreviewCancelledResult

export const YOUTUBE_PREVIEW_MESSAGES: Record<YoutubePreviewCode, string> = {
  READY: '가져오기 가능',
  DRM_PROTECTED: 'DRM으로 보호된 콘텐츠는 가져올 수 없습니다',
  UNAVAILABLE: '동영상을 찾을 수 없거나 재생할 수 없습니다',
  AUTH_REQUIRED: '로그인이 필요한 콘텐츠는 가져올 수 없습니다',
  LIVE_UNSUPPORTED: '진행 중이거나 예정된 라이브는 가져올 수 없습니다',
  NO_SUPPORTED_AUDIO: '가져올 수 있는 오디오가 없습니다',
  NETWORK: '확인하지 못했습니다. 다시 시도해 주세요',
  RATE_LIMITED: '확인하지 못했습니다. 다시 시도해 주세요',
  TIMEOUT: '확인하지 못했습니다. 다시 시도해 주세요',
  EXTRACTOR_ERROR: '확인하지 못했습니다. 다시 시도해 주세요',
  UNKNOWN: '확인하지 못했습니다. 다시 시도해 주세요',
  INVALID_URL: '올바른 YouTube 동영상 URL을 입력하세요',
  DISABLED: URL_IMPORT_DISABLED_REASON,
  CANCELLED: '확인이 취소되었습니다'
}

export function youtubePreviewMessage(code: YoutubePreviewCode): string {
  return YOUTUBE_PREVIEW_MESSAGES[code]
}

export function youtubePreviewStatusForCode(code: YoutubePreviewCode): YoutubePreviewStatus {
  if (code === 'READY') return 'ready'
  if (code === 'CANCELLED') return 'cancelled'
  if ((YOUTUBE_PREVIEW_BLOCKED_CODES as readonly string[]).includes(code)) return 'blocked'
  return 'error'
}

/** 팝업 세션 ID와 증가 generation을 `sessionId:generation`으로 붙인 불투명 요청 ID */
export function makeYoutubePreviewRequestId(sessionId: string, generation: number): string {
  return `${sessionId}:${generation}`
}

const YOUTUBE_PREVIEW_CODE_SET = new Set<string>(YOUTUBE_PREVIEW_CODES)
const YOUTUBE_PREVIEW_STATUS_CODES: Record<YoutubePreviewStatus, ReadonlySet<string>> = {
  ready: new Set(['READY']),
  blocked: new Set(YOUTUBE_PREVIEW_BLOCKED_CODES),
  error: new Set(YOUTUBE_PREVIEW_ERROR_CODES),
  cancelled: new Set(['CANCELLED'])
}

export function isYoutubePreviewCode(raw: unknown): raw is YoutubePreviewCode {
  return typeof raw === 'string' && YOUTUBE_PREVIEW_CODE_SET.has(raw)
}

/**
 * IPC 미리보기 결과를 화이트리스트 필드로만 재구성한다.
 * 예외를 던지지 않으며 yt-dlp JSON·쿠키·서명 URL·stderr를 통과시키지 않는다.
 */
export function parseYoutubePreviewResult(raw: unknown): YoutubePreviewResult | null {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const rec = raw as Record<string, unknown>

  if (typeof rec.requestId !== 'string') return null
  if (typeof rec.message !== 'string') return null
  if (!isYoutubePreviewStatus(rec.status)) return null
  if (!isYoutubePreviewCode(rec.code)) return null
  if (!YOUTUBE_PREVIEW_STATUS_CODES[rec.status].has(rec.code)) return null

  const metadata = parseYoutubePreviewMetadata(rec.metadata)
  if (metadata === undefined) return null
  const thumbnailWarning = parseStringOrNull(rec.thumbnailWarning)
  if (thumbnailWarning === undefined) return null

  if (rec.status === 'ready') {
    if (rec.code !== 'READY') return null
    if (typeof rec.canonicalUrl !== 'string' || rec.canonicalUrl === '') return null
    if (typeof rec.checkedAt !== 'number' || !Number.isFinite(rec.checkedAt)) return null
    return {
      requestId: rec.requestId,
      canonicalUrl: rec.canonicalUrl,
      status: 'ready',
      code: 'READY',
      message: rec.message,
      checkedAt: rec.checkedAt,
      metadata,
      thumbnailWarning
    }
  }

  const canonicalUrl = parseStringOrNull(rec.canonicalUrl)
  if (canonicalUrl === undefined) return null
  const checkedAt = parseFiniteNumberOrNull(rec.checkedAt)
  if (checkedAt === undefined) return null

  if (rec.status === 'blocked') {
    return {
      requestId: rec.requestId,
      canonicalUrl,
      status: 'blocked',
      code: rec.code as YoutubePreviewBlockedCode,
      message: rec.message,
      checkedAt,
      metadata,
      thumbnailWarning
    }
  }
  if (rec.status === 'error') {
    return {
      requestId: rec.requestId,
      canonicalUrl,
      status: 'error',
      code: rec.code as YoutubePreviewErrorCode,
      message: rec.message,
      checkedAt,
      metadata,
      thumbnailWarning
    }
  }
  return {
    requestId: rec.requestId,
    canonicalUrl,
    status: 'cancelled',
    code: 'CANCELLED',
    message: rec.message,
    checkedAt,
    metadata,
    thumbnailWarning
  }
}

function isYoutubePreviewStatus(raw: unknown): raw is YoutubePreviewStatus {
  return raw === 'ready' || raw === 'blocked' || raw === 'error' || raw === 'cancelled'
}

function parseYoutubePreviewMetadata(raw: unknown): YoutubePreviewMetadata | null | undefined {
  if (raw == null) return null
  if (typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const rec = raw as Record<string, unknown>
  const title = parseStringOrNull(rec.title)
  const artist = parseStringOrNull(rec.artist)
  const thumbnailDataUrl = parseStringOrNull(rec.thumbnailDataUrl)
  if (title === undefined || artist === undefined || thumbnailDataUrl === undefined)
    return undefined
  return { title, artist, thumbnailDataUrl }
}

/** undefined = 타입 불일치 (거부). null/undefined 입력은 null */
function parseStringOrNull(raw: unknown): string | null | undefined {
  if (raw == null) return null
  if (typeof raw === 'string') return raw
  return undefined
}

function parseFiniteNumberOrNull(raw: unknown): number | null | undefined {
  if (raw == null) return null
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw
  return undefined
}

/** MR + 가이드 한 곡 가져오기 요청 (스펙 004). 일반 importFiles를 두 번 호출하지 않는다 */
export interface PairImportRequest {
  mrPath: string
  guidePath: string | null
  guideKind: GuideKind
  title?: string
  artist?: string
  coverPath?: string
}

/** 팝업 단계. 측정할 수 없으면 pct를 생략한다 (불확정 진행) */
export type PairImportStage = 'queued' | 'probe' | 'prepare' | 'save'

export interface PairImportProgressEvent {
  jobId: string
  stage: PairImportStage
  pct?: number
  msg?: string
}

/** sidecar prepare-pair done.result (스펙 000 §4.2) */
export interface PreparePairResult {
  inst: string
  /** vocal.wav 또는 guide.wav (--guide-kind에 따름) */
  guide: string | null
  duration: number
}

/** 분리/준비 산출물 절대 경로 (§4.3 tracks/<id>/) */
export interface TrackFiles {
  inst: string
  /** vocal.wav (vocal_only) or guide.wav (full_mix). Not assumed to be vocals-only. */
  guide: string | null
  /**
   * Compatibility alias equal to `guide`. Keep this so renderer typecheck still passes
   * until I4 renames AudioEngine.load. Same path as `guide`.
   */
  vocal: string | null
  guideKind: GuideKind
}

/**
 * 사이드카 부트스트랩 상태 (스펙 001 §4.1, 008 §4.5).
 * copying/syncing은 L2 하위 호환. UI는 stage(download/verify/env-prep/model-prep)를 우선한다.
 */
export type BootstrapStatus =
  | 'checking'
  | 'copying'
  | 'syncing'
  | 'download'
  | 'verify'
  | 'env-prep'
  | 'model-prep'
  | 'ready'
  | 'error'

/** 실패 UI가 구분하는 준비 단계 (스펙 008 기준 10) */
export type BootstrapPrepStage = 'download' | 'verify' | 'env-prep' | 'model-prep'

export interface BootstrapState {
  status: BootstrapStatus
  /** 사용자에게 보여줄 단계 설명 */
  message: string
  /** status === 'error' 일 때 원인 */
  error: string | null
  /** uv stderr 최근 몇 줄 */
  log: string[]
  /** 다운로드·검증·환경 구성·모델 준비. 없으면 status에서 유도 */
  stage?: BootstrapPrepStage | null
  /** 실패한 논리 ID (uv, 모델 id 등) */
  logicalId?: string | null
  /** 실제 bootstrap 재구성을 다시 실행할 수 있는 오류에서만 true */
  retryable?: boolean
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

export type DemucsModelId = (typeof DEMUCS_MODELS)[number]['id']

export function isRegisteredDemucsModel(id: string): id is DemucsModelId {
  return DEMUCS_MODELS.some((model) => model.id === id)
}

/** sidecar worker 명령 → 등록된 모델 ID (스펙 008 §4.5). separate는 설정값 */
export const WORKER_MODEL_IDS = {
  transcribe: 'large-v3-turbo',
  align: 'mms-fa',
  analyze: 'beat-this-final0'
} as const

export type WorkerCommand = 'separate' | 'transcribe' | 'align' | 'analyze' | string

/** worker args[0]에 대응하는 모델 ID. 모델이 필요 없으면 null */
export function modelIdForWorker(command: string, demucsModel: string): string | null {
  if (command === 'separate') return demucsModel
  if (command === 'transcribe') return WORKER_MODEL_IDS.transcribe
  if (command === 'align') return WORKER_MODEL_IDS.align
  if (command === 'analyze') return WORKER_MODEL_IDS.analyze
  return null
}

/** §6 KARAOKE_GUIDE_VOCAL_DB 기본값 */
export const DEFAULT_GUIDE_VOCAL_DB = -20

/** AudioEngine이 재생 파일을 읽는 커스텀 프로토콜 (§4.1) */
export const MEDIA_PROTOCOL_SCHEME = 'media'

export const IPC_CHANNELS = {
  importFiles: 'library:import-files',
  importDialog: 'library:import-dialog',
  /** 네이티브 파일 선택만. 가져오기는 시작하지 않는다 */
  pickAudioFile: 'library:pick-audio-file',
  pickImageFile: 'library:pick-image-file',
  previewCover: 'library:preview-cover',
  /** 실패 사유를 포함한 커버 미리보기 (스펙 005). 기존 previewCover는 null만 반환 */
  previewCoverDetailed: 'library:preview-cover-detailed',
  /** 가져오기 팝업용. 파일을 등록하지 않고 태그만 읽는다 */
  probeAudioTags: 'library:probe-audio-tags',
  importPair: 'library:import-pair',
  pairImportProgress: 'library:pair-import-progress',
  listTracks: 'library:list',
  trackFiles: 'library:track-files',
  getTrackVolumes: 'library:get-volumes',
  getTrackPitch: 'library:get-pitch',
  setTrackPitch: 'library:set-pitch',
  setTrackVolumes: 'library:set-volumes',
  deleteTrack: 'library:delete',
  updateTrackMeta: 'library:update-meta',
  /** 메타 변경분과 커버 동작을 한 번에 저장 (스펙 005 §4.3) */
  saveTrackEdit: 'library:save-track-edit',
  reorderTracks: 'library:reorder',
  lyricsGet: 'lyrics:get',
  lyricsRefetch: 'lyrics:refetch',
  lyricsAlign: 'lyrics:align',
  lyricsTranscribe: 'lyrics:transcribe',
  lyricsSaveLines: 'lyrics:save-lines',
  lyricsPronounce: 'lyrics:pronounce',
  lyricsReset: 'lyrics:reset',
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
  previewYoutube: 'library:preview-youtube',
  cancelYoutubePreview: 'library:cancel-youtube-preview',
  urlImportProgress: 'library:url-import-progress',
  /** 메인 → 렌더러: 사용자에게 보여줄 실패 (오류 센터에 쌓인다) */
  appError: 'app:error',
  appInfo: 'app:info',
  openExternal: 'app:open-external'
} as const

/** 오류 센터 항목의 출처. 이슈 제목 접두어로도 쓴다 */
export type AppErrorSource =
  'import' | 'separate' | 'analyze' | 'lyrics' | 'player' | 'jobs' | 'url-import' | 'runtime'

/** 메인/렌더러가 오류 센터로 보내는 실패 한 건 */
export interface AppErrorReport {
  source: AppErrorSource
  message: string
  /** ISO 시각 */
  at: string
  trackId?: string
}

/** 이슈 보고에 붙는 환경 정보 */
export interface AppInfo {
  version: string
  platform: string
  arch: string
  electron: string
}
