import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import type { CoverPreviewResult, TrackEditSaveRequest } from '../shared/trackEdit'
import { DEFAULT_GUIDE_VOCAL_DB, IPC_CHANNELS } from '../shared/types'
import type {
  AlignLang,
  AlignedLine,
  AppCapabilities,
  AppSettings,
  AudioTagPreview,
  BootstrapState,
  ImportFilesResponse,
  ImportProgressEvent,
  ImportUserMeta,
  AppErrorReport,
  AppInfo,
  LyricsPayload,
  LyricsProgressEvent,
  PairImportProgressEvent,
  PairImportRequest,
  Track,
  TrackVolumes,
  TrackFiles,
  TrackMetaInput,
  UrlImportProgressEvent,
  YoutubePreviewCancelRequest,
  YoutubePreviewRequest,
  YoutubePreviewResult
} from '../shared/types'

function subscribe<T>(channel: string, callback: (payload: T) => void): () => void {
  const listener = (_event: Electron.IpcRendererEvent, payload: T): void => callback(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

// Custom APIs for renderer
const api = {
  getTrackVolumes: (trackId: string): Promise<TrackVolumes | null> =>
    ipcRenderer.invoke(IPC_CHANNELS.getTrackVolumes, trackId),
  getTrackPitch: (trackId: string): Promise<number> =>
    ipcRenderer.invoke(IPC_CHANNELS.getTrackPitch, trackId),
  setTrackPitch: (trackId: string, semitones: number): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.setTrackPitch, trackId, semitones),
  setTrackVolumes: (trackId: string, volumes: TrackVolumes): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.setTrackVolumes, trackId, volumes),
  listTracks: (query?: string): Promise<Track[]> =>
    ipcRenderer.invoke(IPC_CHANNELS.listTracks, query),
  trackFiles: (trackId: string): Promise<TrackFiles> =>
    ipcRenderer.invoke(IPC_CHANNELS.trackFiles, trackId),
  deleteTrack: (trackId: string): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.deleteTrack, trackId),
  reorderTracks: (ids: string[]): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.reorderTracks, ids),
  updateTrackMeta: (trackId: string, meta: TrackMetaInput): Promise<Track> =>
    ipcRenderer.invoke(IPC_CHANNELS.updateTrackMeta, trackId, meta),
  saveTrackEdit: (req: TrackEditSaveRequest): Promise<Track> =>
    ipcRenderer.invoke(IPC_CHANNELS.saveTrackEdit, req),
  getLyrics: (trackId: string): Promise<LyricsPayload> =>
    ipcRenderer.invoke(IPC_CHANNELS.lyricsGet, trackId),
  refetchLyrics: (trackId: string): Promise<LyricsPayload> =>
    ipcRenderer.invoke(IPC_CHANNELS.lyricsRefetch, trackId),
  alignLyrics: (
    trackId: string,
    text: string,
    lang: AlignLang,
    fromLrclibPlain: boolean
  ): Promise<LyricsPayload> =>
    ipcRenderer.invoke(IPC_CHANNELS.lyricsAlign, trackId, text, lang, fromLrclibPlain),
  transcribeLyrics: (trackId: string): Promise<string> =>
    ipcRenderer.invoke(IPC_CHANNELS.lyricsTranscribe, trackId),
  saveLyricsLines: (trackId: string, lines: AlignedLine[]): Promise<LyricsPayload> =>
    ipcRenderer.invoke(IPC_CHANNELS.lyricsSaveLines, trackId, lines),
  pronounceLyrics: (trackId: string): Promise<LyricsPayload> =>
    ipcRenderer.invoke(IPC_CHANNELS.lyricsPronounce, trackId),
  resetLyrics: (trackId: string): Promise<LyricsPayload> =>
    ipcRenderer.invoke(IPC_CHANNELS.lyricsReset, trackId),
  onLyricsProgress: (callback: (event: LyricsProgressEvent) => void): (() => void) =>
    subscribe(IPC_CHANNELS.lyricsProgress, callback),
  /** 메인 프로세스 실패 통지 (오류 센터) */
  onAppError: (callback: (report: AppErrorReport) => void): (() => void) =>
    subscribe(IPC_CHANNELS.appError, callback),
  getAppInfo: (): Promise<AppInfo> => ipcRenderer.invoke(IPC_CHANNELS.appInfo),
  /** 외부 브라우저로 열기 (https만 허용) */
  openExternal: (url: string): Promise<void> => ipcRenderer.invoke(IPC_CHANNELS.openExternal, url),
  /** §6 KARAOKE_GUIDE_VOCAL_DB (기본 -20 dB) */
  guideVocalDefaultDb: ((): number => {
    const parsed = Number(process.env.KARAOKE_GUIDE_VOCAL_DB)
    return Number.isFinite(parsed) ? parsed : DEFAULT_GUIDE_VOCAL_DB
  })(),
  getTracksDir: (): Promise<string> => ipcRenderer.invoke(IPC_CHANNELS.tracksDir),
  getSettings: (): Promise<AppSettings> => ipcRenderer.invoke(IPC_CHANNELS.settingsGet),
  setSettings: (patch: Partial<AppSettings>): Promise<AppSettings> =>
    ipcRenderer.invoke(IPC_CHANNELS.settingsSet, patch),
  importFiles: (filePaths: string[], userMeta?: ImportUserMeta): Promise<ImportFilesResponse> =>
    ipcRenderer.invoke(IPC_CHANNELS.importFiles, filePaths, userMeta),
  importDialog: (): Promise<ImportFilesResponse> => ipcRenderer.invoke(IPC_CHANNELS.importDialog),
  pickAudioFile: (): Promise<string | null> => ipcRenderer.invoke(IPC_CHANNELS.pickAudioFile),
  pickImageFile: (): Promise<string | null> => ipcRenderer.invoke(IPC_CHANNELS.pickImageFile),
  previewCover: (filePath: string): Promise<string | null> =>
    ipcRenderer.invoke(IPC_CHANNELS.previewCover, filePath),
  previewCoverDetailed: (filePath: string): Promise<CoverPreviewResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.previewCoverDetailed, filePath),
  probeAudioTags: (filePath: string): Promise<AudioTagPreview> =>
    ipcRenderer.invoke(IPC_CHANNELS.probeAudioTags, filePath),
  importPair: (req: PairImportRequest): Promise<ImportFilesResponse> =>
    ipcRenderer.invoke(IPC_CHANNELS.importPair, req),
  onPairImportProgress: (callback: (event: PairImportProgressEvent) => void): (() => void) =>
    subscribe(IPC_CHANNELS.pairImportProgress, callback),
  /** 드롭된 File 객체에서 절대 경로 추출 (렌더러에서는 접근 불가) */
  getPathForFile: (file: File): string => webUtils.getPathForFile(file),
  onTrackUpdated: (callback: (track: Track) => void): (() => void) =>
    subscribe(IPC_CHANNELS.trackUpdated, callback),
  onImportProgress: (callback: (event: ImportProgressEvent) => void): (() => void) =>
    subscribe(IPC_CHANNELS.importProgress, callback),
  /** 사이드카 부트스트랩 (스펙 008 §4.5). 라이브러리는 ready 전에도 연다 */
  getBootstrapState: (): Promise<BootstrapState> => ipcRenderer.invoke(IPC_CHANNELS.bootstrapGet),
  retryBootstrap: (): Promise<BootstrapState> => ipcRenderer.invoke(IPC_CHANNELS.bootstrapRetry),
  onBootstrapState: (callback: (state: BootstrapState) => void): (() => void) =>
    subscribe(IPC_CHANNELS.bootstrapState, callback),
  /** 배포 채널별 기능 플래그 (스펙 001 §4.3). urlImport가 false면 URL UI를 그리지 않는다 */
  getCapabilities: (): Promise<AppCapabilities> => ipcRenderer.invoke(IPC_CHANNELS.capabilities),
  importUrl: (url: string, userMeta?: ImportUserMeta): Promise<ImportFilesResponse> =>
    ipcRenderer.invoke(IPC_CHANNELS.importUrl, url, userMeta),
  previewYoutube: (req: YoutubePreviewRequest): Promise<YoutubePreviewResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.previewYoutube, req),
  cancelYoutubePreview: (req: YoutubePreviewCancelRequest): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.cancelYoutubePreview, req),
  onUrlImportProgress: (callback: (event: UrlImportProgressEvent) => void): (() => void) =>
    subscribe(IPC_CHANNELS.urlImportProgress, callback)
}

// Use `contextBridge` APIs to expose Electron APIs to
// renderer only if context isolation is enabled, otherwise
// just add to the DOM global.
if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.electron = electronAPI
  // @ts-ignore (define in dts)
  window.api = api
}

export type RendererApi = typeof api
