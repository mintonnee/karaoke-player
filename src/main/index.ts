import { app, dialog, shell, BrowserWindow, ipcMain, nativeImage, net, protocol } from 'electron'
import { existsSync, readFileSync } from 'fs'
import { join, resolve, sep } from 'path'
import { pathToFileURL } from 'url'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { isRuntimeActionAllowed } from '../shared/bootstrap'
import { TOOL_IDS, type ToolReadinessSnapshot } from '../shared/runtimeTools'
import {
  IPC_CHANNELS,
  MEDIA_PROTOCOL_SCHEME,
  isRegisteredDemucsModel,
  modelIdForWorker,
  type BootstrapPrepStage,
  type BootstrapState
} from '../shared/types'
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
import { YoutubePreviewService } from './library/YoutubePreviewService'
import { YtDlpService, urlImportAvailability } from './library/YtDlpService'
import { getBundledBinary, getBundledSidecarDir } from './paths'
import {
  ensureArtifact,
  findArtifact,
  resolveSelectedRuntime,
  runtimeCacheRoot,
  verifyExistingFile,
  ToolReadinessController,
  type LockFile,
  type RuntimeLockSet,
  type RuntimeManifest
} from './runtime'
import { artifactsForModel } from './runtime/modelArtifacts'
import { SettingsStore } from './settings/SettingsStore'
import { LyricsService } from './lyrics/LyricsService'
import { SidecarBootstrap, buildUvEnv, createReadyBootstrap } from './sidecar/SidecarBootstrap'
import type { BootstrapController } from './sidecar/SidecarBootstrap'
import {
  SidecarManager,
  createUvSidecarManager,
  buildRuntimeSidecarOptions,
  type SidecarRunOptions
} from './sidecar/SidecarManager'
import { ensureSingleInstance, runAppStartup } from './startup'
import type { LibraryReadyContext } from './startup'

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

function readJsonFile<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T
}

function loadLockSet(locksDir: string): RuntimeLockSet {
  return {
    tools: readJsonFile(join(locksDir, 'tools.lock.json')),
    python: readJsonFile(join(locksDir, 'python.lock.json')),
    wheels: readJsonFile(join(locksDir, 'wheels.lock.json')),
    models: readJsonFile(join(locksDir, 'models.lock.json'))
  }
}

function exeHashSpec(
  lock: LockFile,
  id: string,
  exeName: string
): { sha256: string; size: number; id: string } {
  const art = findArtifact(lock, id)
  if (art.kind === 'archive') {
    const member = art.archive?.files.find((file) => {
      const dest = (file.dest ?? file.path).replaceAll('\\', '/')
      return file.path.endsWith(exeName) || dest.endsWith(exeName)
    })
    if (!member) throw new Error(`lock archive missing ${exeName} for ${id}`)
    return { sha256: member.sha256, size: member.size, id }
  }
  return { sha256: art.sha256, size: art.size, id }
}

function enrichBootstrapState(state: BootstrapState): BootstrapState {
  const stage: BootstrapPrepStage | null =
    state.stage ??
    (state.status === 'copying'
      ? 'download'
      : state.status === 'syncing'
        ? 'env-prep'
        : state.status === 'download' ||
            state.status === 'verify' ||
            state.status === 'env-prep' ||
            state.status === 'model-prep'
          ? state.status
          : null)
  return {
    ...state,
    stage,
    logicalId: state.logicalId ?? null,
    retryable: state.retryable === true
  }
}

function createBlockedBootstrap(state: BootstrapState): BootstrapController {
  return {
    getState: () => state,
    onChange: () => () => {},
    start: () => Promise.resolve(state),
    retry: () => Promise.resolve(state),
    whenReady: () => new Promise(() => {}),
    dispose: () => {}
  }
}

class OverlayBootstrap implements BootstrapController {
  private overlay: Partial<BootstrapState> | null = null
  private readonly listeners = new Set<(state: BootstrapState) => void>()
  private readonly unsubInner: () => void

  constructor(private readonly inner: BootstrapController) {
    this.unsubInner = inner.onChange(() => this.emit())
  }

  getState(): BootstrapState {
    const base = enrichBootstrapState(this.inner.getState())
    return this.overlay ? enrichBootstrapState({ ...base, ...this.overlay }) : base
  }

  onChange(listener: (state: BootstrapState) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  start(): Promise<BootstrapState> {
    return this.inner.start()
  }

  retry(): Promise<BootstrapState> {
    return this.inner.retry()
  }

  whenReady(): Promise<void> {
    return this.inner.whenReady()
  }

  dispose(): void {
    this.unsubInner()
    this.inner.dispose()
  }

  setOverlay(patch: Partial<BootstrapState> | null): void {
    this.overlay = patch
    this.emit()
  }

  private emit(): void {
    const state = this.getState()
    for (const listener of this.listeners) listener(state)
  }
}

function applyModelEnv(opts: {
  lockPath: string | null
  modelsDir: string
  demucsModel: string
}): void {
  if (opts.lockPath) process.env.KARAOKE_MODELS_LOCK = opts.lockPath
  process.env.KARAOKE_MODELS_DIR = opts.modelsDir
  process.env.KARAOKE_WHISPER_MODEL = 'large-v3-turbo'
  if (isRegisteredDemucsModel(opts.demucsModel)) {
    process.env.KARAOKE_DEMUCS_MODEL = opts.demucsModel
  }
}

/**
 * 사이드카 실행 경로 분기 (스펙 001 §4.1, 008 §4.5).
 * - 패키징: 번들 manifest+lock으로 환경을 준비한 뒤 검증된 venv python 으로 worker 실행.
 * - dev: 레포 sidecar/ 를 PATH의 uv로 실행하고 부트스트랩은 건너뛴다 (001 기준 8).
 */
function createSidecar(
  userData: string,
  getDemucsModel: () => string,
  onManifestVerified: () => void
): {
  sidecar: SidecarManager
  bootstrap: OverlayBootstrap
  attachPackagedRuntime: () => Promise<void>
  toolsLock: LockFile | null
  modelsLock: LockFile | null
  modelsDir: string
  cacheRoot: string
  tools: ToolReadinessController | null
  urlImport: boolean
} {
  const modelsDir = runtimeCacheRoot(userData)
  const cacheRoot = modelsDir
  const repoModelsLock = join(app.getAppPath(), 'build', 'locks', 'models.lock.json')
  const onLog = (line: string): void => console.error(`[bootstrap] ${line}`)
  const holder: { current: SidecarManager | null } = { current: null }

  if (!app.isPackaged) {
    const lockPath = existsSync(repoModelsLock) ? repoModelsLock : null
    applyModelEnv({ lockPath, modelsDir, demucsModel: getDemucsModel() })
    holder.current = createUvSidecarManager(join(app.getAppPath(), 'sidecar'))
    const modelsLock = lockPath ? readJsonFile<LockFile>(lockPath) : null
    const toolsLockPath = join(app.getAppPath(), 'build', 'locks', 'tools.lock.json')
    const toolsLock = existsSync(toolsLockPath) ? readJsonFile<LockFile>(toolsLockPath) : null
    const bootstrap = new OverlayBootstrap(createReadyBootstrap())
    return {
      sidecar: wrapSidecarRun(holder, {
        bootstrap,
        getDemucsModel,
        modelsLock,
        modelsDir,
        cacheRoot
      }),
      bootstrap,
      attachPackagedRuntime: async () => undefined,
      toolsLock,
      modelsLock,
      modelsDir,
      cacheRoot,
      tools: null,
      urlImport: false
    }
  }

  const targetSidecarDir = join(userData, 'sidecar')
  const uvEnv = buildUvEnv(userData)
  const manifestPath = join(process.resourcesPath, 'runtime-manifest.json')
  const locksDir = join(process.resourcesPath, 'locks')
  let manifest: RuntimeManifest | null = null
  let locks: RuntimeLockSet | null = null
  try {
    manifest = readJsonFile<RuntimeManifest>(manifestPath)
    locks = loadLockSet(locksDir)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`[bootstrap] failed to load runtime manifest: ${message}`)
  }
  const modelsLock = locks?.models ?? null
  const toolsLock = locks?.tools ?? null
  const lockPath = existsSync(join(locksDir, 'models.lock.json'))
    ? join(locksDir, 'models.lock.json')
    : null
  applyModelEnv({ lockPath, modelsDir, demucsModel: getDemucsModel() })

  let tools: ToolReadinessController | null = null
  if (manifest && toolsLock) {
    try {
      tools = new ToolReadinessController({
        manifest,
        toolsLock,
        userDataDir: userData,
        resourcesDir: process.resourcesPath,
        windowsStore: process.windowsStore === true
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error(`[bootstrap] tool policy invalid: ${message}`)
    }
  }

  const inner: BootstrapController =
    manifest && locks && tools
      ? new SidecarBootstrap({
          bundledSidecarDir: getBundledSidecarDir(),
          targetSidecarDir,
          prepareUv: (signal) => tools!.ensure('uv', { signal }),
          onManifestVerified,
          env: uvEnv,
          onLog,
          userDataDir: userData,
          manifest,
          locks
        })
      : createBlockedBootstrap({
          status: 'error',
          message: '사이드카 환경 구성 실패',
          error: 'bundled runtime-manifest.json 또는 lock이 없습니다',
          stage: 'verify',
          logicalId: 'runtime-manifest',
          retryable: false,
          log: []
        })
  const bootstrap = new OverlayBootstrap(inner)

  const attachPackagedRuntime = async (): Promise<void> => {
    if (!manifest || holder.current) return
    const runtimeDir = await resolveSelectedRuntime(userData, manifest)
    const launch = buildRuntimeSidecarOptions(runtimeDir, { manifest })
    const env: NodeJS.ProcessEnv = {
      ...launch.env,
      KARAOKE_MODELS_LOCK: lockPath ?? '',
      KARAOKE_MODELS_DIR: modelsDir,
      KARAOKE_WHISPER_MODEL: 'large-v3-turbo'
    }
    delete env.KARAOKE_DEMUCS_MODEL
    holder.current = new SidecarManager({
      command: launch.command,
      baseArgs: launch.baseArgs,
      env,
      onLog: (line) => console.error(`[sidecar] ${line}`)
    })
  }

  return {
    sidecar: wrapSidecarRun(holder, {
      bootstrap,
      getDemucsModel,
      modelsLock,
      modelsDir,
      cacheRoot,
      attach: attachPackagedRuntime
    }),
    bootstrap,
    attachPackagedRuntime,
    toolsLock,
    modelsLock,
    modelsDir,
    cacheRoot,
    tools,
    urlImport: tools !== null && manifest?.capabilities.urlImport === true
  }
}

function wrapSidecarRun(
  holder: { current: SidecarManager | null },
  opts: {
    bootstrap: OverlayBootstrap
    getDemucsModel: () => string
    modelsLock: LockFile | null
    modelsDir: string
    cacheRoot: string
    attach?: () => Promise<void>
  }
): SidecarManager {
  let modelPrepDepth = 0
  const run = async (workerArgs: string[], runOptions?: SidecarRunOptions): Promise<unknown> => {
    const state = opts.bootstrap.getState()
    if (!isRuntimeActionAllowed(state)) {
      throw new Error(
        `${state.error ?? state.message} (id=${state.logicalId ?? 'runtime'}, stage=${state.stage ?? state.status}, retryable=${state.retryable !== false})`
      )
    }
    if (!holder.current && opts.attach) await opts.attach()
    const manager = holder.current
    if (!manager) throw new Error('runtime python is not attached')
    const command = workerArgs[0] ?? ''
    const demucsModel = opts.getDemucsModel()
    if (command === 'separate' && !isRegisteredDemucsModel(demucsModel)) {
      throw new Error(`unknown demucs model: ${demucsModel}`)
    }
    const modelId = modelIdForWorker(command, demucsModel)
    if (modelId && opts.modelsLock) {
      modelPrepDepth += 1
      opts.bootstrap.setOverlay({
        status: 'model-prep',
        stage: 'model-prep',
        message: `모델 준비 중 (${modelId})`,
        logicalId: modelId,
        retryable: false,
        error: null
      })
      try {
        process.env.KARAOKE_DEMUCS_MODEL = demucsModel
        const artifacts = artifactsForModel(opts.modelsLock, modelId)
        for (const artifact of artifacts) {
          await ensureArtifact({
            artifact,
            destRoot: opts.modelsDir,
            cacheRoot: opts.cacheRoot
          })
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        throw new Error(`${message} (id=${modelId}, stage=model-prep, retryable=false)`)
      } finally {
        modelPrepDepth -= 1
        if (modelPrepDepth === 0) opts.bootstrap.setOverlay(null)
      }
    }
    return manager.run(workerArgs, runOptions)
  }
  return { run } as unknown as SidecarManager
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

function focusExistingMainWindow(): void {
  const win = BrowserWindow.getAllWindows()[0]
  if (!win) return
  if (win.isMinimized()) win.restore()
  win.focus()
}

function wireReadyLibrary(ctx: LibraryReadyContext<LibraryStore>): BootstrapController {
  const { store, userData, tracksDir } = ctx
  const settingsStore = new SettingsStore(join(userData, 'settings.json'))
  let startTools = (): void => {}
  let toolsAllowed = false
  let disposed = false
  const {
    sidecar,
    bootstrap,
    attachPackagedRuntime,
    toolsLock,
    tools,
    urlImport: packagedUrlImport
  } = createSidecar(
    userData,
    () => settingsStore.get().demucsModel,
    () => {
      toolsAllowed = true
      startTools()
    }
  )
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
  // 배포 기능 지원 여부와 다운로드 완료 여부는 별도 계약이다.
  const appx = process.windowsStore === true
  const availability = urlImportAvailability({
    ytDlpExists: existsSync(getBundledBinary('yt-dlp')),
    denoExists: existsSync(getBundledBinary('deno')),
    appx
  })
  const urlImport = app.isPackaged ? packagedUrlImport : availability.urlImport
  let ytDlpService: YtDlpService | null = null
  let previewService: YoutubePreviewService | null = null
  const paths: Partial<Record<'deno' | 'yt-dlp', string>> = {}
  let activePaths = ''
  const activateUrlServices = (): void => {
    if (disposed || !urlImport || !paths.deno || !paths['yt-dlp']) return
    const key = JSON.stringify(paths)
    if (key === activePaths) return
    const ytDlpHash = toolsLock ? exeHashSpec(toolsLock, 'yt-dlp', 'yt-dlp.exe') : undefined
    const denoHash = toolsLock ? exeHashSpec(toolsLock, 'deno', 'deno.exe') : undefined
    const common = {
      command: paths['yt-dlp'],
      denoPath: paths.deno,
      ytDlpHash,
      denoHash,
      verifyCommand: toolsLock ? verifyExistingFile : undefined
    }
    ytDlpService?.dispose()
    previewService?.dispose()
    ytDlpService = new YtDlpService({
      ...common,
      scratchRoot: join(userData, 'tmp', 'url-import'),
      tracksDir,
      importFiles: (filePaths, hint, userMeta) =>
        importService.importFiles(filePaths, hint, userMeta),
      notify,
      touchTrack: (track) =>
        store.updateMeta(track.id, {
          title: track.title,
          artist: track.artist,
          album: track.album
        })
    })
    previewService = new YoutubePreviewService({
      ...common,
      enabled: true,
      encodeThumbnail: encodeYoutubePreviewThumbnail
    })
    activePaths = key
  }
  const staticSnapshot: ToolReadinessSnapshot = {
    tools: Object.fromEntries(
      TOOL_IDS.map((toolId) => [
        toolId,
        {
          toolId,
          status: app.isPackaged ? 'error' : toolId === 'uv' || urlImport ? 'ready' : 'disabled',
          downloadedBytes: null,
          totalBytes: null,
          error: app.isPackaged ? '런타임 manifest 검증에 실패했습니다' : null,
          retryable: false
        }
      ])
    ) as ToolReadinessSnapshot['tools']
  }
  const getToolReadiness = (): ToolReadinessSnapshot =>
    app.isPackaged && !toolsAllowed && bootstrap.getState().status === 'error'
      ? staticSnapshot
      : (tools?.getSnapshot() ?? staticSnapshot)
  const prepareUrlTool = async (id: 'deno' | 'yt-dlp'): Promise<void> => {
    if (!tools || disposed) return
    try {
      const path = await tools.ensure(id)
      if (disposed) return
      paths[id] = path
      activateUrlServices()
    } catch {
      // 개별 오류/재시도 가능 여부는 controller 상태 이벤트로 전달한다.
    }
  }
  let startedTools = false
  startTools = (): void => {
    if (startedTools || disposed || !tools) return
    startedTools = true
    queueMicrotask(() => {
      if (disposed) return
      void prepareUrlTool('deno')
      if (urlImport) void prepareUrlTool('yt-dlp')
    })
  }
  if (!app.isPackaged && urlImport) {
    paths.deno = getBundledBinary('deno')
    paths['yt-dlp'] = getBundledBinary('yt-dlp')
    activateUrlServices()
  }
  const unsubscribeTools = tools?.onChange((state) =>
    notify(IPC_CHANNELS.toolReadinessState, state)
  )

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
    previewService,
    trackEditService,
    coverService,
    analysisService,
    getBootstrapState: () => bootstrap.getState(),
    getUrlServices: () => ({ ytDlpService, previewService }),
    getToolReadiness,
    retryToolReadiness: async (id) => {
      if (!tools || !toolsAllowed || disposed) return getToolReadiness()
      try {
        const path = await tools.retry(id)
        if (!disposed) {
          if (id === 'uv' && bootstrap.getState().status === 'error') {
            void bootstrap.retry()
          } else if (id !== 'uv') {
            paths[id] = path
            activateUrlServices()
          }
        }
      } catch {
        // 실패 상태도 snapshot으로 반환하여 다른 도구 상태를 보존한다.
      }
      return getToolReadiness()
    }
  })
  // 부트스트랩 IPC. 서비스들은 lazy spawn이라 먼저 만들어도 되지만,
  // 시작 시 사이드카를 띄우는 backfill은 ready 이후에만 돈다.
  ipcMain.handle(IPC_CHANNELS.bootstrapGet, (): BootstrapState => bootstrap.getState())
  ipcMain.handle(IPC_CHANNELS.bootstrapRetry, (): Promise<BootstrapState> => bootstrap.retry())
  bootstrap.onChange((state) => {
    notify(IPC_CHANNELS.bootstrapState, state)
    if (!toolsAllowed && state.status === 'error') {
      for (const tool of Object.values(getToolReadiness().tools)) {
        notify(IPC_CHANNELS.toolReadinessState, tool)
      }
    }
  })
  void bootstrap.whenReady().then(async () => {
    if (disposed) return
    await attachPackagedRuntime()
    if (disposed) return
    // 기존 트랙의 일본어 메타 발음 키·앨범 커버·BPM·키 분석을 백그라운드로 채운다
    searchKeyService.backfill()
    coverService.backfill()
    analysisService.backfill()
  })
  app.on('will-quit', () => {
    disposed = true
    unsubscribeTools?.()
    tools?.dispose()
    bootstrap.dispose()
    ytDlpService?.dispose()
    previewService?.dispose()
    store.close()
  })
  return bootstrap
}

async function startPrimaryInstance(): Promise<void> {
  // Set app user model id for windows
  electronApp.setAppUserModelId('com.mintonnee.karaoke-player')

  // Default open or close DevTools by F12 in development
  // and ignore CommandOrControl + R in production.
  // see https://github.com/alex8088/electron-toolkit/tree/master/packages/utils
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  let bootstrap: BootstrapController | undefined
  await runAppStartup({
    app,
    dialog,
    shell,
    LibraryStore,
    skipSingleInstanceCheck: true,
    failStaleSeparating: (store) => {
      const stale = store.failStaleSeparating()
      if (stale > 0) console.error(`[library] marked ${stale} stale separating track(s) as failed`)
      return stale
    },
    recoverIncompletePairImports: async (tracksDir, store) => {
      const cleanedPairs = await recoverIncompletePairImports(tracksDir, store)
      if (cleanedPairs > 0) {
        console.error(`[library] cleaned ${cleanedPairs} incomplete pair import dir(s)`)
      }
      return cleanedPairs
    },
    recoverIncompleteTrackEdits: async (tracksDir, store) => {
      const cleanedEdits = await recoverIncompleteTrackEdits(tracksDir, store)
      if (cleanedEdits > 0) {
        console.error(`[library] recovered ${cleanedEdits} incomplete track edit(s)`)
      }
      return cleanedEdits
    },
    registerIpc: (ctx) => {
      bootstrap = wireReadyLibrary(ctx)
    },
    startSidecar: () => {
      void bootstrap?.start()
    },
    createWindow: () => {
      createWindow()
      app.on('activate', function () {
        // On macOS it's common to re-create a window in the app when the
        // dock icon is clicked and there are no other windows open.
        if (BrowserWindow.getAllWindows().length === 0) createWindow()
      })
    }
  })
}

// 단일 인스턴스 잠금은 DB 준비보다 먼저. 두 번째 프로세스는 라이브러리를 열지 않는다.
if (ensureSingleInstance(app, focusExistingMainWindow)) {
  app.whenReady().then(() => startPrimaryInstance())
}

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

function encodeYoutubePreviewThumbnail(
  bytes: Buffer,
  _width: number,
  _height: number
): string | null {
  // nativeImage.createFromBuffer는 JPEG/PNG만 연다. WebP는 isEmpty()다.
  const image = nativeImage.createFromBuffer(bytes)
  if (image.isEmpty()) return null
  const { width, height } = image.getSize()
  if (width <= 0 || height <= 0) return null
  const longest = Math.max(width, height)
  const resized =
    longest <= 512 ? image : image.resize(width >= height ? { width: 512 } : { height: 512 })
  const jpegUrl = `data:image/jpeg;base64,${resized.toJPEG(80).toString('base64')}`
  if (jpegUrl.length <= 1024 * 1024) return jpegUrl
  const pngUrl = `data:image/png;base64,${resized.toPNG().toString('base64')}`
  if (pngUrl.length <= 1024 * 1024) return pngUrl
  return null
}
