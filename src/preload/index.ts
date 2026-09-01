import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import { DEFAULT_GUIDE_VOCAL_DB, IPC_CHANNELS } from '../shared/types'
import type {
  AlignLang,
  AlignedLine,
  ImportFilesResponse,
  ImportProgressEvent,
  LyricsPayload,
  LyricsProgressEvent,
  Track,
  TrackFiles,
  TrackMetaInput
} from '../shared/types'

function subscribe<T>(channel: string, callback: (payload: T) => void): () => void {
  const listener = (_event: Electron.IpcRendererEvent, payload: T): void => callback(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

// Custom APIs for renderer
const api = {
  listTracks: (query?: string): Promise<Track[]> =>
    ipcRenderer.invoke(IPC_CHANNELS.listTracks, query),
  trackFiles: (trackId: string): Promise<TrackFiles> =>
    ipcRenderer.invoke(IPC_CHANNELS.trackFiles, trackId),
  deleteTrack: (trackId: string): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.deleteTrack, trackId),
  updateTrackMeta: (trackId: string, meta: TrackMetaInput): Promise<Track> =>
    ipcRenderer.invoke(IPC_CHANNELS.updateTrackMeta, trackId, meta),
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
  onLyricsProgress: (callback: (event: LyricsProgressEvent) => void): (() => void) =>
    subscribe(IPC_CHANNELS.lyricsProgress, callback),
  /** §6 KARAOKE_GUIDE_VOCAL_DB (기본 -20 dB) */
  guideVocalDefaultDb: ((): number => {
    const parsed = Number(process.env.KARAOKE_GUIDE_VOCAL_DB)
    return Number.isFinite(parsed) ? parsed : DEFAULT_GUIDE_VOCAL_DB
  })(),
  importFiles: (filePaths: string[]): Promise<ImportFilesResponse> =>
    ipcRenderer.invoke(IPC_CHANNELS.importFiles, filePaths),
  importDialog: (): Promise<ImportFilesResponse> => ipcRenderer.invoke(IPC_CHANNELS.importDialog),
  /** 드롭된 File 객체에서 절대 경로 추출 (렌더러에서는 접근 불가) */
  getPathForFile: (file: File): string => webUtils.getPathForFile(file),
  onTrackUpdated: (callback: (track: Track) => void): (() => void) =>
    subscribe(IPC_CHANNELS.trackUpdated, callback),
  onImportProgress: (callback: (event: ImportProgressEvent) => void): (() => void) =>
    subscribe(IPC_CHANNELS.importProgress, callback)
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
