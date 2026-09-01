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

/** 분리 산출물 절대 경로 (§4.3 tracks/<id>/) */
export interface TrackFiles {
  inst: string
  vocal: string
}

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
  importProgress: 'library:import-progress'
} as const
