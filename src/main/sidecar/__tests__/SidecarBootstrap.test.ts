import { existsSync } from 'fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BootstrapState, BootstrapStatus } from '../../../shared/types'
import {
  READY_MARKER_FILE,
  SidecarBootstrap,
  buildUvEnv,
  copySidecarProject,
  computeProjectHash,
  isSidecarReady,
  shouldCopySidecarPath
} from '../SidecarBootstrap'
import {
  envPrepFail,
  envPrepFlaky,
  envPrepOk,
  miniManifest,
  writeMiniSidecar
} from '../../__tests__/runtime/helpers'
import {
  readPointer,
  runtimeDir,
  writePointer,
  type RuntimeLockSet,
  type RuntimeManifest
} from '../../runtime'

let root: string
let bundled: string
let target: string
let manifest: RuntimeManifest
let locks: RuntimeLockSet

async function writeBundled(): Promise<void> {
  await mkdir(join(bundled, 'src', 'karaoke_worker', '__pycache__'), { recursive: true })
  await mkdir(join(bundled, 'src', 'karaoke_worker.egg-info'), { recursive: true })
  await mkdir(join(bundled, '.venv', 'Scripts'), { recursive: true })
  await writeMiniSidecar(bundled)
  await writeFile(join(bundled, 'src', 'karaoke_worker', '__pycache__', 'cli.pyc'), 'bin')
  await writeFile(join(bundled, 'src', 'karaoke_worker.egg-info', 'PKG-INFO'), 'x')
  await writeFile(join(bundled, '.venv', 'pyvenv.cfg'), 'home = C:\\python\n')
}

function createBootstrap(
  mode: 'ok' | 'fail' | 'flaky',
  extra: Partial<ConstructorParameters<typeof SidecarBootstrap>[0]> = {}
): {
  bootstrap: SidecarBootstrap
  statuses: BootstrapStatus[]
} {
  const statuses: BootstrapStatus[] = []
  const envPrep =
    mode === 'ok'
      ? envPrepOk()
      : mode === 'fail'
        ? envPrepFail()
        : envPrepFlaky(join(root, 'flaky.marker'))
  const bootstrap = new SidecarBootstrap({
    bundledSidecarDir: bundled,
    targetSidecarDir: target,
    userDataDir: root,
    uvCommand: process.execPath,
    manifest,
    locks,
    envPrep,
    onLog: () => {},
    ...extra
  })
  bootstrap.onChange((state: BootstrapState) => {
    if (statuses[statuses.length - 1] !== state.status) statuses.push(state.status)
  })
  return { bootstrap, statuses }
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'karaoke-bootstrap-'))
  bundled = join(root, 'bundled')
  target = join(root, 'sidecar')
  await writeBundled()
  const built = await miniManifest(bundled)
  manifest = built.manifest
  locks = built.locks
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('shouldCopySidecarPath', () => {
  it('.venv/__pycache__/*.pyc/egg-info/.ready를 제외한다', () => {
    expect(shouldCopySidecarPath('')).toBe(true)
    expect(shouldCopySidecarPath('pyproject.toml')).toBe(true)
    expect(shouldCopySidecarPath('uv.lock')).toBe(true)
    expect(shouldCopySidecarPath('.python-version')).toBe(true)
    expect(shouldCopySidecarPath(join('src', 'karaoke_worker', 'cli.py'))).toBe(true)
    expect(shouldCopySidecarPath('.venv')).toBe(false)
    expect(shouldCopySidecarPath(join('.venv', 'pyvenv.cfg'))).toBe(false)
    expect(shouldCopySidecarPath(join('src', 'karaoke_worker', '__pycache__'))).toBe(false)
    expect(shouldCopySidecarPath(join('src', 'karaoke_worker', 'x.pyc'))).toBe(false)
    expect(shouldCopySidecarPath(join('src', 'karaoke_worker.egg-info', 'PKG-INFO'))).toBe(false)
    expect(shouldCopySidecarPath(READY_MARKER_FILE)).toBe(false)
  })
})

describe('buildUvEnv', () => {
  it('캐시·Python 설치 경로를 userData 아래로 고정한다', () => {
    const env = buildUvEnv(join('C:', 'ud'))
    expect(env.UV_CACHE_DIR).toBe(join('C:', 'ud', 'uv-cache'))
    expect(env.UV_PYTHON_INSTALL_DIR).toBe(join('C:', 'ud', 'uv-python'))
  })
})

describe('copySidecarProject', () => {
  it('프로젝트 파일만 복사하고 기존 .venv는 남긴다', async () => {
    await mkdir(join(target, '.venv'), { recursive: true })
    await writeFile(join(target, '.venv', 'keep'), '')
    await writeFile(join(target, READY_MARKER_FILE), 'stale')
    await copySidecarProject(bundled, target)

    expect(existsSync(join(target, 'pyproject.toml'))).toBe(true)
    expect(existsSync(join(target, 'uv.lock'))).toBe(true)
    expect(existsSync(join(target, '.python-version'))).toBe(true)
    expect(existsSync(join(target, 'src', 'karaoke_worker', 'cli.py'))).toBe(true)
    expect(existsSync(join(target, 'src', 'karaoke_worker', '__pycache__'))).toBe(false)
    expect(existsSync(join(target, 'src', 'karaoke_worker.egg-info'))).toBe(false)
    expect(existsSync(join(target, '.venv', 'pyvenv.cfg'))).toBe(false)
    expect(existsSync(join(target, '.venv', 'keep'))).toBe(true)
    expect(existsSync(join(target, READY_MARKER_FILE))).toBe(false)
  })
})

describe('isSidecarReady', () => {
  it('포인터 부재 → false', async () => {
    expect(await isSidecarReady({ userDataDir: root, manifest })).toBe(false)
  })

  it('.ready + .venv 만으로는 true가 아니다', async () => {
    await mkdir(join(target, '.venv'), { recursive: true })
    await writeFile(join(target, READY_MARKER_FILE), `${await computeProjectHash(bundled)}\n`)
    expect(await isSidecarReady({ userDataDir: root, manifest })).toBe(false)
  })

  it('포인터 runtimeId가 현재 manifest와 다르면 false', async () => {
    await writePointer(root, {
      runtimeId: 'old-runtime',
      inputDigests: {
        platform: 'win32-x64',
        interpreter: 'old',
        wheels: 'old',
        uv: 'old',
        sidecar: 'old'
      }
    })
    expect(await isSidecarReady({ userDataDir: root, manifest })).toBe(false)
  })
})

describe('SidecarBootstrap', () => {
  it('첫 실행: 최종 경로에 준비 후 포인터를 기록한다', async () => {
    const { bootstrap, statuses } = createBootstrap('ok')
    const state = await bootstrap.start()

    expect(state.status).toBe('ready')
    expect(state.retryable).toBe(false)
    expect(statuses[0]).toBe('checking')
    expect(statuses).toContain('download')
    expect(statuses).toContain('env-prep')
    expect(statuses[statuses.length - 1]).toBe('ready')
    expect((await readPointer(root))?.runtimeId).toBe(manifest.runtimeId)
    expect(existsSync(join(runtimeDir(root, manifest.runtimeId), 'venv'))).toBe(true)
    expect(
      existsSync(
        join(runtimeDir(root, manifest.runtimeId), 'sidecar', 'src', 'karaoke_worker', 'cli.py')
      )
    ).toBe(true)
    await expect(bootstrap.whenReady()).resolves.toBeUndefined()
  })

  it('포인터가 일치하면 준비를 건너뛰고 즉시 ready', async () => {
    const dest = runtimeDir(root, manifest.runtimeId)
    await mkdir(join(dest, 'venv'), { recursive: true })
    await writeFile(
      join(dest, 'inventory.json'),
      JSON.stringify({
        packages: { marker: { wheel: 'm.whl', sha256: 'a'.repeat(64), version: '1' } }
      })
    )
    await writeFile(
      join(dest, 'smoke.json'),
      JSON.stringify({ ok: true, module: 'karaoke_worker', at: 't' })
    )
    await writeFile(join(dest, 'meta.json'), JSON.stringify({ runtimeId: manifest.runtimeId }))
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
    const { bootstrap, statuses } = createBootstrap('fail')
    const state = await bootstrap.start()
    expect(state.status).toBe('ready')
    expect(statuses).toEqual(['checking', 'ready'])
  })

  it('준비 실패 시 이전 포인터와 이전 런타임 디렉터리를 유지한다', async () => {
    const prevDir = runtimeDir(root, 'previous')
    await mkdir(prevDir, { recursive: true })
    await writeFile(join(prevDir, 'keep'), 'cached')
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
    const { bootstrap, statuses } = createBootstrap('fail')
    const state = await bootstrap.start()
    expect(state.status).toBe('error')
    expect(state.error).toContain('env prep failed')
    expect(state.retryable).toBe(true)
    expect(statuses).toContain('error')
    expect((await readPointer(root))?.runtimeId).toBe('previous')
    expect(await readFile(join(prevDir, 'keep'), 'utf-8')).toBe('cached')
  })

  it('성공 시에만 포인터를 바꾸고 이전 런타임 디렉터리는 남긴다', async () => {
    const prevDir = runtimeDir(root, 'previous')
    await mkdir(prevDir, { recursive: true })
    await writeFile(join(prevDir, 'keep'), 'cached')
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
    const { bootstrap } = createBootstrap('ok')
    expect((await bootstrap.start()).status).toBe('ready')
    expect((await readPointer(root))?.runtimeId).toBe(manifest.runtimeId)
    expect(await readFile(join(prevDir, 'keep'), 'utf-8')).toBe('cached')
    expect(existsSync(runtimeDir(root, manifest.runtimeId))).toBe(true)
  })

  it('실패 후 retry가 성공하면 포인터를 기록하고 whenReady가 resolve된다', async () => {
    const { bootstrap, statuses } = createBootstrap('flaky')
    let ready = false
    void bootstrap.whenReady().then(() => {
      ready = true
    })

    expect((await bootstrap.start()).status).toBe('error')
    expect(await readPointer(root)).toBeNull()
    expect(ready).toBe(false)

    const state = await bootstrap.retry()
    expect(state.status).toBe('ready')
    expect(state.error).toBeNull()
    expect(statuses[0]).toBe('checking')
    expect(statuses).toContain('error')
    expect(statuses[statuses.length - 1]).toBe('ready')
    expect((await readPointer(root))?.runtimeId).toBe(manifest.runtimeId)
    await bootstrap.whenReady()
    expect(ready).toBe(true)
  })

  it('진행 중에 start를 다시 불러도 같은 실행을 공유한다', async () => {
    const { bootstrap } = createBootstrap('ok')
    const first = bootstrap.start()
    const second = bootstrap.start()
    expect(second).toBe(first)
    expect((await first).status).toBe('ready')
  })

  it('준비 도중 dispose하면 이전 포인터를 유지한다', async () => {
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
    let release!: () => void
    const hold = new Promise<void>((resolve) => {
      release = resolve
    })
    let entered!: () => void
    const started = new Promise<void>((resolve) => {
      entered = resolve
    })
    const { bootstrap } = createBootstrap('ok', {
      envPrep: {
        prepare: async (ctx) => {
          entered()
          await hold
          if (ctx.signal?.aborted) {
            const err = new Error('aborted') as Error & { code: string }
            err.name = 'AbortError'
            err.code = 'ABORT_ERR'
            throw err
          }
          return envPrepOk().prepare!(ctx)
        }
      }
    })
    const pending = bootstrap.start()
    await started
    bootstrap.dispose()
    release()
    const state = await pending
    expect(state.status).toBe('error')
    expect(state.retryable).toBe(false)
    expect((await readPointer(root))?.runtimeId).toBe('previous')
  })

  it('manifest 없이 start하면 재시도 불가능한 error이고 retry는 no-op이다', async () => {
    const bootstrap = new SidecarBootstrap({
      bundledSidecarDir: bundled,
      targetSidecarDir: target,
      uvCommand: process.execPath,
      onLog: () => {}
    })
    const state = await bootstrap.start()
    expect(state.status).toBe('error')
    expect(state.error).toContain('runtime manifest가 필요합니다')
    expect(state.retryable).toBe(false)
    await expect(bootstrap.retry()).resolves.toBe(state)
  })

  it('검증되지 않은 manifest는 재구성 전에 실패하므로 재시도 불가능하다', async () => {
    const { bootstrap } = createBootstrap('ok', {
      manifest: { ...manifest, runtimeId: '0'.repeat(64) }
    })
    const state = await bootstrap.start()
    expect(state.status).toBe('error')
    expect(state.error).toContain('runtimeId does not match execution inputs')
    expect(state.retryable).toBe(false)
  })

  it('.python-version 변경은 프로젝트 해시를 바꾼다', async () => {
    const initial = await computeProjectHash(bundled)
    await writeFile(join(bundled, 'src', 'karaoke_worker', '__pycache__', 'new.pyc'), 'cache')
    expect(await computeProjectHash(bundled)).toBe(initial)
    await writeFile(join(bundled, '.python-version'), '3.13\n')
    expect(await computeProjectHash(bundled)).not.toBe(initial)
  })

  it('manifest 검증 실패 시 도구 준비도 시작하지 않는다', async () => {
    const prepareUv = vi.fn(async () => process.execPath)
    const onManifestVerified = vi.fn()
    const { bootstrap } = createBootstrap('ok', {
      manifest: { ...manifest, runtimeId: '0'.repeat(64) },
      prepareUv,
      onManifestVerified
    })
    expect((await bootstrap.start()).status).toBe('error')
    expect(prepareUv).not.toHaveBeenCalled()
    expect(onManifestVerified).not.toHaveBeenCalled()
  })

  it('uv 준비 실패 후 재시도하고 URL 도구 완료를 기다리지 않는다', async () => {
    const prepareUv = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error('uv download failed'))
      .mockResolvedValue(process.execPath)
    const onManifestVerified = vi.fn()
    const { bootstrap } = createBootstrap('ok', { prepareUv, onManifestVerified })
    expect((await bootstrap.start()).status).toBe('error')
    expect(await readPointer(root)).toBeNull()
    expect((await bootstrap.retry()).status).toBe('ready')
    expect(prepareUv).toHaveBeenCalledTimes(2)
    expect(onManifestVerified).toHaveBeenCalledTimes(2)
  })

  it('uv 다운로드 중 종료한 뒤 늦게 완료되어도 ready를 게시하지 않는다', async () => {
    let entered!: () => void
    const started = new Promise<void>((resolve) => {
      entered = resolve
    })
    let release!: (value: string) => void
    const pendingUv = new Promise<string>((resolve) => {
      release = resolve
    })
    const { bootstrap, statuses } = createBootstrap('ok', {
      prepareUv: async () => {
        entered()
        return pendingUv
      }
    })
    const pending = bootstrap.start()
    await started
    bootstrap.dispose()
    release(process.execPath)
    expect((await pending).status).toBe('error')
    expect(statuses).not.toContain('ready')
    expect(await readPointer(root)).toBeNull()
  })
})
