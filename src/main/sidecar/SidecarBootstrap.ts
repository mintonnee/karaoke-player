import { dirname, join, relative } from 'path'
import { cp, mkdir, readFile, rm } from 'fs/promises'
import { createHash } from 'crypto'
import type { BootstrapPrepStage, BootstrapState } from '../../shared/types'
import {
  LockError,
  computeSidecarSourceDigest,
  isRuntimeSelected,
  preparePythonEnv,
  runtimeCacheRoot,
  runtimeDir,
  runtimeInputDigests,
  shouldHashSidecarPath,
  verifyManifest,
  writePointer,
  type EnvPrepHooks,
  type RuntimeLockSet,
  type RuntimeManifest
} from '../runtime'

export const READY_MARKER_FILE = '.ready'

/** 번들에서 <userData>/sidecar 로 복사하지 않는 항목 (스펙 001 §4.1) */
const EXCLUDED_DIRS = new Set(['.venv', '__pycache__', '.git', '.mypy_cache', '.ruff_cache'])

export interface SidecarBootstrapOptions {
  /** 번들 sidecar 프로젝트 (pyproject.toml, uv.lock, src/, .python-version) */
  bundledSidecarDir: string
  /** 기존 경로 보존용. 보통 <userData>/sidecar. 준비 완료 판정에는 쓰지 않는다 */
  targetSidecarDir: string
  /** 패키징 앱의 uv 경로. 해시 검증 후에만 사용 */
  uvCommand: string
  /** 하위 호환. 새 준비 경로에서는 무시한다 */
  syncArgs?: string[]
  env?: NodeJS.ProcessEnv
  onLog?: (line: string) => void
  logTailLines?: number
  /** 없으면 targetSidecarDir 부모를 userData로 본다 */
  userDataDir?: string
  manifest?: RuntimeManifest
  locks?: RuntimeLockSet
  fetchImpl?: typeof fetch
  skipHostCheck?: boolean
  envPrep?: EnvPrepHooks
}

export interface BootstrapController {
  getState(): BootstrapState
  onChange(listener: (state: BootstrapState) => void): () => void
  /** 부트스트랩을 시작한다. 이미 진행 중이면 그 결과를 돌려준다 */
  start(): Promise<BootstrapState>
  /** retryable=true 오류만 다시 시도한다. 진행 중이면 start와 동일 */
  retry(): Promise<BootstrapState>
  /** 처음 ready가 되는 시점에 resolve (재시도를 거쳐도 한 번만) */
  whenReady(): Promise<void>
  /** 진행 중인 준비를 취소한다 (앱 종료 시) */
  dispose(): void
}

export const READY_STATE: BootstrapState = {
  status: 'ready',
  message: '준비 완료',
  error: null,
  log: [],
  stage: null,
  logicalId: null,
  retryable: false
}

/** L2 내부 단계. L4가 BootstrapState에 download/verify/env-prep을 확장해야 한다 */
export type RuntimePrepareStage =
  'checking' | 'download' | 'verify' | 'env-prep' | 'smoke' | 'ready' | 'error'

export function createReadyBootstrap(): BootstrapController {
  return {
    getState: () => READY_STATE,
    onChange: () => () => {},
    start: () => Promise.resolve(READY_STATE),
    retry: () => Promise.resolve(READY_STATE),
    whenReady: () => Promise.resolve(),
    dispose: () => {}
  }
}

/** uv가 MSIX 읽기 전용 설치 디렉토리 대신 사용자 경로에만 쓰도록 고정한다 */
export function buildUvEnv(userDataDir: string): NodeJS.ProcessEnv {
  return {
    UV_CACHE_DIR: join(userDataDir, 'uv-cache'),
    UV_PYTHON_INSTALL_DIR: join(userDataDir, 'uv-python'),
    UV_MANAGED_PYTHON: '1',
    UV_NO_PROGRESS: '1'
  }
}

/** 번들 → 대상 복사 필터. relPath는 번들 루트 기준 상대 경로 */
export function shouldCopySidecarPath(relPath: string): boolean {
  if (relPath === '' || relPath === '.') return true
  const segments = relPath.split(/[\\/]/)
  for (const segment of segments) {
    if (EXCLUDED_DIRS.has(segment)) return false
    if (segment.endsWith('.egg-info')) return false
  }
  const name = segments[segments.length - 1]
  if (name.endsWith('.pyc') || name === READY_MARKER_FILE) return false
  return true
}

export async function computeLockHash(lockPath: string): Promise<string> {
  const content = await readFile(lockPath)
  return createHash('sha256').update(content).digest('hex')
}

/** `.python-version`을 포함하는 sidecar 소스 digest. */
export async function computeProjectHash(projectDir: string): Promise<string> {
  return computeSidecarSourceDigest(projectDir)
}

export { computeSidecarSourceDigest, shouldHashSidecarPath }

export async function readReadyMarker(targetSidecarDir: string): Promise<string | null> {
  try {
    const raw = await readFile(join(targetSidecarDir, READY_MARKER_FILE), 'utf-8')
    const hash = raw.trim()
    return hash === '' ? null : hash
  } catch {
    return null
  }
}

export interface SidecarReadyOptions {
  userDataDir: string
  manifest: RuntimeManifest
}

/**
 * 준비 판정: 선택 포인터의 runtimeId가 현재 manifest와 같고 inventory/smoke가 기록되어야 ready.
 * `.ready`나 `.venv` 존재만으로는 준비 완료가 아니다.
 */
export async function isSidecarReady(options: SidecarReadyOptions): Promise<boolean> {
  return isRuntimeSelected(options.userDataDir, options.manifest)
}

/** 프로젝트 파일만 새로 복사한다. 기존 .venv는 남겨 두되 신뢰하지 않는다 */
export async function copySidecarProject(
  bundledSidecarDir: string,
  targetSidecarDir: string
): Promise<void> {
  await mkdir(targetSidecarDir, { recursive: true })
  await Promise.all(
    ['src', 'pyproject.toml', 'uv.lock', '.python-version', READY_MARKER_FILE].map((name) =>
      rm(join(targetSidecarDir, name), { recursive: true, force: true })
    )
  )
  await cp(bundledSidecarDir, targetSidecarDir, {
    recursive: true,
    force: true,
    filter: (source) => shouldCopySidecarPath(relative(bundledSidecarDir, source))
  })
}

const DEFAULT_LOG_TAIL = 8

function mapStageToStatus(stage: RuntimePrepareStage): BootstrapState['status'] {
  switch (stage) {
    case 'checking':
      return 'checking'
    case 'download':
      return 'download'
    case 'verify':
      return 'verify'
    case 'env-prep':
    case 'smoke':
      return 'env-prep'
    case 'ready':
      return 'ready'
    case 'error':
      return 'error'
  }
}

function stageField(stage: RuntimePrepareStage): BootstrapPrepStage | null {
  switch (stage) {
    case 'download':
      return 'download'
    case 'verify':
      return 'verify'
    case 'env-prep':
    case 'smoke':
      return 'env-prep'
    default:
      return null
  }
}

/**
 * 패키징된 앱의 런타임 준비 (스펙 008 §4.3).
 * checking → (포인터 일치) ready
 *          → download/verify → env-prep/smoke → 포인터 교체 → ready
 * 실패는 어느 단계든 error. 이전 포인터·런타임 디렉터리는 유지한다.
 */
export class SidecarBootstrap implements BootstrapController {
  private state: BootstrapState = {
    status: 'checking',
    message: '사이드카 환경 확인 중',
    error: null,
    log: []
  }
  private readonly listeners = new Set<(state: BootstrapState) => void>()
  private running: Promise<BootstrapState> | null = null
  private disposed = false
  private prepareAbort: AbortController | null = null
  private readonly readyPromise: Promise<void>
  private resolveReady!: () => void

  constructor(private readonly options: SidecarBootstrapOptions) {
    this.prepareAbort = new AbortController()
    this.readyPromise = new Promise((resolve) => {
      this.resolveReady = resolve
    })
  }

  getState(): BootstrapState {
    return this.state
  }

  onChange(listener: (state: BootstrapState) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  whenReady(): Promise<void> {
    return this.readyPromise
  }

  start(): Promise<BootstrapState> {
    if (this.state.status === 'ready') return Promise.resolve(this.state)
    if (this.running) return this.running
    this.running = this.run().finally(() => {
      this.running = null
    })
    return this.running
  }

  retry(): Promise<BootstrapState> {
    if (this.running) return this.running
    if (this.state.status === 'error' && this.state.retryable !== true) {
      return Promise.resolve(this.state)
    }
    return this.start()
  }

  dispose(): void {
    this.disposed = true
    this.prepareAbort?.abort()
  }

  private setState(patch: Partial<BootstrapState>): void {
    this.state = { ...this.state, ...patch }
    for (const listener of this.listeners) listener(this.state)
  }

  private setStage(
    stage: RuntimePrepareStage,
    message: string,
    extra: Partial<BootstrapState> = {}
  ): void {
    const nextStage =
      extra.stage !== undefined
        ? extra.stage
        : stage === 'error'
          ? (this.state.stage ?? null)
          : stageField(stage)
    this.setState({
      status: mapStageToStatus(stage),
      message,
      stage: nextStage,
      ...extra
    })
  }

  private log(line: string): void {
    this.options.onLog?.(line)
    const max = this.options.logTailLines ?? DEFAULT_LOG_TAIL
    const log = [...this.state.log, line].slice(-max)
    this.setState({ log })
  }

  private userDataDir(): string {
    return this.options.userDataDir ?? dirname(this.options.targetSidecarDir)
  }

  private async run(): Promise<BootstrapState> {
    const { bundledSidecarDir } = this.options
    let canRebuild = false
    this.prepareAbort = new AbortController()
    if (this.disposed) this.prepareAbort.abort()
    this.setStage('checking', '사이드카 환경 확인 중', {
      error: null,
      log: [],
      logicalId: null,
      retryable: false
    })
    try {
      const manifest = this.options.manifest
      const locks = this.options.locks
      if (!manifest || !locks) {
        throw new Error('runtime manifest가 필요합니다')
      }
      const userDataDir = this.userDataDir()
      const verified = await verifyManifest(manifest, locks, bundledSidecarDir)
      if (!verified.ok) {
        throw new Error(verified.errors.map((e) => `${e.code} ${e.message}`).join('\n'))
      }
      canRebuild = true

      if (await isSidecarReady({ userDataDir, manifest })) {
        return this.markReady()
      }
      if (this.disposed) throw new Error('bootstrap disposed')

      const dest = runtimeDir(userDataDir, manifest.runtimeId)
      await mkdir(dest, { recursive: true })

      this.setStage('download', '런타임 입력 준비 중')
      await copySidecarProject(bundledSidecarDir, join(dest, 'sidecar'))

      this.setStage('env-prep', 'Python 환경 구성 중')
      const result = await preparePythonEnv({
        runtimeDir: dest,
        manifest,
        locks,
        cacheRoot: runtimeCacheRoot(userDataDir),
        signal: this.prepareAbort.signal,
        fetchImpl: this.options.fetchImpl,
        skipHostCheck: this.options.skipHostCheck,
        hooks: this.options.envPrep,
        uvCommand: this.options.uvCommand,
        onLog: (line) => this.log(line)
      })

      this.setStage('smoke', '런타임 smoke 확인 중')
      if (!result.smoke.ok) {
        throw new Error(result.smoke.error ?? 'runtime smoke failed')
      }

      await writePointer(userDataDir, {
        runtimeId: manifest.runtimeId,
        inputDigests: result.inputDigests ?? runtimeInputDigests(manifest)
      })
      return this.markReady()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const logicalId = error instanceof LockError ? (error.id ?? null) : null
      this.setStage('error', '사이드카 환경 구성 실패', {
        error: message,
        logicalId,
        retryable: canRebuild && !this.disposed
      })
      return this.state
    }
  }

  private markReady(): BootstrapState {
    this.setStage('ready', '준비 완료', {
      error: null,
      logicalId: null,
      retryable: false
    })
    this.resolveReady()
    return this.state
  }
}
