import http from 'http'
import { mkdir, writeFile } from 'fs/promises'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  sha256Hex,
  type Artifact,
  type EnvPrepContext,
  type EnvPrepHooks,
  type EnvPrepResult,
  type LockFile,
  type RuntimeLockSet,
  type RuntimeManifest,
  buildRuntimeManifest,
  runtimeInputDigests
} from '../../runtime'
import { writeFileSync } from 'fs'

export function tempDir(prefix = 'karaoke-rt-'): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

export async function writeMiniSidecar(dir: string): Promise<void> {
  await mkdir(join(dir, 'src', 'karaoke_worker'), { recursive: true })
  await writeFile(join(dir, '.python-version'), '3.12\n')
  await writeFile(join(dir, 'pyproject.toml'), '[project]\nname = "karaoke-worker"\n')
  await writeFile(join(dir, 'uv.lock'), 'version = 1\n[[package]]\nname = "torch"\n')
  await writeFile(join(dir, 'src', 'karaoke_worker', '__init__.py'), '')
  await writeFile(join(dir, 'src', 'karaoke_worker', 'cli.py'), 'def main(): pass\n')
}

export function fileArtifact(opts: {
  id?: string
  data: Buffer | string
  dest?: string
  url: string
  kind?: Artifact['kind']
}): Artifact {
  const buf = Buffer.isBuffer(opts.data) ? opts.data : Buffer.from(opts.data)
  return {
    id: opts.id ?? 'sample',
    kind: opts.kind ?? 'file',
    version: '1.0.0',
    revision: null,
    platform: 'win32-x64',
    url: opts.url,
    size: buf.length,
    sha256: sha256Hex(buf),
    dest: opts.dest ?? 'resources/bin/sample.bin',
    source: 'github.com/astral-sh/uv',
    license: 'MIT',
    capability: 'always'
  }
}

export function dummySha(seed: string): string {
  return sha256Hex(seed)
}

export function miniLocks(
  opts: { pythonBytes?: Buffer; wheelBytes?: Buffer; uvBytes?: Buffer } = {}
): RuntimeLockSet {
  const pythonBytes = opts.pythonBytes ?? Buffer.from('fake-cpython')
  const wheelBytes = opts.wheelBytes ?? Buffer.from('fake-wheel')
  const uvBytes = opts.uvBytes ?? Buffer.from('fake-uv')
  const tools: LockFile = {
    schemaVersion: 1,
    kind: 'tools',
    platform: 'win32-x64',
    artifacts: [
      {
        id: 'uv',
        kind: 'file',
        version: '0.12.9',
        revision: null,
        platform: 'win32-x64',
        url: 'https://github.com/astral-sh/uv/releases/download/0.12.9/uv.exe',
        size: uvBytes.length,
        sha256: sha256Hex(uvBytes),
        dest: 'resources/bin/uv.exe',
        source: 'github.com/astral-sh/uv',
        license: 'MIT',
        capability: 'always'
      }
    ]
  }
  const python: LockFile = {
    schemaVersion: 1,
    kind: 'python',
    platform: 'win32-x64',
    python: {
      requiresMajorMinor: '3.12',
      implementation: 'cpython',
      patch: '3.12.14',
      distributionBuild: '20260901'
    },
    artifacts: [
      {
        id: 'cpython',
        kind: 'file',
        version: '3.12.14+20260901',
        revision: null,
        platform: 'win32-x64',
        url: 'https://github.com/astral-sh/python-build-standalone/releases/download/x/python.exe',
        size: pythonBytes.length,
        sha256: sha256Hex(pythonBytes),
        dest: 'python/python.exe',
        source: 'github.com/astral-sh/python-build-standalone',
        license: 'PSF-2.0',
        capability: 'always'
      }
    ]
  }
  const wheels: LockFile = {
    schemaVersion: 1,
    kind: 'wheels',
    platform: 'win32-x64',
    uvLockDigest: `sha256:${dummySha('uv.lock')}`,
    artifacts: [
      {
        id: 'marker',
        kind: 'wheel',
        version: '1.0.0',
        revision: null,
        platform: 'win32-x64',
        url: 'https://files.pythonhosted.org/packages/marker-1.0.0-py3-none-any.whl',
        size: wheelBytes.length,
        sha256: sha256Hex(wheelBytes),
        dest: 'wheels/marker-1.0.0-py3-none-any.whl',
        source: 'files.pythonhosted.org',
        license: 'MIT',
        wheelTag: 'py3-none-any',
        userPcBuild: false
      }
    ]
  }
  const models: LockFile = {
    schemaVersion: 1,
    kind: 'models',
    platform: 'win32-x64',
    artifacts: [],
    models: []
  }
  return { tools, python, wheels, models }
}

export async function miniManifest(
  sidecarDir: string,
  locks: RuntimeLockSet = miniLocks()
): Promise<{ manifest: RuntimeManifest; locks: RuntimeLockSet }> {
  const manifest = await buildRuntimeManifest(locks, sidecarDir)
  return { manifest, locks }
}

export function envPrepResult(ctx: EnvPrepContext, ok = true): EnvPrepResult {
  return {
    interpreterPath: process.execPath,
    inventory: {
      packages: {
        marker: {
          wheel: 'marker-1.0.0-py3-none-any.whl',
          sha256: dummySha('wheel'),
          version: '1.0.0'
        }
      }
    },
    smoke: {
      ok,
      module: 'karaoke_worker',
      at: new Date().toISOString(),
      error: ok ? undefined : 'smoke failed'
    },
    inputDigests: runtimeInputDigests(ctx.manifest)
  }
}

export function envPrepOk(
  opts: { onPrepare?: (ctx: EnvPrepContext) => Promise<void> | void } = {}
): EnvPrepHooks {
  return {
    prepare: async (ctx) => {
      await mkdir(join(ctx.runtimeDir, 'venv', 'Scripts'), { recursive: true })
      await writeFile(join(ctx.runtimeDir, 'venv', 'Scripts', 'python.exe'), 'fake-python')
      await opts.onPrepare?.(ctx)
      return envPrepResult(ctx, true)
    }
  }
}

export function envPrepFail(): EnvPrepHooks {
  return {
    prepare: async () => {
      throw new Error('env prep failed')
    }
  }
}

export function envPrepFlaky(markerPath: string): EnvPrepHooks {
  return {
    prepare: async (ctx) => {
      const { existsSync } = await import('fs')
      if (!existsSync(markerPath)) {
        writeFileSync(markerPath, '1')
        throw new Error('transient env prep failure')
      }
      await mkdir(join(ctx.runtimeDir, 'venv', 'Scripts'), { recursive: true })
      await writeFile(join(ctx.runtimeDir, 'venv', 'Scripts', 'python.exe'), 'fake-python')
      return envPrepResult(ctx, true)
    }
  }
}

export function startStaticServer(
  files: Record<string, Buffer>,
  opts: { delayMs?: number } = {}
): Promise<{
  port: number
  url: (path: string) => string
  hits: () => number
  close: () => Promise<void>
}> {
  const delayMs = opts.delayMs ?? 0
  let hits = 0
  const server = http.createServer(async (req, res) => {
    const key = (req.url ?? '').split('?')[0]
    const body = files[key]
    if (!body) {
      res.writeHead(404)
      res.end()
      return
    }
    hits += 1
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs))
    if (req.destroyed) return
    res.writeHead(200, {
      'content-length': body.length,
      'content-type': 'application/octet-stream'
    })
    if (req.method === 'HEAD') {
      res.end()
      return
    }
    res.end(body)
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      resolve({
        port,
        url: (path) => `http://127.0.0.1:${port}${path}`,
        hits: () => hits,
        close: () =>
          new Promise((r) => {
            server.close(() => r())
          })
      })
    })
  })
}
