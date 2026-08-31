import { app, shell, BrowserWindow } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { registerIpcHandlers } from './ipc'
import { ImportService } from './library/ImportService'
import { LibraryStore } from './library/LibraryStore'
import { createUvSidecarManager } from './sidecar/SidecarManager'

function createWindow(): void {
  // Create the browser window.
  const mainWindow = new BrowserWindow({
    width: 900,
    height: 670,
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

  const importService = new ImportService({
    store,
    sidecar,
    tracksDir: join(userData, 'tracks'),
    maxDurationSec: parsePositiveInt(process.env.KARAOKE_MAX_DURATION_SEC, 900),
    demucsModel: process.env.KARAOKE_DEMUCS_MODEL ?? 'htdemucs_ft',
    notify: (channel, payload) => {
      BrowserWindow.getAllWindows().forEach((window) => window.webContents.send(channel, payload))
    }
  })
  registerIpcHandlers({ store, importService })
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
