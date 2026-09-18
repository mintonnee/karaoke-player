import { existsSync } from 'fs'
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { spawn } from 'child_process'
import {
  ERROR_CODES,
  LockError,
  buildExecutionEnv,
  buildRuntimeSidecarOptions,
  isRuntimeSelected,
  preparePythonEnv,
  readPointer,
  runtimeCacheRoot,
  runtimeDir,
  runSmoke,
  writePointer
} from '../../runtime'
import {
  envPrepFail,
  envPrepOk,
  miniManifest,
  startStaticServer,
  writeMiniSidecar
} from './helpers'

const FAKE_PYTHON = join(process.cwd(), 'src', 'main', '__tests__', 'runtime', 'fake_python.mjs')

let root: string
let sidecar: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'karaoke-prepare-'))
  sidecar = join(root, 'sidecar')
  await writeMiniSidecar(sidecar)
})

afterEach(async () => {
  vi.unstubAllEnvs()
  await rm(root, { recursive: true, force: true })
})

describe('preparePythonEnv', () => {
  it('최종 경로에 환경을 만들고 성공 시에만 inventory/smoke를 기록한다', async () => {
    const { manifest, locks } = await miniManifest(sidecar)
    const dest = runtimeDir(root, manifest.runtimeId)
    const result = await preparePythonEnv({
      runtimeDir: dest,
      manifest,
      locks,
      cacheRoot: runtimeCacheRoot(root),
      hooks: envPrepOk()
    })
    expect(result.smoke.ok).toBe(true)
    expect(existsSync(join(dest, 'venv', 'Scripts', 'python.exe'))).toBe(true)
    expect(existsSync(join(dest, 'inventory.json'))).toBe(true)
    expect(existsSync(join(dest, 'smoke.json'))).toBe(true)
    expect(dest).toBe(join(root, 'runtimes', manifest.runtimeId))
  })

  it('실패하면 포인터는 호출측이 바꾸지 않는 한 그대로다', async () => {
    const { manifest, locks } = await miniManifest(sidecar)
    await writePointer(root, {
      runtimeId: 'previous',
      inputDigests: {
        platform: 'win32-x64',
        interpreter: 'old',
        wheels: 'old',
        uv: 'old',
        sidecar: 'old'
      }
    })
    await mkdir(runtimeDir(root, 'previous'), { recursive: true })
    await writeFile(join(runtimeDir(root, 'previous'), 'keep'), 'ok')
    await expect(
      preparePythonEnv({
        runtimeDir: runtimeDir(root, manifest.runtimeId),
        manifest,
        locks,
        cacheRoot: runtimeCacheRoot(root),
        hooks: envPrepFail()
      })
    ).rejects.toThrow('env prep failed')
    expect((await readPointer(root))?.runtimeId).toBe('previous')
    expect(existsSync(join(runtimeDir(root, 'previous'), 'keep'))).toBe(true)
  })

  it('가짜 인터프리터로 smoke를 돌리고 실제 CPython을 받지 않는다', async () => {
    const pythonBytes = Buffer.from('not-a-real-python')
    const wheelBytes = Buffer.from('PK\x03\x04-fake-wheel')
    const srv = await startStaticServer({
      '/python.exe': pythonBytes,
      '/marker.whl': wheelBytes
    })
    const { miniLocks } = await import('./helpers')
    const locks = miniLocks({ pythonBytes, wheelBytes })
    locks.python.artifacts[0].url = srv.url('/python.exe')
    locks.wheels.artifacts[0].url = srv.url('/marker.whl')
    const { manifest } = await miniManifest(sidecar, locks)
    let fetches = 0
    const fetchImpl: typeof fetch = async (input, init) => {
      fetches += 1
      return fetch(input, init)
    }
    const dest = runtimeDir(root, manifest.runtimeId)
    const result = await preparePythonEnv({
      runtimeDir: dest,
      manifest,
      locks,
      cacheRoot: runtimeCacheRoot(root),
      fetchImpl,
      skipHostCheck: true,
      interpreterCommand: process.execPath,
      interpreterArgs: [FAKE_PYTHON]
    })
    expect(result.smoke.ok).toBe(true)
    expect(fetches).toBeGreaterThan(0)
    expect(existsSync(join(dest, 'python', 'python.exe'))).toBe(true)
    expect(existsSync(join(dest, 'venv', 'pyvenv.cfg'))).toBe(true)
    await srv.close()
  })
})

describe('isRuntimeSelected / pointer', () => {
  it('.ready + .venv 만으로는 ready가 아니다', async () => {
    const { manifest } = await miniManifest(sidecar)
    await mkdir(join(root, 'sidecar', '.venv'), { recursive: true })
    await writeFile(join(root, 'sidecar', '.ready'), `${manifest.runtimeId}\n`)
    expect(await isRuntimeSelected(root, manifest)).toBe(false)
  })

  it('포인터 교체는 성공 기록 후에만 의미가 있다', async () => {
    const { manifest, locks } = await miniManifest(sidecar)
    const dest = runtimeDir(root, manifest.runtimeId)
    await preparePythonEnv({
      runtimeDir: dest,
      manifest,
      locks,
      cacheRoot: runtimeCacheRoot(root),
      hooks: envPrepOk()
    })
    expect(await isRuntimeSelected(root, manifest)).toBe(false)
    await writePointer(root, {
      runtimeId: manifest.runtimeId,
      inputDigests: {
        platform: manifest.platform,
        interpreter: `${manifest.interpreter.patch}+${manifest.interpreter.distributionBuild}`,
        wheels: manifest.wheelListDigest,
        uv: manifest.uvToolDigest,
        sidecar: manifest.sidecarSourceDigest
      }
    })
    expect(await isRuntimeSelected(root, manifest)).toBe(true)
  })
})

describe('buildRuntimeSidecarOptions', () => {
  it('smoke와 실제 실행에 검증된 src 경로만 전달한다', async () => {
    vi.stubEnv('PYTHONPATH', 'C:\\untrusted')
    vi.stubEnv('PYTHONHOME', 'C:\\untrusted-python')
    const dest = join(root, 'runtime with spaces')
    await mkdir(join(dest, 'venv', 'Scripts'), { recursive: true })
    await writeFile(join(dest, 'venv', 'Scripts', 'python.exe'), 'fixture')
    const launch = buildRuntimeSidecarOptions(dest)
    const source = join(dest, 'sidecar', 'src')
    expect(launch.env.PYTHONPATH).toBe(source)
    expect(launch.env.PYTHONHOME).toBe('')
    expect(launch.env.PYTHONNOUSERSITE).toBe('1')
    expect(launch.env.PYTHONSAFEPATH).toBe('1')
    expect(launch.baseArgs).toEqual(['-m', 'karaoke_worker'])
    const smoke = await runSmoke({
      command: launch.command,
      module: 'karaoke_worker',
      cwd: join(dest, 'sidecar'),
      spawnImpl: (_command, args, options) => {
        expect(args).toEqual(['-c', 'import karaoke_worker'])
        expect(options.env).toEqual(launch.env)
        return spawn(process.execPath, ['-e', 'process.exit(0)'], options)
      }
    })
    expect(smoke.ok).toBe(true)
  })

  it('현재 manifest와 다른 runtimeId면 실행을 거부한다', async () => {
    const { manifest, locks } = await miniManifest(sidecar)
    const dest = runtimeDir(root, manifest.runtimeId)
    await preparePythonEnv({
      runtimeDir: dest,
      manifest,
      locks,
      cacheRoot: runtimeCacheRoot(root),
      hooks: envPrepOk()
    })
    const other = { ...manifest, runtimeId: 'other-app-runtime' }
    expect(() => buildRuntimeSidecarOptions(dest, { manifest: other })).toThrow(LockError)
    try {
      buildRuntimeSidecarOptions(dest, { manifest: other })
    } catch (err) {
      expect((err as LockError).code).toBe(ERROR_CODES.HASH_MISMATCH)
    }
  })

  it('PYTHONPATH/PYTHONHOME을 비우고 PYTHONNOUSERSITE를 켠다', async () => {
    const env = buildExecutionEnv({ PYTHONPATH: 'C:\\evil', UV_INDEX: 'https://evil.example' })
    expect(env.PYTHONPATH).toBe('')
    expect(env.PYTHONHOME).toBe('')
    expect(env.PYTHONNOUSERSITE).toBe('1')
    expect(env.UV_INDEX).toBeUndefined()
    expect(env.PIP_NO_INDEX).toBe('1')
  })
})
