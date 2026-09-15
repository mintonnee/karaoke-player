import { spawn } from 'child_process'
import type { ChildProcess, SpawnOptions } from 'child_process'
import { basename, join } from 'path'
import { mkdir, writeFile } from 'fs/promises'
import { existsSync, readFileSync } from 'fs'
import { ERROR_CODES, LockError, posixDest, type Artifact } from './schema'
import { ensureArtifact, verifyExistingFile, type EnsureArtifactOptions } from './download'
import type { RuntimeLockSet, RuntimeManifest, RuntimeInputDigests } from './manifest'
import { findArtifact, runtimeInputDigests } from './manifest'
import {
  INVENTORY_FILE,
  META_FILE,
  PYTHON_DIR,
  SIDECAR_DIR,
  SMOKE_FILE,
  VENV_DIR,
  WHEELHOUSE_DIR,
  assertRuntimeMatchesManifest
} from './pointer'

export interface InstallInventory {
  packages: Record<string, { wheel: string; sha256: string; version: string }>
}

export interface SmokeResult {
  ok: boolean
  module: string
  at: string
  error?: string
}

export interface EnvPrepResult {
  interpreterPath: string
  inventory: InstallInventory
  smoke: SmokeResult
  inputDigests: RuntimeInputDigests
}

export interface EnvPrepContext {
  runtimeDir: string
  manifest: RuntimeManifest
  locks: RuntimeLockSet
  cacheRoot: string
  signal?: AbortSignal
}

export interface EnvPrepHooks {
  /** 있으면 기본 CPython/wheel 다운로드·venv 대신 이 훅만 실행 */
  prepare?: (ctx: EnvPrepContext) => Promise<EnvPrepResult>
}

export type SpawnImpl = (command: string, args: string[], options: SpawnOptions) => ChildProcess

export interface PreparePythonEnvOptions {
  runtimeDir: string
  manifest: RuntimeManifest
  locks: RuntimeLockSet
  cacheRoot: string
  signal?: AbortSignal
  fetchImpl?: typeof fetch
  skipHostCheck?: boolean
  hooks?: EnvPrepHooks
  /** hash 검증 후에만 실행. 테스트에서는 process.execPath */
  interpreterCommand?: string
  interpreterArgs?: string[]
  uvCommand?: string
  spawnImpl?: SpawnImpl
  onLog?: (line: string) => void
}

const UV_INDEX_KEYS = /^(UV_.*INDEX|UV_INDEX$|PIP_INDEX_URL|PIP_EXTRA_INDEX_URL)$/

/** 실행 환경: 시스템/사용자 site·외부 index로 resolve가 바뀌지 않게 고정 */
export function buildExecutionEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra }
  for (const key of Object.keys(env)) {
    if (UV_INDEX_KEYS.test(key) || key === 'UV_INDEX' || key === 'PIP_INDEX_URL') {
      delete env[key]
    }
  }
  env.PYTHONPATH = ''
  env.PYTHONHOME = ''
  env.PYTHONNOUSERSITE = '1'
  env.PYTHONSAFEPATH = '1'
  env.PIP_NO_INDEX = '1'
  env.UV_OFFLINE = '1'
  env.UV_NO_INDEX = '1'
  return env
}

export function venvPythonPath(runtimeDir: string): string {
  return join(runtimeDir, VENV_DIR, 'Scripts', 'python.exe')
}

export function bundledPythonPath(runtimeDir: string): string {
  return join(runtimeDir, PYTHON_DIR, 'python.exe')
}

function remapPythonArtifact(artifact: Artifact): Artifact {
  const copy = structuredClone(artifact)
  copy.dest = `${PYTHON_DIR}/python.exe`
  if (copy.archive?.files) {
    for (const file of copy.archive.files) {
      file.dest = posixDest(file.path)
    }
  }
  return copy
}

function remapWheelArtifact(artifact: Artifact): Artifact {
  const copy = structuredClone(artifact)
  copy.dest = `${WHEELHOUSE_DIR}/${basename(posixDest(artifact.dest))}`
  return copy
}

async function runCommand(
  spawnImpl: SpawnImpl,
  command: string,
  args: string[],
  opts: { env?: NodeJS.ProcessEnv; signal?: AbortSignal; onLog?: (line: string) => void }
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    if (opts.signal?.aborted) {
      const err = new Error('env prep cancelled') as Error & { code: string }
      err.name = 'AbortError'
      err.code = 'ABORT_ERR'
      reject(err)
      return
    }
    const child = spawnImpl(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env: opts.env ?? buildExecutionEnv()
    })
    const onAbort = (): void => {
      child.kill('SIGTERM')
    }
    opts.signal?.addEventListener('abort', onAbort, { once: true })
    let buffer = ''
    const onChunk = (chunk: string): void => {
      buffer += chunk
      const lines = buffer.split(/\r?\n/)
      buffer = lines.pop() ?? ''
      for (const line of lines) if (line.trim() !== '') opts.onLog?.(line)
    }
    child.stdout?.setEncoding('utf-8')
    child.stdout?.on('data', onChunk)
    child.stderr?.setEncoding('utf-8')
    child.stderr?.on('data', onChunk)
    child.on('error', (error) => {
      opts.signal?.removeEventListener('abort', onAbort)
      reject(new Error(`runtime 실행 실패: ${error.message}`))
    })
    child.on('close', (code) => {
      opts.signal?.removeEventListener('abort', onAbort)
      if (buffer.trim() !== '') opts.onLog?.(buffer)
      if (code === 0) resolve()
      else reject(new Error(`runtime command 종료 코드 ${code}`))
    })
  })
}

function inventoryFromWheels(wheels: Artifact[]): InstallInventory {
  const packages: InstallInventory['packages'] = {}
  for (const wheel of wheels) {
    packages[wheel.id] = {
      wheel: basename(posixDest(wheel.dest)),
      sha256: wheel.sha256,
      version: wheel.version
    }
  }
  return { packages }
}

async function defaultPrepare(opts: PreparePythonEnvOptions): Promise<EnvPrepResult> {
  const { runtimeDir, manifest, locks, cacheRoot } = opts
  const spawnImpl = opts.spawnImpl ?? spawn
  const pythonArt = remapPythonArtifact(findArtifact(locks.python, 'cpython'))
  const wheels = locks.wheels.artifacts.filter((a) => a.kind === 'wheel' && a.userPcBuild !== true)
  const common: Omit<EnsureArtifactOptions, 'artifact' | 'destRoot'> = {
    cacheRoot,
    fetchImpl: opts.fetchImpl,
    skipHostCheck: opts.skipHostCheck,
    signal: opts.signal
  }

  await mkdir(join(runtimeDir, PYTHON_DIR), { recursive: true })
  await mkdir(join(runtimeDir, WHEELHOUSE_DIR), { recursive: true })
  await ensureArtifact({ ...common, artifact: pythonArt, destRoot: runtimeDir })

  const pythonExe = bundledPythonPath(runtimeDir)
  const pythonMember =
    pythonArt.archive?.files.find((f) => posixDest(f.path).endsWith('python/python.exe')) ??
    pythonArt.archive?.files.find((f) => posixDest(f.dest ?? '').endsWith('python.exe'))
  if (pythonMember) {
    verifyExistingFile(pythonExe, {
      sha256: pythonMember.sha256,
      size: pythonMember.size,
      id: pythonArt.id
    })
  } else {
    verifyExistingFile(pythonExe, {
      sha256: pythonArt.sha256,
      size: pythonArt.size,
      id: pythonArt.id
    })
  }

  for (const wheel of wheels) {
    await ensureArtifact({
      ...common,
      artifact: remapWheelArtifact(wheel),
      destRoot: runtimeDir
    })
    const dest = join(runtimeDir, WHEELHOUSE_DIR, basename(posixDest(wheel.dest)))
    verifyExistingFile(dest, { sha256: wheel.sha256, size: wheel.size, id: wheel.id })
  }

  const venvDir = join(runtimeDir, VENV_DIR)
  const interpreterCommand = opts.interpreterCommand ?? pythonExe
  const interpreterArgs = opts.interpreterArgs ?? []
  await runCommand(spawnImpl, interpreterCommand, [...interpreterArgs, '-m', 'venv', venvDir], {
    env: buildExecutionEnv(),
    signal: opts.signal,
    onLog: opts.onLog
  })

  const useVenv = !opts.interpreterCommand && existsSync(venvPythonPath(runtimeDir))
  const pipCommand = useVenv ? venvPythonPath(runtimeDir) : interpreterCommand
  const pipArgs = useVenv ? [] : interpreterArgs
  const wheelhouse = join(runtimeDir, WHEELHOUSE_DIR)
  const wheelFiles = wheels.map((w) => join(wheelhouse, basename(posixDest(w.dest))))
  if (opts.uvCommand) {
    const uvArt = findArtifact(locks.tools, 'uv')
    const uvMember = uvArt.archive?.files.find((f) => f.path.endsWith('uv.exe'))
    verifyExistingFile(opts.uvCommand, {
      sha256: uvMember?.sha256 ?? uvArt.sha256,
      size: uvMember?.size ?? uvArt.size,
      id: 'uv'
    })
    await runCommand(
      spawnImpl,
      opts.uvCommand,
      [
        'pip',
        'install',
        '--python',
        pipCommand,
        '--offline',
        '--no-index',
        '--find-links',
        wheelhouse,
        ...wheelFiles
      ],
      { env: buildExecutionEnv(), signal: opts.signal, onLog: opts.onLog }
    )
  } else if (wheelFiles.length > 0) {
    await runCommand(
      spawnImpl,
      pipCommand,
      [
        ...pipArgs,
        '-m',
        'pip',
        'install',
        '--no-index',
        '--find-links',
        wheelhouse,
        '--no-deps',
        ...wheelFiles
      ],
      { env: buildExecutionEnv(), signal: opts.signal, onLog: opts.onLog }
    )
  }

  const smokeModule = existsSync(join(runtimeDir, SIDECAR_DIR, 'src', 'karaoke_worker'))
    ? 'karaoke_worker'
    : 'encodings'
  const smoke = await runSmoke({
    command: pipCommand,
    args: pipArgs,
    module: smokeModule,
    cwd: join(runtimeDir, SIDECAR_DIR),
    spawnImpl,
    signal: opts.signal,
    onLog: opts.onLog
  })

  return {
    interpreterPath: interpreterCommand,
    inventory: inventoryFromWheels(wheels),
    smoke,
    inputDigests: runtimeInputDigests(manifest)
  }
}

export async function runSmoke(opts: {
  command: string
  args?: string[]
  module: string
  cwd?: string
  spawnImpl?: SpawnImpl
  signal?: AbortSignal
  onLog?: (line: string) => void
}): Promise<SmokeResult> {
  const at = new Date().toISOString()
  try {
    await runCommand(
      opts.spawnImpl ?? spawn,
      opts.command,
      [...(opts.args ?? []), '-c', `import ${opts.module}`],
      {
        env: buildExecutionEnv({ ...(opts.cwd ? { PYTHONPATH: '' } : {}) }),
        signal: opts.signal,
        onLog: opts.onLog
      }
    )
    return { ok: true, module: opts.module, at }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    opts.onLog?.(error)
    return { ok: false, module: opts.module, at, error }
  }
}

export async function preparePythonEnv(opts: PreparePythonEnvOptions): Promise<EnvPrepResult> {
  await mkdir(opts.runtimeDir, { recursive: true })
  const ctx: EnvPrepContext = {
    runtimeDir: opts.runtimeDir,
    manifest: opts.manifest,
    locks: opts.locks,
    cacheRoot: opts.cacheRoot,
    signal: opts.signal
  }
  const result = opts.hooks?.prepare ? await opts.hooks.prepare(ctx) : await defaultPrepare(opts)

  const meta = {
    runtimeId: opts.manifest.runtimeId,
    inputDigests: result.inputDigests,
    interpreterPath: result.interpreterPath
  }
  await writeFile(
    join(opts.runtimeDir, INVENTORY_FILE),
    `${JSON.stringify(result.inventory, null, 2)}\n`
  )
  await writeFile(join(opts.runtimeDir, SMOKE_FILE), `${JSON.stringify(result.smoke, null, 2)}\n`)
  await writeFile(join(opts.runtimeDir, META_FILE), `${JSON.stringify(meta, null, 2)}\n`)
  return result
}

export interface RuntimeSidecarLaunch {
  command: string
  baseArgs: string[]
  env: NodeJS.ProcessEnv
}

/** L4가 SidecarManager에 넘길 검증된 python + worker 인자. uv sync/네트워크 없음. */
export function buildRuntimeSidecarOptions(
  runtimeDir: string,
  opts: { manifest?: RuntimeManifest } = {}
): RuntimeSidecarLaunch {
  if (opts.manifest) {
    const metaPath = join(runtimeDir, META_FILE)
    if (!existsSync(metaPath)) {
      throw new LockError(ERROR_CODES.SCHEMA_ERROR, 'runtime meta missing; refuse to run', {
        path: runtimeDir
      })
    }
    const meta = JSON.parse(readFileSync(metaPath, 'utf8')) as {
      runtimeId?: string
    }
    if (!meta.runtimeId) {
      throw new LockError(ERROR_CODES.SCHEMA_ERROR, 'runtime meta missing runtimeId', {
        path: runtimeDir
      })
    }
    assertRuntimeMatchesManifest(meta.runtimeId, opts.manifest)
  }
  const venvPy = venvPythonPath(runtimeDir)
  const bundledPy = bundledPythonPath(runtimeDir)
  const command = existsSync(venvPy) ? venvPy : bundledPy
  if (!existsSync(command)) {
    throw new LockError(ERROR_CODES.SCHEMA_ERROR, `runtime python missing: ${command}`, {
      path: command
    })
  }
  return {
    command,
    baseArgs: ['-m', 'karaoke_worker'],
    env: buildExecutionEnv()
  }
}
