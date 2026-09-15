import http from 'node:http'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sha256Hex } from '../../runtime-lock/schema.mjs'

export function tempDir(prefix = 'rtlock-') {
  return mkdtempSync(join(tmpdir(), prefix))
}

export function fileArtifact({ id = 'sample', data, dest = 'resources/bin/sample.bin', url }) {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data)
  return {
    artifact: {
      id,
      kind: 'file',
      version: '1.0.0',
      revision: null,
      platform: 'win32-x64',
      url,
      size: buf.length,
      sha256: sha256Hex(buf),
      dest,
      source: '127.0.0.1',
      license: 'MIT',
      capability: 'always'
    },
    buf
  }
}

export function startStaticServer(files, opts = {}) {
  let hits = 0
  const delayMs = opts.delayMs ?? 0
  const server = http.createServer(async (req, res) => {
    const key = req.url.split('?')[0]
    const body = files[key]
    if (!body) {
      res.writeHead(404)
      res.end()
      return
    }
    hits += 1
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs))
    if (req.aborted || req.destroyed) return
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
      const { port } = server.address()
      resolve({
        server,
        port,
        url: (path) => `http://127.0.0.1:${port}${path}`,
        hits: () => hits,
        close: () => new Promise((r) => server.close(r))
      })
    })
  })
}

export function writeMiniSidecar(root) {
  const sidecar = join(root, 'sidecar')
  mkdirSync(sidecar, { recursive: true })
  writeFileSync(join(sidecar, '.python-version'), '3.12\n')
  writeFileSync(
    join(sidecar, 'pyproject.toml'),
    `[project]\nname = "karaoke-worker"\nversion = "0.1.0"\n[build-system]\nrequires = ["hatchling"]\nbuild-backend = "hatchling.build"\n`
  )
  writeFileSync(
    join(sidecar, 'uv.lock'),
    `version = 1\nrevision = 3\nrequires-python = ">=3.11, <3.13"\n\n[[package]]\nname = "karaoke-worker"\nversion = "0.1.0"\nsource = { editable = "." }\n`
  )
  writeFileSync(join(sidecar, 'LICENSE'), 'Apache-2.0\n')
  mkdirSync(join(sidecar, 'src', 'karaoke_worker'), { recursive: true })
  writeFileSync(join(sidecar, 'src', 'karaoke_worker', '__init__.py'), '')
}

export function baseLock(kind, artifacts, extra = {}) {
  return {
    schemaVersion: 1,
    kind,
    platform: 'win32-x64',
    artifacts,
    ...extra
  }
}
