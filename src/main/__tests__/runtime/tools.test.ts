import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, renameSync } from 'fs'
import { join } from 'path'
import { describe, expect, it, vi } from 'vitest'
import {
  ToolReadinessController,
  buildRuntimeManifest,
  createZip,
  sha256Hex,
  getDistributionPolicy,
  type Artifact,
  type RuntimeDistribution,
  type RuntimeLockSet,
  type ToolReadinessControllerOptions
} from '../../runtime'
import { fileArtifact, miniLocks, tempDir, writeMiniSidecar } from './helpers'

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  return { ...actual, renameSync: vi.fn(actual.renameSync) }
})

async function fixture(
  distribution: RuntimeDistribution = 'nsis',
  archive = false
): Promise<{
  dir: string
  options: ToolReadinessControllerOptions
  payloads: Record<'uv' | 'deno' | 'yt-dlp', Buffer>
  locks: RuntimeLockSet
  fetchImpl: typeof fetch
  controller: ToolReadinessController
}> {
  const dir = tempDir()
  const sidecar = join(dir, 'sidecar')
  await writeMiniSidecar(sidecar)
  const locks = miniLocks()
  const payloads = {
    uv: Buffer.from('fake-uv'),
    deno: Buffer.from('fake-deno'),
    'yt-dlp': Buffer.from('fake-ytdlp')
  }
  locks.tools.artifacts = Object.entries(payloads).map(([id, data]) =>
    fileArtifact({
      id,
      data,
      dest: `resources/bin/${id}.exe`,
      url: `https://github.com/test/releases/download/v1/${id}.exe`
    })
  )
  let zip: Buffer | undefined
  if (archive) {
    zip = createZip([
      { name: 'uv.exe', data: payloads.uv },
      { name: 'uvx.exe', data: Buffer.from('uvx') }
    ])
    const uv = locks.tools.artifacts[0]
    Object.assign(uv, {
      kind: 'archive',
      size: zip.length,
      sha256: sha256Hex(zip),
      archive: {
        format: 'zip',
        files: [
          {
            path: 'uv.exe',
            dest: uv.dest,
            sha256: sha256Hex(payloads.uv),
            size: payloads.uv.length,
            executable: true
          },
          {
            path: 'uvx.exe',
            dest: 'resources/bin/uvx.exe',
            sha256: sha256Hex('uvx'),
            size: 3,
            executable: true
          }
        ]
      }
    })
  }
  const manifest = await buildRuntimeManifest(locks, sidecar, distribution)
  const fetchImpl = vi.fn(async (url: string | URL | Request) => {
    const id = String(url).split('/').pop()!.replace('.exe', '') as keyof typeof payloads
    return new Response(new Uint8Array(id === 'uv' && zip ? zip : payloads[id]))
  }) as unknown as typeof fetch
  const options = {
    manifest,
    toolsLock: locks.tools,
    resourcesDir: join(dir, 'resources'),
    userDataDir: join(dir, 'user'),
    fetchImpl
  }
  return {
    dir,
    options,
    payloads,
    locks,
    fetchImpl,
    controller: new ToolReadinessController(options)
  }
}

describe('ToolReadinessController', () => {
  it.each(['EPERM', 'ENOSPC'])(
    'restores quarantined active directory if atomic publication fails with %s',
    async (code) => {
      const f = await fixture()
      const path = await f.controller.ensure('uv')
      writeFileSync(path, 'tamper')
      const actual = await vi.importActual<typeof import('fs')>('fs')
      const spy = vi.mocked(renameSync).mockImplementation((from, to) => {
        if (String(from).includes('.staging-') && !String(from).endsWith('.tmp'))
          throw Object.assign(new Error('publish failed'), { code })
        return actual.renameSync(from, to)
      })
      try {
        await expect(f.controller.ensure('uv')).rejects.toThrow(code)
        expect(f.controller.getSnapshot().tools.uv.status).toBe('error')
        expect(readFileSync(path, 'utf8')).toBe('tamper')
      } finally {
        spy.mockImplementation(actual.renameSync)
      }
    }
  )

  it.each([403, 404, 429, 500])(
    'HTTP %s on a new pinned version preserves old digest without fallback',
    async (status) => {
      const f = await fixture()
      const oldPath = await f.controller.ensure('uv')
      const uv = f.locks.tools.artifacts[0]
      uv.version = '2.0.0'
      uv.sha256 = sha256Hex('new-version')
      uv.size = 'new-version'.length
      uv.url = 'https://github.com/test/releases/download/v2/uv.exe'
      const manifest = await buildRuntimeManifest(f.locks, join(f.dir, 'sidecar'), 'nsis')
      const fetchImpl = vi.fn(async () => new Response(null, { status }))
      const controller = new ToolReadinessController({ ...f.options, manifest, fetchImpl })
      await expect(controller.ensure('uv')).rejects.toThrow(`HTTP_${status}`)
      expect(readFileSync(oldPath)).toEqual(f.payloads.uv)
      expect(existsSync(join(f.options.userDataDir, 'runtime-tools', 'uv', uv.sha256))).toBe(false)
      expect(controller.getSnapshot().tools.uv.status).toBe('error')
      expect(fetchImpl).toHaveBeenCalledTimes(1)
    }
  )

  it('rejects download host outside GitHub even if allowed for Python artifacts', async () => {
    const f = await fixture()
    const fetchImpl = vi.fn(
      async () =>
        new Response(null, {
          status: 302,
          headers: { location: 'https://files.pythonhosted.org/uv.exe' }
        })
    )
    const controller = new ToolReadinessController({ ...f.options, fetchImpl })
    await expect(controller.ensure('uv')).rejects.toThrow('DISALLOWED_HOST')
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })
  it('activates all verified files atomically and restart makes no download request', async () => {
    const f = await fixture('nsis', true)
    const states: string[] = []
    f.controller.onChange((state) => states.push(state.status))
    const path = await f.controller.ensure('uv')
    expect(path).toBe(
      join(
        f.options.userDataDir,
        'runtime-tools',
        'uv',
        f.locks.tools.artifacts[0].sha256,
        'uv.exe'
      )
    )
    expect(readFileSync(path)).toEqual(f.payloads.uv)
    expect(readFileSync(join(path, '..', 'uvx.exe'), 'utf8')).toBe('uvx')
    expect(states).toContain('downloading')
    expect(states.at(-1)).toBe('ready')
    await new ToolReadinessController(f.options).ensure('uv')
    expect(f.fetchImpl).toHaveBeenCalledTimes(1)
    // A missing non-primary executable cannot be mistaken for a ready archive.
    rmSync(join(path, '..', 'uvx.exe'))
    await f.controller.ensure('uv')
    expect(readFileSync(join(path, '..', 'uvx.exe'), 'utf8')).toBe('uvx')
    expect(f.fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('verifies both active file and cache; preserves old digest on failed new version', async () => {
    const f = await fixture()
    const path = await f.controller.ensure('uv')
    writeFileSync(path, 'BAD-uv!')
    await f.controller.ensure('uv')
    expect(readFileSync(path)).toEqual(f.payloads.uv)
    const uv = f.locks.tools.artifacts[0]
    writeFileSync(join(f.options.userDataDir, 'runtime-cache', 'sha256', uv.sha256, 'blob'), 'bad')
    await f.controller.ensure('uv')
    expect(f.fetchImpl).toHaveBeenCalledTimes(2)
    expect(readFileSync(path)).toEqual(f.payloads.uv)
  })

  it('bundled archive accepts verified primary only and never fetches', async () => {
    const f = await fixture('zip', true)
    mkdirSync(join(f.options.resourcesDir, 'bin'), { recursive: true })
    writeFileSync(join(f.options.resourcesDir, 'bin', 'uv.exe'), f.payloads.uv)
    await expect(f.controller.ensure('uv')).resolves.toBe(
      join(f.options.resourcesDir, 'bin', 'uv.exe')
    )
    expect(f.fetchImpl).not.toHaveBeenCalled()
    writeFileSync(join(f.options.resourcesDir, 'bin', 'uv.exe'), 'tamper!')
    await expect(f.controller.ensure('uv')).rejects.toThrow('uv')
    expect(f.controller.getSnapshot().tools.uv.status).toBe('error')
    expect(f.fetchImpl).not.toHaveBeenCalled()
  })

  it('APPX disables yt-dlp regardless of cached files and rejects Store policy mismatch', async () => {
    const f = await fixture('appx')
    expect(f.controller.getSnapshot().tools['yt-dlp'].status).toBe('disabled')
    await expect(f.controller.ensure('yt-dlp')).rejects.toThrow('disabled')
    expect(f.fetchImpl).not.toHaveBeenCalled()
    const nsis = {
      ...f.options.manifest,
      distribution: 'nsis' as const,
      ...structuredClone(getDistributionPolicy('nsis'))
    }
    expect(
      () => new ToolReadinessController({ ...f.options, manifest: nsis, windowsStore: true })
    ).toThrow('Windows Store')
  })

  it('failed transfer retries fixed URL and reports no secrets', async () => {
    const f = await fixture()
    let failing = true
    const fetchImpl = vi.fn(async () => {
      if (failing) throw new Error('https://github.com/a?token=secret')
      return new Response(new Uint8Array(f.payloads.uv))
    })
    const controller = new ToolReadinessController({ ...f.options, fetchImpl })
    await expect(controller.ensure('uv')).rejects.toThrow('uv')
    expect(controller.getSnapshot().tools.uv).toMatchObject({ status: 'error', retryable: true })
    expect(controller.getSnapshot().tools.uv.error).not.toContain('secret')
    failing = false
    const [a, b] = await Promise.all([controller.retry('uv'), controller.retry('uv')])
    expect(a).toBe(b)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('limits concurrent transfers to two and uv completion does not wait for URL tools', async () => {
    const f = await fixture()
    let active = 0
    let max = 0
    const release: Array<() => void> = []
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      active++
      max = Math.max(active, max)
      await new Promise<void>((resolve) => release.push(resolve))
      active--
      const id = String(url).split('/').pop()!.replace('.exe', '') as keyof typeof f.payloads
      return new Response(new Uint8Array(f.payloads[id]))
    }) as unknown as typeof fetch
    const controller = new ToolReadinessController({ ...f.options, fetchImpl })
    const start = controller.start()
    await vi.waitFor(() => expect(release).toHaveLength(2))
    release[0]()
    await vi.waitFor(() => expect(release).toHaveLength(3))
    release[1]()
    release[2]()
    expect((await start).every((x) => x.status === 'fulfilled')).toBe(true)
    expect(max).toBe(2)
  })

  it('cancels one observer immediately; disposal prevents late ready and activation', async () => {
    const f = await fixture()
    let release!: () => void
    const fetchImpl = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        release = resolve
      })
      return new Response(new Uint8Array(f.payloads.uv))
    })
    const controller = new ToolReadinessController({ ...f.options, fetchImpl })
    const ac = new AbortController()
    const cancelled = controller.ensure('uv', { signal: ac.signal })
    const survivor = controller.ensure('uv')
    const rejection = expect(cancelled).rejects.toMatchObject({ name: 'AbortError' })
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1))
    ac.abort()
    await rejection
    controller.dispose()
    release()
    await expect(survivor).rejects.toThrow()
    expect(controller.getSnapshot().tools.uv.status).not.toBe('ready')
    expect(
      existsSync(
        join(f.options.userDataDir, 'runtime-tools', 'uv', f.locks.tools.artifacts[0].sha256)
      )
    ).toBe(false)
  })

  it('does not publish primary if a later archive member fails validation', async () => {
    const f = await fixture('nsis', true)
    const artifact = f.options.toolsLock.artifacts[0] as Artifact
    artifact.archive!.files[1].sha256 = sha256Hex('BAD')
    // Build a valid manifest for the deliberately wrong member lock.
    f.options.manifest = await buildRuntimeManifest(f.locks, join(f.dir, 'sidecar'), 'nsis')
    const controller = new ToolReadinessController(f.options)
    await expect(controller.ensure('uv')).rejects.toThrow()
    expect(existsSync(join(f.options.userDataDir, 'runtime-tools', 'uv', artifact.sha256))).toBe(
      false
    )
  })
})
