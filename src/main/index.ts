import { app, shell, BrowserWindow, ipcMain, net, protocol } from 'electron'
import { existsSync } from 'fs'
import { join, resolve, sep } from 'path'
import { pathToFileURL } from 'url'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { IPC_CHANNELS, MEDIA_PROTOCOL_SCHEME } from '../shared/types'
import type { BootstrapState } from '../shared/types'
import { registerIpcHandlers } from './ipc'
import { AnalysisService } from './library/AnalysisService'
import { CoverService } from './library/CoverService'
import { ImportService } from './library/ImportService'
import { JobQueue } from './library/JobQueue'
import { LibraryStore } from './library/LibraryStore'
import { recoverIncompleteTrackEdits } from './library/coverRecovery'
import { recoverIncompletePairImports } from './library/pairRecovery'
import { SearchKeyService } from './library/SearchKeyService'
import { TrackEditService } from './library/TrackEditService'
import { YtDlpService, hasUrlImportBinaries } from './library/YtDlpService'
import { getBundledBinary, getBundledSidecarDir } from './paths'
import { SettingsStore } from './settings/SettingsStore'
import { LyricsService } from './lyrics/LyricsService'
import { SidecarBootstrap, buildUvEnv, createReadyBootstrap } from './sidecar/SidecarBootstrap'
import type { BootstrapController } from './sidecar/SidecarBootstrap'
import { SidecarManager, createUvSidecarManager } from './sidecar/SidecarManager'

// AudioEngine이 fetch로 스템 파일을 읽는 통로 (§4.1). app ready 전에 등록해야 한다.
// dev 렌더러는 http://localhost origin이라 교차 출처 fetch가 되므로 CORS 응답까지 필요하다.
protocol.registerSchemesAsPrivileged([
  {
    scheme: MEDIA_PROTOCOL_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
      bypassCSP: true
    }
  }
])

/** media:// 요청을 tracks 디렉토리 밑 파일로 제한해서 서빙한다 */
function registerMediaProtocol(tracksDir: string): void {
  const root = resolve(tracksDir)
  const cors = { 'Access-Control-Allow-Origin': '*' }
  protocol.handle(MEDIA_PROTOCOL_SCHEME, async (request) => {
    const raw = new URL(request.url).searchParams.get('path')
    const filePath = raw ? resolve(raw) : null
    if (!filePath || !filePath.startsWith(root + sep)) {
      return new Response('forbidden', { status: 403, headers: cors })
    }
    // 커버 미추출 등 파일이 없는 경우는 정상 흐름 — 에러 로그 없이 404로 응답
    if (!existsSync(filePath)) {
      return new Response('not found', { status: 404, headers: cors })
    }
    const fileResponse = await net.fetch(pathToFileURL(filePath).toString())
    const headers = new Headers(fileResponse.headers)
    headers.set('Access-Control-Allow-Origin', '*')
    return new Response(fileResponse.body, { status: fileResponse.status, headers })
  })
}

/**
 * 사이드카 실행 경로 분기 (스펙 001 §4.1).
 * - 패키징: 번들 uv.exe로 <userData>/sidecar 를 실행. 환경 구성은 SidecarBootstrap이 보장하므로
 *   매 워커 실행은 `--no-sync`로 네트워크·lock 검사 없이 venv만 쓴다.
 * - dev: 레포의 sidecar/ 를 PATH의 uv로 실행하고 부트스트랩은 건너뛴다 (기준 8).
 */
function createSidecar(userData: string): {
  sidecar: SidecarManager
  bootstrap: BootstrapController
} {
  if (!app.isPackaged) {
    return {
      sidecar: createUvSidecarManager(join(app.getAppPath(), 'sidecar')),
      bootstrap: createReadyBootstrap()
    }
  }
  const uvCommand = getBundledBinary('uv')
  const targetSidecarDir = join(userData, 'sidecar')
  const env = buildUvEnv(userData)
  const onLog = (line: string): void => console.error(`[bootstrap] ${line}`)
  return {
    sidecar: new SidecarManager({
      command: uvCommand,
      baseArgs: ['run', '--project', targetSidecarDir, '--no-sync', 'karaoke_worker'],
      env
    }),
    bootstrap: new SidecarBootstrap({
      bundledSidecarDir: getBundledSidecarDir(),
      targetSidecarDir,
      uvCommand,
      env,
      onLog
    })
  }
}

function createWindow(): void {
  // Create the browser window.
  const mainWindow = new BrowserWindow({
    title: 'Karaoke Player',
    width: 1200,
    height: 760,
    minWidth: 1040,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // HMR for renderer base on electron-vite cli.
  // Load the remote URL for development or the local html file for production.
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.whenReady().then(async () => {
  // Set app user model id for windows
  electronApp.setAppUserModelId('com.mintonnee.karaoke-player')

  // Default open or close DevTools by F12 in development
  // and ignore CommandOrControl + R in production.
  // see https://github.com/alex8088/electron-toolkit/tree/master/packages/utils
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  const userData = app.getPath('userData')
  const { sidecar, bootstrap } = createSidecar(userData)

  const store = new LibraryStore(join(userData, 'library.sqlite'))
  const stale = store.failStaleSeparating()
  if (stale > 0) console.error(`[library] marked ${stale} stale separating track(s) as failed`)

  const tracksDir = join(userData, 'tracks')
  const cleanedPairs = await recoverIncompletePairImports(tracksDir, store)
  if (cleanedPairs > 0) {
    console.error(`[library] cleaned ${cleanedPairs} incomplete pair import dir(s)`)
  }
  const cleanedEdits = await recoverIncompleteTrackEdits(tracksDir, store)
  if (cleanedEdits > 0) {
    console.error(`[library] recovered ${cleanedEdits} incomplete track edit(s)`)
  }
  registerMediaProtocol(tracksDir)

  const notify = (channel: string, payload: unknown): void => {
    BrowserWindow.getAllWindows().forEach((window) => window.webContents.send(channel, payload))
  }
  // 분리/정렬/전사(GPU 작업)를 하나의 큐로 직렬화한다 (§4)
  const jobQueue = new JobQueue((error) => {
    console.error('[jobs]', error)
    notify(IPC_CHANNELS.appError, {
      source: 'jobs',
      message: error instanceof Error ? error.message : String(error),
      at: new Date().toISOString()
    })
  })
  const lyricsService = new LyricsService({
    store,
    sidecar,
    queue: jobQueue,
    tracksDir,
    userAgent: `karaoke-player/${app.getVersion()} (local desktop app)`,
    notify
  })
  const searchKeyService = new SearchKeyService({
    store,
    sidecar,
    workDir: join(userData, 'tmp')
  })
  const settingsStore = new SettingsStore(join(userData, 'settings.json'))
  const coverService = new CoverService({ store, sidecar, tracksDir })
  const trackEditService = new TrackEditService({
    store,
    tracksDir,
    coverService,
    searchKeyService,
    notify
  })
  // BPM·키 분석은 분리와 같은 큐에서 직렬로 돈다 (스펙 002 §4.2)
  const analysisService = new AnalysisService({
    store,
    sidecar,
    queue: jobQueue,
    tracksDir,
    notify
  })
  const importService = new ImportService({
    store,
    sidecar,
    queue: jobQueue,
    tracksDir,
    maxDurationSec: parsePositiveInt(process.env.KARAOKE_MAX_DURATION_SEC, 900),
    getDemucsModel: () => settingsStore.get().demucsModel,
    notify,
    fetchLyrics: (track) => lyricsService.fetchAndStore(track),
    refreshSearchKeys: (track) => searchKeyService.refresh(track),
    extractCover: (track) => coverService.refresh(track),
    analyze: (track) => analysisService.refresh(track.id)
  })
  // URL 임포트는 zip판에만 동봉되는 yt-dlp.exe·deno.exe 존재로 켜고 끈다 (스펙 001 §4.3, 기준 6)
  const ytDlpPath = getBundledBinary('yt-dlp')
  const denoPath = getBundledBinary('deno')
  const urlImport = hasUrlImportBinaries(ytDlpPath, denoPath)
  const ytDlpService = urlImport
    ? new YtDlpService({
        command: ytDlpPath,
        denoPath,
        scratchRoot: join(userData, 'tmp', 'url-import'),
        tracksDir,
        importFiles: (filePaths, hint, userMeta) =>
          importService.importFiles(filePaths, hint, userMeta),
        notify,
        // 커버를 덮어쓴 뒤 updatedAt을 갱신해야 렌더러의 media:// 캐시 키가 바뀐다
        touchTrack: (track) =>
          store.updateMeta(track.id, {
            title: track.title,
            artist: track.artist,
            album: track.album
          })
      })
    : null

  registerIpcHandlers({
    store,
    importService,
    lyricsService,
    searchKeyService,
    settingsStore,
    tracksDir,
    notify,
    capabilities: { urlImport },
    ytDlpService,
    trackEditService,
    coverService
  })
  // 부트스트랩 IPC. 서비스들은 lazy spawn이라 먼저 만들어도 되지만,
  // 시작 시 사이드카를 띄우는 backfill은 ready 이후에만 돈다.
  ipcMain.handle(IPC_CHANNELS.bootstrapGet, (): BootstrapState => bootstrap.getState())
  ipcMain.handle(IPC_CHANNELS.bootstrapRetry, (): Promise<BootstrapState> => bootstrap.retry())
  bootstrap.onChange((state) => notify(IPC_CHANNELS.bootstrapState, state))
  void bootstrap.whenReady().then(() => {
    // 기존 트랙의 일본어 메타 발음 키·앨범 커버·BPM·키 분석을 백그라운드로 채운다
    searchKeyService.backfill()
    coverService.backfill()
    analysisService.backfill()
  })
  void bootstrap.start()
  app.on('will-quit', () => {
    bootstrap.dispose()
    ytDlpService?.dispose()
    store.close()
  })

  createWindow()

  app.on('activate', function () {
    // On macOS it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}
