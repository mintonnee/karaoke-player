import { createHash } from 'crypto'
import { existsSync } from 'fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { BootstrapState, BootstrapStatus } from '../../../shared/types'
import {
  READY_MARKER_FILE,
  SidecarBootstrap,
  buildUvEnv,
  copySidecarProject,
  isSidecarReady,
  shouldCopySidecarPath
} from '../SidecarBootstrap'

const FAKE_UV = join(process.cwd(), 'src', 'main', 'sidecar', '__tests__', 'fake_uv.mjs')
const LOCK_CONTENT = 'version = 1\n[[package]]\nname = "torch"\n'
const LOCK_HASH = createHash('sha256').update(LOCK_CONTENT).digest('hex')

let root: string
let bundled: string
let target: string

async function writeBundled(): Promise<void> {
  await mkdir(join(bundled, 'src', 'karaoke_worker', '__pycache__'), { recursive: true })
  await mkdir(join(bundled, 'src', 'karaoke_worker.egg-info'), { recursive: true })
  await mkdir(join(bundled, '.venv', 'Scripts'), { recursive: true })
  await writeFile(join(bundled, 'pyproject.toml'), '[project]\nname = "karaoke-worker"\n')
  await writeFile(join(bundled, 'uv.lock'), LOCK_CONTENT)
  await writeFile(join(bundled, 'src', 'karaoke_worker', '__init__.py'), '')
  await writeFile(join(bundled, 'src', 'karaoke_worker', 'cli.py'), 'def main(): pass\n')
  await writeFile(join(bundled, 'src', 'karaoke_worker', '__pycache__', 'cli.pyc'), 'bin')
  await writeFile(join(bundled, 'src', 'karaoke_worker.egg-info', 'PKG-INFO'), 'x')
  await writeFile(join(bundled, '.venv', 'pyvenv.cfg'), 'home = C:\\python\n')
}

function createBootstrap(mode: 'ok' | 'fail' | 'flaky'): {
  bootstrap: SidecarBootstrap
  statuses: BootstrapStatus[]
} {
  const statuses: BootstrapStatus[] = []
  const args = mode === 'flaky' ? [FAKE_UV, 'flaky', join(root, 'flaky.marker')] : [FAKE_UV, mode]
  const bootstrap = new SidecarBootstrap({
    bundledSidecarDir: bundled,
    targetSidecarDir: target,
    uvCommand: process.execPath,
    syncArgs: args,
    env: { KARAOKE_TEST: '1' },
    onLog: () => {}
  })
  bootstrap.onChange((state: BootstrapState) => {
    if (statuses[statuses.length - 1] !== state.status) statuses.push(state.status)
  })
  return { bootstrap, statuses }
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'karaoke-bootstrap-'))
  bundled = join(root, 'bundled')
  target = join(root, 'target')
  await writeBundled()
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('shouldCopySidecarPath', () => {
  it('.venv/__pycache__/*.pyc/egg-info/.ready를 제외한다', () => {
    expect(shouldCopySidecarPath('')).toBe(true)
    expect(shouldCopySidecarPath('pyproject.toml')).toBe(true)
    expect(shouldCopySidecarPath('uv.lock')).toBe(true)
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
    expect(existsSync(join(target, 'src', 'karaoke_worker', 'cli.py'))).toBe(true)
    expect(existsSync(join(target, 'src', 'karaoke_worker', '__pycache__'))).toBe(false)
    expect(existsSync(join(target, 'src', 'karaoke_worker.egg-info'))).toBe(false)
    expect(existsSync(join(target, '.venv', 'pyvenv.cfg'))).toBe(false)
    expect(existsSync(join(target, '.venv', 'keep'))).toBe(true)
    expect(existsSync(join(target, READY_MARKER_FILE))).toBe(false)
  })
})

describe('isSidecarReady', () => {
  it('마커 부재 → false', async () => {
    expect(await isSidecarReady(bundled, target)).toBe(false)
  })

  it('마커 일치 + .venv 존재 → true', async () => {
    await mkdir(join(target, '.venv'), { recursive: true })
    await writeFile(join(target, READY_MARKER_FILE), `${LOCK_HASH}\n`)
    expect(await isSidecarReady(bundled, target)).toBe(true)
  })

  it('마커 불일치 → false', async () => {
    await mkdir(join(target, '.venv'), { recursive: true })
    await writeFile(join(target, READY_MARKER_FILE), 'deadbeef\n')
    expect(await isSidecarReady(bundled, target)).toBe(false)
  })

  it('마커 일치해도 .venv가 없으면 false', async () => {
    await mkdir(target, { recursive: true })
    await writeFile(join(target, READY_MARKER_FILE), `${LOCK_HASH}\n`)
    expect(await isSidecarReady(bundled, target)).toBe(false)
  })
})

describe('SidecarBootstrap', () => {
  it('첫 실행: 복사 → sync → ready, 마커에 lock 해시를 기록한다', async () => {
    const { bootstrap, statuses } = createBootstrap('ok')
    // fake uv는 .venv를 만들지 않으므로 마커 검증만 본다
    const state = await bootstrap.start()

    expect(state.status).toBe('ready')
    expect(statuses).toEqual(['checking', 'copying', 'syncing', 'ready'])
    expect(existsSync(join(target, 'src', 'karaoke_worker', 'cli.py'))).toBe(true)
    expect(existsSync(join(target, 'src', 'karaoke_worker', '__pycache__'))).toBe(false)
    expect((await readFile(join(target, READY_MARKER_FILE), 'utf-8')).trim()).toBe(LOCK_HASH)
    expect(state.log.some((line) => line.includes('Installed 42 packages'))).toBe(true)
    await expect(bootstrap.whenReady()).resolves.toBeUndefined()
  })

  it('마커가 일치하면 sync를 건너뛰고 즉시 ready', async () => {
    await mkdir(join(target, '.venv'), { recursive: true })
    await writeFile(join(target, READY_MARKER_FILE), `${LOCK_HASH}\n`)
    // uv가 실패하는 모드라도 호출되지 않으므로 ready여야 한다
    const { bootstrap, statuses } = createBootstrap('fail')
    const state = await bootstrap.start()

    expect(state.status).toBe('ready')
    expect(statuses).toEqual(['checking', 'ready'])
    expect(state.log).toEqual([])
  })

  it('마커 불일치(앱 업데이트)면 재복사 + 재sync 후 마커를 갱신한다', async () => {
    await mkdir(join(target, 'src'), { recursive: true })
    await mkdir(join(target, '.venv'), { recursive: true })
    await writeFile(join(target, READY_MARKER_FILE), 'old-hash\n')
    await writeFile(join(target, 'src', 'stale.py'), '')
    const { bootstrap, statuses } = createBootstrap('ok')
    const state = await bootstrap.start()

    expect(state.status).toBe('ready')
    expect(statuses).toEqual(['checking', 'copying', 'syncing', 'ready'])
    expect(existsSync(join(target, 'src', 'stale.py'))).toBe(false)
    expect(existsSync(join(target, '.venv'))).toBe(true)
    expect((await readFile(join(target, READY_MARKER_FILE), 'utf-8')).trim()).toBe(LOCK_HASH)
  })

  it('sync 실패 → error, 마커를 남기지 않는다', async () => {
    const { bootstrap, statuses } = createBootstrap('fail')
    const state = await bootstrap.start()

    expect(state.status).toBe('error')
    expect(state.error).toContain('uv sync 종료 코드 1')
    expect(state.log.some((line) => line.includes('network unreachable'))).toBe(true)
    expect(statuses).toEqual(['checking', 'copying', 'syncing', 'error'])
    expect(existsSync(join(target, READY_MARKER_FILE))).toBe(false)
  })

  it('실패 후 retry가 성공하면 ready + 마커 기록, whenReady가 resolve된다', async () => {
    const { bootstrap, statuses } = createBootstrap('flaky')
    let ready = false
    void bootstrap.whenReady().then(() => {
      ready = true
    })

    expect((await bootstrap.start()).status).toBe('error')
    expect(existsSync(join(target, READY_MARKER_FILE))).toBe(false)
    expect(ready).toBe(false)

    const state = await bootstrap.retry()
    expect(state.status).toBe('ready')
    expect(state.error).toBeNull()
    expect(statuses).toEqual([
      'checking',
      'copying',
      'syncing',
      'error',
      'checking',
      'copying',
      'syncing',
      'ready'
    ])
    expect((await readFile(join(target, READY_MARKER_FILE), 'utf-8')).trim()).toBe(LOCK_HASH)
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

  it('실행 파일이 없으면 error (크래시 없음)', async () => {
    const bootstrap = new SidecarBootstrap({
      bundledSidecarDir: bundled,
      targetSidecarDir: target,
      uvCommand: 'karaoke-player-no-such-uv',
      onLog: () => {}
    })
    const state = await bootstrap.start()
    expect(state.status).toBe('error')
    expect(state.error).toContain('uv 실행 실패')
    expect(existsSync(join(target, READY_MARKER_FILE))).toBe(false)
  })
})
