import { app, dialog, ipcMain, nativeImage, shell } from 'electron'
import { rm } from 'fs/promises'
import { join } from 'path'
import { ALLOWED_COVER_EXT } from '../shared/trackEdit'
import type { CoverPreviewResult, TrackEditSaveRequest } from '../shared/trackEdit'
import { DEMUCS_MODELS, IPC_CHANNELS, sanitizeImportUserMeta } from '../shared/types'
import type {
  AlignLang,
  AlignedLine,
  AppCapabilities,
  AppInfo,
  AppSettings,
  AudioTagPreview,
  ImportFilesResponse,
  ImportUserMeta,
  PairImportRequest,
  Track,
  TrackVolumes,
  TrackFiles,
  TrackMetaInput
} from '../shared/types'
import { inspectCoverImage } from './library/coverImage'
import type { CoverService } from './library/CoverService'
import { ImportRequestGate } from './library/ImportRequestGate'
import { precheckImportUrl, URL_IMPORT_DISABLED_REASON } from './library/importUrlPrecheck'
import type { ImportService } from './library/ImportService'
import type { LibraryStore } from './library/LibraryStore'
import type { SearchKeyService } from './library/SearchKeyService'
import type { TrackEditService } from './library/TrackEditService'
import { requireReadyTrackFiles } from './library/trackFiles'
import type { YtDlpService } from './library/YtDlpService'
import type { LyricsService } from './lyrics/LyricsService'
import type { SettingsStore } from './settings/SettingsStore'

export const AUDIO_FILE_FILTERS = [{ name: 'Audio', extensions: ['mp3', 'wav', 'flac', 'm4a'] }]
const IMAGE_FILE_FILTERS = [
  { name: 'Images', extensions: ALLOWED_COVER_EXT.map((ext) => ext.slice(1)) }
]

export interface IpcDeps {
  store: LibraryStore
  importService: ImportService
  lyricsService: LyricsService
  searchKeyService: SearchKeyService
  settingsStore: SettingsStore
  tracksDir: string
  notify: (channel: string, payload: unknown) => void
  /** 배포 채널별 기능 플래그 (스펙 001 §4.3) */
  capabilities: AppCapabilities
  /** URL 임포트가 꺼진 실행(MSIX판·리소스 미배치)에서는 null */
  ytDlpService: YtDlpService | null
  trackEditService: TrackEditService
  coverService: CoverService
}

export function registerIpcHandlers({
  store,
  importService,
  lyricsService,
  searchKeyService,
  settingsStore,
  tracksDir,
  notify,
  capabilities,
  ytDlpService,
  trackEditService,
  coverService
}: IpcDeps): void {
  const importGate = new ImportRequestGate()

  // 렌더러가 cover.jpg 등 트랙 파일의 media:// URL을 만들 때 쓴다
  ipcMain.handle(IPC_CHANNELS.tracksDir, (): string => tracksDir)

  ipcMain.handle(IPC_CHANNELS.settingsGet, (): AppSettings => settingsStore.get())

  ipcMain.handle(IPC_CHANNELS.settingsSet, (_event, patch: Partial<AppSettings>): AppSettings => {
    if (
      patch.demucsModel !== undefined &&
      !DEMUCS_MODELS.some((model) => model.id === patch.demucsModel)
    ) {
      throw new Error(`unknown demucs model: ${patch.demucsModel}`)
    }
    return settingsStore.set(patch)
  })
  ipcMain.handle(IPC_CHANNELS.lyricsGet, (_event, trackId: string) =>
    lyricsService.getLyrics(trackId)
  )

  ipcMain.handle(IPC_CHANNELS.lyricsRefetch, (_event, trackId: string) => {
    const track = store.getTrack(trackId)
    if (!track) throw new Error(`track not found: ${trackId}`)
    return lyricsService.fetchAndStore(track)
  })

  ipcMain.handle(
    IPC_CHANNELS.lyricsAlign,
    (_event, trackId: string, text: string, lang: AlignLang, fromLrclibPlain: boolean) =>
      lyricsService.alignLyrics(trackId, text, lang, fromLrclibPlain)
  )

  ipcMain.handle(IPC_CHANNELS.lyricsTranscribe, (_event, trackId: string) =>
    lyricsService.transcribe(trackId)
  )

  ipcMain.handle(IPC_CHANNELS.lyricsSaveLines, (_event, trackId: string, lines: AlignedLine[]) =>
    lyricsService.saveLines(trackId, lines)
  )

  ipcMain.handle(IPC_CHANNELS.lyricsPronounce, (_event, trackId: string) =>
    lyricsService.pronounce(trackId)
  )

  ipcMain.handle(IPC_CHANNELS.lyricsReset, (_event, trackId: string) =>
    lyricsService.resetLyrics(trackId)
  )

  ipcMain.handle(IPC_CHANNELS.listTracks, (_event, query?: string): Track[] =>
    store.listTracks(query)
  )

  ipcMain.handle(IPC_CHANNELS.reorderTracks, (_event, ids: string[]): void => {
    store.reorderTracks(ids)
  })

  ipcMain.handle(IPC_CHANNELS.getTrackVolumes, (_event, trackId: string) =>
    store.getTrackVolumes(trackId)
  )
  ipcMain.handle(IPC_CHANNELS.setTrackVolumes, (_event, trackId: string, volumes: TrackVolumes) =>
    store.setTrackVolumes(trackId, volumes)
  )

  ipcMain.handle(IPC_CHANNELS.deleteTrack, async (_event, trackId: string): Promise<void> => {
    const track = store.getTrack(trackId)
    if (!track) return
    if (track.status === 'separating') {
      throw new Error('분리 작업 중인 트랙은 삭제할 수 없습니다')
    }
    coverService.noteUserCoverChange(trackId)
    await trackEditService.withTrackLock(trackId, async () => {
      if (!store.deleteTrack(trackId)) return
      await rm(join(tracksDir, trackId), { recursive: true, force: true })
    })
  })

  ipcMain.handle(
    IPC_CHANNELS.updateTrackMeta,
    (_event, trackId: string, meta: TrackMetaInput): Track => {
      const updated = store.updateMeta(trackId, meta)
      searchKeyService.refresh(updated)
      notify(IPC_CHANNELS.trackUpdated, updated)
      return updated
    }
  )

  ipcMain.handle(IPC_CHANNELS.saveTrackEdit, (_event, req: TrackEditSaveRequest): Promise<Track> =>
    trackEditService.save(req)
  )

  ipcMain.handle(IPC_CHANNELS.trackFiles, (_event, trackId: string): TrackFiles => {
    const track = store.getTrack(trackId)
    if (!track) throw new Error(`track not found: ${trackId}`)
    return requireReadyTrackFiles(tracksDir, track)
  })

  ipcMain.handle(
    IPC_CHANNELS.importFiles,
    (_event, filePaths: string[], userMeta?: ImportUserMeta): Promise<ImportFilesResponse> =>
      importGate.run(() =>
        importService.importFiles(filePaths, undefined, sanitizeImportUserMeta(userMeta))
      )
  )

  ipcMain.handle(IPC_CHANNELS.importDialog, async (): Promise<ImportFilesResponse> => {
    const { canceled, filePaths } = await dialog.showOpenDialog({
      properties: ['openFile', 'multiSelections'],
      filters: AUDIO_FILE_FILTERS
    })
    if (canceled || filePaths.length === 0) {
      return { imported: [], rejected: [] }
    }
    return importGate.run(() => importService.importFiles(filePaths))
  })

  ipcMain.handle(IPC_CHANNELS.pickAudioFile, async (): Promise<string | null> => {
    const { canceled, filePaths } = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: AUDIO_FILE_FILTERS
    })
    if (canceled || filePaths.length === 0) return null
    return filePaths[0]
  })

  ipcMain.handle(IPC_CHANNELS.pickImageFile, async (): Promise<string | null> => {
    const { canceled, filePaths } = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: IMAGE_FILE_FILTERS
    })
    if (canceled || filePaths.length === 0) return null
    return filePaths[0]
  })

  ipcMain.handle(IPC_CHANNELS.previewCover, (_event, filePath: string): Promise<string | null> =>
    previewCoverDataUrl(filePath)
  )

  ipcMain.handle(
    IPC_CHANNELS.previewCoverDetailed,
    (_event, filePath: string): Promise<CoverPreviewResult> => previewCoverDetailed(filePath)
  )

  ipcMain.handle(
    IPC_CHANNELS.probeAudioTags,
    (_event, filePath: string): Promise<AudioTagPreview> => importService.probeTags(filePath)
  )

  // 등록 전 실패(검증·prepare·DB)는 rejected로만 돌리고 appError를 올리지 않는다.
  // 팝업이 열린 채 입력을 보존하므로 오류 센터에 중복하지 않는다 (스펙 004 §4.2).
  // 등록 후 부가 작업(가사·분석 등) 실패는 각 서비스가 appError를 보낸다.
  ipcMain.handle(
    IPC_CHANNELS.importPair,
    (_event, req: PairImportRequest): Promise<ImportFilesResponse> => {
      const user = sanitizeImportUserMeta(req)
      return importGate.run(() =>
        importService.importPair({
          ...req,
          title: user?.title,
          artist: user?.artist,
          coverPath: user?.coverPath
        })
      )
    }
  )

  // 스펙 001 §4.3: 렌더러는 이 플래그가 false면 URL 임포트 UI를 아예 그리지 않는다 (기준 6)
  ipcMain.handle(IPC_CHANNELS.capabilities, (): AppCapabilities => capabilities)

  // 오류 센터 이슈 보고용 환경 정보
  ipcMain.handle(IPC_CHANNELS.appInfo, (): AppInfo => ({
    version: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
    electron: process.versions.electron
  }))

  // 외부 브라우저로 열기. 렌더러가 넘긴 값은 https만 허용한다 (file:// 등 차단)
  ipcMain.handle(IPC_CHANNELS.openExternal, async (_event, url: string): Promise<void> => {
    if (!/^https:\/\//i.test(url)) throw new Error(`refusing to open non-https url: ${url}`)
    await shell.openExternal(url)
  })

  ipcMain.handle(
    IPC_CHANNELS.importUrl,
    (_event, url: string, userMeta?: ImportUserMeta): Promise<ImportFilesResponse> => {
      const service = ytDlpService
      const precheck = precheckImportUrl(url, Boolean(capabilities.urlImport && service))
      if (precheck.action === 'reject') return Promise.resolve(precheck.response)
      if (!service) {
        return Promise.resolve({
          imported: [],
          rejected: [{ filePath: url, reason: URL_IMPORT_DISABLED_REASON }]
        })
      }
      return importGate.run(() => service.importUrl(precheck.url, sanitizeImportUserMeta(userMeta)))
    }
  )
}

async function previewCoverDataUrl(filePath: string): Promise<string | null> {
  const result = await previewCoverDetailed(filePath)
  return result.ok ? result.dataUrl : null
}

async function previewCoverDetailed(filePath: string): Promise<CoverPreviewResult> {
  const inspected = await inspectCoverImage(filePath)
  if (!inspected.ok) return inspected
  const image = nativeImage.createFromPath(filePath)
  if (image.isEmpty()) return { ok: false, message: '커버 이미지를 읽을 수 없습니다' }
  return { ok: true, dataUrl: image.resize({ width: 128, height: 128 }).toDataURL() }
}
