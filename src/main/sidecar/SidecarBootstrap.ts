import { spawn } from 'child_process'
import type { ChildProcess } from 'child_process'
import { createHash } from 'crypto'
import { cp, mkdir, readFile, rm, stat, writeFile } from 'fs/promises'
import { join, relative } from 'path'
import type { BootstrapState } from '../../shared/types'

export const READY_MARKER_FILE = '.ready'

/** 번들에서 <userData>/sidecar 로 복사하지 않는 항목 (스펙 001 §4.1) */
const EXCLUDED_DIRS = new Set(['.venv', '__pycache__', '.git', '.mypy_cache', '.ruff_cache'])

export interface SidecarBootstrapOptions {
  /** 번들 sidecar 프로젝트 (pyproject.toml, uv.lock, src/) */
  bundledSidecarDir: string
  /** 복사·sync 대상. 보통 <userData>/sidecar */
  targetSidecarDir: string
  /** uv 실행 파일. 테스트에서는 process.execPath */
  uvCommand: string
  /** uv 인자. 기본은 ['sync', '--project', targetSidecarDir, '--frozen'] */
  syncArgs?: string[]
  /** process.env 위에 덮어쓸 환경 변수 (UV_CACHE_DIR 등) */
  env?: NodeJS.ProcessEnv
  onLog?: (line: string) => void
  /** 상태에 포함할 stderr 최근 줄 수. 기본 8 */
  logTailLines?: number
}

export interface BootstrapController {
  getState(): BootstrapState
  onChange(listener: (state: BootstrapState) => void): () => void
  /** 부트스트랩을 시작한다. 이미 진행 중이면 그 결과를 돌려준다 */
  start(): Promise<BootstrapState>
  /** error 상태에서 다시 시도한다. 진행 중이면 start와 동일 */
  retry(): Promise<BootstrapState>
  /** 처음 ready가 되는 시점에 resolve (재시도를 거쳐도 한 번만) */
  whenReady(): Promise<void>
  /** 진행 중인 uv 프로세스를 종료한다 (앱 종료 시) */
  dispose(): void
}

export const READY_STATE: BootstrapState = {
  status: 'ready',
  message: '준비 완료',
  error: null,
  log: []
}

/** dev 등 부트스트랩이 필요 없는 환경용: 항상 ready */
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
    // 시스템 Python에 의존하지 않고 항상 관리형 Python을 쓴다 (환경 재현성, uv 0.11 `--managed-python`)
    UV_MANAGED_PYTHON: '1',
    // stderr가 TTY가 아니어도 진행 바 없이 한 줄 로그만 남기도록
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

export async function readReadyMarker(targetSidecarDir: string): Promise<string | null> {
  try {
    const raw = await readFile(join(targetSidecarDir, READY_MARKER_FILE), 'utf-8')
    const hash = raw.trim()
    return hash === '' ? null : hash
  } catch {
    return null
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/**
 * 준비 판정: 마커의 해시가 번들 uv.lock 해시와 같고 .venv가 존재해야 ready.
 * (마커만 남고 .venv가 지워진 경우도 재sync 대상)
 */
export async function isSidecarReady(
  bundledSidecarDir: string,
  targetSidecarDir: string
): Promise<boolean> {
  const marker = await readReadyMarker(targetSidecarDir)
  if (marker === null) return false
  const lockHash = await computeLockHash(join(bundledSidecarDir, 'uv.lock'))
  if (marker !== lockHash) return false
  return exists(join(targetSidecarDir, '.venv'))
}

/** 프로젝트 파일만 새로 복사한다. 기존 .venv는 남겨 uv sync가 재사용하게 한다 */
export async function copySidecarProject(
  bundledSidecarDir: string,
  targetSidecarDir: string
): Promise<void> {
  await mkdir(targetSidecarDir, { recursive: true })
  await Promise.all(
    ['src', 'pyproject.toml', 'uv.lock', READY_MARKER_FILE].map((name) =>
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

/**
 * 패키징된 앱의 첫 실행 부트스트랩 (스펙 001 §4.1).
 * checking → (마커 일치) ready
 *          → copying → syncing → ready (마커 기록)
 * 실패는 어느 단계든 error. retry()로 checking부터 다시.
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
  private child: ChildProcess | null = null
  private disposed = false
  private readonly readyPromise: Promise<void>
  private resolveReady!: () => void

  constructor(private readonly options: SidecarBootstrapOptions) {
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
    return this.start()
  }

  dispose(): void {
    this.disposed = true
    this.child?.kill('SIGTERM')
  }

  private setState(patch: Partial<BootstrapState>): void {
    this.state = { ...this.state, ...patch }
    for (const listener of this.listeners) listener(this.state)
  }

  private log(line: string): void {
    this.options.onLog?.(line)
    const max = this.options.logTailLines ?? DEFAULT_LOG_TAIL
    const log = [...this.state.log, line].slice(-max)
    this.setState({ log })
  }

  private async run(): Promise<BootstrapState> {
    const { bundledSidecarDir, targetSidecarDir } = this.options
    this.setState({ status: 'checking', message: '사이드카 환경 확인 중', error: null, log: [] })
    try {
      if (await isSidecarReady(bundledSidecarDir, targetSidecarDir)) {
        return this.markReady()
      }
      const lockHash = await computeLockHash(join(bundledSidecarDir, 'uv.lock'))

      this.setState({ status: 'copying', message: '사이드카 복사 중' })
      await copySidecarProject(bundledSidecarDir, targetSidecarDir)

      this.setState({
        status: 'syncing',
        message: 'Python 환경 구성 중 (수 GB 다운로드, 수 분 소요)'
      })
      await this.runUvSync()

      // 실패 시에는 여기 도달하지 않으므로 마커는 성공 경로에서만 남는다
      await writeFile(join(targetSidecarDir, READY_MARKER_FILE), `${lockHash}\n`, 'utf-8')
      return this.markReady()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.setState({ status: 'error', message: '사이드카 환경 구성 실패', error: message })
      return this.state
    }
  }

  private markReady(): BootstrapState {
    this.setState({ status: 'ready', message: '준비 완료', error: null })
    this.resolveReady()
    return this.state
  }

  private runUvSync(): Promise<void> {
    const { uvCommand, targetSidecarDir } = this.options
    const args = this.options.syncArgs ?? ['sync', '--project', targetSidecarDir, '--frozen']
    return new Promise((resolve, reject) => {
      if (this.disposed) {
        reject(new Error('bootstrap disposed'))
        return
      }
      const child = spawn(uvCommand, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        env: { ...process.env, ...this.options.env }
      })
      this.child = child

      let buffer = ''
      const onChunk = (chunk: string): void => {
        buffer += chunk
        const lines = buffer.split(/\r?\n/)
        buffer = lines.pop() ?? ''
        for (const line of lines) if (line.trim() !== '') this.log(line)
      }
      child.stdout.setEncoding('utf-8')
      child.stdout.on('data', onChunk)
      child.stderr.setEncoding('utf-8')
      child.stderr.on('data', onChunk)

      child.on('error', (error) => {
        this.child = null
        reject(new Error(`uv 실행 실패: ${error.message}`))
      })
      child.on('close', (code) => {
        this.child = null
        if (buffer.trim() !== '') this.log(buffer)
        if (code === 0) resolve()
        else reject(new Error(`uv sync 종료 코드 ${code}`))
      })
    })
  }
}
