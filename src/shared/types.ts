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

export const IPC_CHANNELS = {
  importFiles: 'library:import-files',
  importDialog: 'library:import-dialog',
  listTracks: 'library:list',
  trackUpdated: 'library:track-updated',
  importProgress: 'library:import-progress'
} as const
