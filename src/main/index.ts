import { app, shell, BrowserWindow, net, protocol } from 'electron'
import { join, resolve, sep } from 'path'
import { pathToFileURL } from 'url'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { MEDIA_PROTOCOL_SCHEME } from '../shared/types'
import { registerIpcHandlers } from './ipc'
import { ImportService } from './library/ImportService'
import { JobQueue } from './library/JobQueue'
import { LibraryStore } from './library/LibraryStore'
import { SearchKeyService } from './library/SearchKeyService'
import { LyricsService } from './lyrics/LyricsService'
import { createUvSidecarManager } from './sidecar/SidecarManager'

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
    const fileResponse = await net.fetch(pathToFileURL(filePath).toString())
    const headers = new Headers(fileResponse.headers)
    headers.set('Access-Control-Allow-Origin', '*')
    return new Response(fileResponse.body, { status: fileResponse.status, headers })
  })
}

function createWindow(): void {
  // Create the browser window.
  const mainWindow = new BrowserWindow({
    width: 1200,
    height: 760,
    minWidth: 960,
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
app.whenReady().then(() => {
  // Set app user model id for windows
  electronApp.setAppUserModelId('com.mgkwak.karaoke-player')

  // Default open or close DevTools by F12 in development
  // and ignore CommandOrControl + R in production.
  // see https://github.com/alex8088/electron-toolkit/tree/master/packages/utils
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  // 패키징 시 사이드카 경로는 S7에서 재정의한다. dev에서는 레포 루트의 sidecar/를 사용.
  const sidecar = createUvSidecarManager(join(app.getAppPath(), 'sidecar'))

  const userData = app.getPath('userData')
  const store = new LibraryStore(join(userData, 'library.sqlite'))
  const stale = store.failStaleSeparating()
  if (stale > 0) console.error(`[library] marked ${stale} stale separating track(s) as failed`)

  const tracksDir = join(userData, 'tracks')
  registerMediaProtocol(tracksDir)

  const notify = (channel: string, payload: unknown): void => {
    BrowserWindow.getAllWindows().forEach((window) => window.webContents.send(channel, payload))
  }
  // 분리/정렬/전사(GPU 작업)를 하나의 큐로 직렬화한다 (§4)
  const jobQueue = new JobQueue((error) => console.error('[jobs]', error))
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
  const importService = new ImportService({
    store,
    sidecar,
    queue: jobQueue,
    tracksDir,
    maxDurationSec: parsePositiveInt(process.env.KARAOKE_MAX_DURATION_SEC, 900),
    demucsModel: process.env.KARAOKE_DEMUCS_MODEL ?? 'htdemucs_ft',
    notify,
    fetchLyrics: (track) => lyricsService.fetchAndStore(track),
    refreshSearchKeys: (track) => searchKeyService.refresh(track)
  })
  registerIpcHandlers({ store, importService, lyricsService, searchKeyService, tracksDir, notify })
  // 기존 트랙의 일본어 메타 발음 키를 백그라운드로 채운다
  searchKeyService.backfill()
  app.on('will-quit', () => store.close())

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
