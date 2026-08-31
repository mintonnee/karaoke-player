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
  trackUpdated: 'library:track-updated',
  importProgress: 'library:import-progress'
} as const
