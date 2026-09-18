import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// 실제 앱의 resolver를 그대로 사용한다. Python/모델이나 설치 프로그램은 실행하지 않는다.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const require = createRequire(import.meta.url)
const viteRequire = createRequire(require.resolve('vite/package.json'))
const { build } = viteRequire('esbuild')
const bundled = await build({
  stdin: {
    contents:
      "export { ToolReadinessController, verifyManifest } from './src/main/runtime/index.ts'",
    resolveDir: root
  },
  bundle: true,
  platform: 'node',
  format: 'esm',
  write: false
})
const { ToolReadinessController, verifyManifest } = await import(
  `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`
)
const resourcesDir = resolve(process.argv[2] ?? join(root, 'dist/nsis/win-unpacked/resources'))
const json = async (path) => JSON.parse(await readFile(path, 'utf8'))
const manifest = await json(join(resourcesDir, 'runtime-manifest.json'))
assert.equal(manifest.distribution, 'nsis')
const locks = Object.fromEntries(
  await Promise.all(
    ['tools', 'python', 'wheels', 'models'].map(async (id) => [
      id,
      await json(join(resourcesDir, 'locks', `${id}.lock.json`))
    ])
  )
)
const verified = await verifyManifest(manifest, locks, join(resourcesDir, 'sidecar'))
assert.equal(verified.ok, true, JSON.stringify(verified.errors))
const reportRoot = join(root, 'dist/nsis/acceptance')
await mkdir(reportRoot, { recursive: true })
const userDataDir = await mkdtemp(join(reportRoot, 'runtime-smoke-'))
let requests = 0
const controller = new ToolReadinessController({
  manifest,
  toolsLock: locks.tools,
  userDataDir,
  resourcesDir,
  fetchImpl: (...args) => {
    requests += 1
    return fetch(...args)
  }
})
const versions = {}
try {
  await Promise.all(
    ['uv', 'deno', 'yt-dlp'].map(async (id) => {
      const executable = await controller.ensure(id)
      versions[id] = execFileSync(executable, ['--version'], {
        encoding: 'utf8',
        timeout: 30_000,
        windowsHide: true
      }).trim()
      assert.ok(versions[id].includes(locks.tools.artifacts.find((a) => a.id === id).version))
    })
  )
} finally {
  controller.dispose()
}
let offlineRequests = 0
const offline = new ToolReadinessController({
  manifest,
  toolsLock: locks.tools,
  userDataDir,
  resourcesDir,
  fetchImpl: () => {
    offlineRequests += 1
    throw new Error('offline smoke must reuse verified cache')
  }
})
try {
  const results = await offline.start()
  assert.ok(results.every((result) => result.status === 'fulfilled'))
  assert.equal(offlineRequests, 0)
} finally {
  offline.dispose()
}
const report = { versions, requests, offlineRequests, installationTested: false }
await writeFile(join(userDataDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`)
console.log(JSON.stringify(report, null, 2))
console.log(`Report: ${join(userDataDir, 'report.json')}`)
