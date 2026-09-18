import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { verifyPackage } from '../../runtime-lock/package.mjs'
import { getDistributionPolicy, sha256Hex } from '../../runtime-lock/schema.mjs'
import { writeRuntimeManifest } from '../../../electron-builder.manifest.mjs'
import { baseLock, tempDir, writeMiniSidecar } from './helpers.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const require = createRequire(import.meta.url)
const builderRequire = createRequire(require.resolve('electron-builder/package.json'))
const asar = builderRequire('@electron/asar')
const bytes = {
  uv: Buffer.from('fixture-uv-executable'),
  uvw: Buffer.from('fixture-uvw-executable'),
  uvx: Buffer.from('fixture-uvx-executable'),
  deno: Buffer.from('fixture-deno-executable'),
  'yt-dlp': Buffer.from('fixture-yt-dlp-executable'),
  uvArchive: Buffer.from('fixture-uv-archive'),
  denoArchive: Buffer.from('fixture-deno-archive')
}

function artifactFile(id, data) {
  return {
    id,
    kind: 'file',
    version: '1.0.0',
    revision: null,
    platform: 'win32-x64',
    url: `https://github.com/example/${id}/releases/download/1/${id}.exe`,
    size: data.length,
    sha256: sha256Hex(data),
    dest: `resources/bin/${id}.exe`,
    source: `github.com/example/${id}`,
    license: 'MIT',
    capability: id === 'yt-dlp' ? 'zip-url-import' : 'always'
  }
}

function artifactArchive(id, archiveBytes, members) {
  return {
    ...artifactFile(id, archiveBytes),
    kind: 'archive',
    url: `https://github.com/example/${id}/releases/download/1/${id}-windows.zip`,
    archive: {
      format: 'zip',
      files: members.map(([name, data]) => ({
        path: `${name}.exe`,
        size: data.length,
        sha256: sha256Hex(data),
        executable: true,
        dest: `resources/bin/${name}.exe`
      }))
    }
  }
}

function writeLockSet(root) {
  const locksDir = join(root, 'locks-source')
  mkdirSync(locksDir, { recursive: true })
  const tools = baseLock('tools', [
    artifactArchive('uv', bytes.uvArchive, [
      ['uv', bytes.uv],
      ['uvw', bytes.uvw],
      ['uvx', bytes.uvx]
    ]),
    artifactFile('yt-dlp', bytes['yt-dlp']),
    artifactArchive('deno', bytes.denoArchive, [['deno', bytes.deno]])
  ])
  const python = {
    ...baseLock('python', []),
    python: {
      requiresMajorMinor: '3.12',
      implementation: 'cpython',
      patch: '3.12.14',
      distributionBuild: '20260901'
    }
  }
  const wheels = {
    ...baseLock('wheels', []),
    uvLockDigest: `sha256:${sha256Hex(readFileSync(join(root, 'sidecar', 'uv.lock')))}`,
    python: { requiresMajorMinor: '3.12', implementation: 'cpython' }
  }
  const models = { ...baseLock('models', []), models: [] }
  for (const [name, value] of Object.entries({ tools, python, wheels, models })) {
    writeFileSync(join(locksDir, `${name}.lock.json`), `${JSON.stringify(value, null, 2)}\n`)
    writeFileSync(join(locksDir, `${name}.provenance.json`), '{}\n')
  }
  return locksDir
}

async function fixture(target, asarFiles = { 'main.js': Buffer.from('console.log("fixture")') }) {
  const root = tempDir('pkg-strict-')
  writeMiniSidecar(root)
  const locksDir = writeLockSet(root)
  const input = join(root, 'app')
  const resources = join(input, 'resources')
  mkdirSync(resources, { recursive: true })
  for (const name of ['LICENSE', 'LICENSE_SCOPE.md', 'NOTICE', 'THIRD-PARTY-NOTICES.txt']) {
    writeFileSync(join(input, name), `${name} fixture\n`)
  }
  cpSync(join(root, 'sidecar'), join(resources, 'sidecar'), { recursive: true })
  cpSync(locksDir, join(resources, 'locks'), { recursive: true })
  const policy = getDistributionPolicy(target)
  for (const id of ['uv', 'deno', 'yt-dlp']) {
    if (policy.toolDelivery[id] !== 'bundled') continue
    mkdirSync(join(resources, 'bin'), { recursive: true })
    writeFileSync(join(resources, 'bin', `${id}.exe`), bytes[id])
  }
  const asarSource = join(root, 'asar-source')
  for (const [name, data] of Object.entries(asarFiles)) {
    const path = join(asarSource, name)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, data)
  }
  await asar.createPackage(asarSource, join(resources, 'app.asar'))
  await writeRuntimeManifest({
    target,
    locksDir: join(resources, 'locks'),
    sidecarDir: join(resources, 'sidecar'),
    outPath: join(resources, 'runtime-manifest.json')
  })
  return { root, input, locksDir }
}

async function repositoryNsisFixture() {
  const root = tempDir('pkg-cli-')
  const input = join(root, 'app')
  const resources = join(input, 'resources')
  const sidecar = join(resources, 'sidecar')
  mkdirSync(sidecar, { recursive: true })
  for (const name of ['LICENSE', 'LICENSE_SCOPE.md', 'NOTICE', 'THIRD-PARTY-NOTICES.txt']) {
    writeFileSync(join(input, name), `${name} fixture\n`)
  }
  for (const name of ['.python-version', 'pyproject.toml', 'uv.lock', 'LICENSE']) {
    cpSync(join(repoRoot, 'sidecar', name), join(sidecar, name))
  }
  cpSync(join(repoRoot, 'sidecar', 'src'), join(sidecar, 'src'), { recursive: true })
  cpSync(join(repoRoot, 'build', 'locks'), join(resources, 'locks'), { recursive: true })
  const asarSource = join(root, 'asar-source')
  mkdirSync(asarSource, { recursive: true })
  writeFileSync(join(asarSource, 'main.js'), 'console.log("fixture")')
  await asar.createPackage(asarSource, join(resources, 'app.asar'))
  await writeRuntimeManifest({
    target: 'nsis',
    locksDir: join(resources, 'locks'),
    sidecarDir: sidecar,
    outPath: join(resources, 'runtime-manifest.json')
  })
  return { root, input }
}

function messages(result) {
  return result.errors.map((error) => error.message).join('\n')
}

for (const target of ['nsis', 'zip', 'appx']) {
  test(`${target} verifies manifest, locks, sidecar, asar and final tool bytes`, async () => {
    const built = await fixture(target)
    const result = verifyPackage({ target, input: built.input, locksDir: built.locksDir })
    assert.equal(result.ok, true, messages(result))
    rmSync(built.root, { recursive: true, force: true })
  })
}

test('bundled executable with the right name but wrong bytes is rejected', async () => {
  const built = await fixture('zip')
  writeFileSync(join(built.input, 'resources', 'bin', 'uv.exe'), 'tampered')
  const result = verifyPackage({ target: 'zip', input: built.input, locksDir: built.locksDir })
  assert.equal(result.ok, false)
  assert.match(messages(result), /final bytes do not match lock/)
})

test('NSIS rejects renamed tool bytes and tool archives anywhere in payload', async () => {
  const built = await fixture('nsis')
  writeFileSync(join(built.input, 'renamed.dat'), bytes.deno)
  writeFileSync(join(built.input, 'uv-windows.zip'), bytes.uvArchive)
  mkdirSync(join(built.input, 'resources', 'app.asar.unpacked', 'native'), { recursive: true })
  writeFileSync(
    join(built.input, 'resources', 'app.asar.unpacked', 'native', 'renamed.node'),
    bytes.uvw
  )
  const result = verifyPackage({ target: 'nsis', input: built.input, locksDir: built.locksDir })
  assert.equal(result.ok, false)
  assert.match(messages(result), /forbidden tool bytes found/)
})

test('NSIS rejects a tool hidden inside app.asar', async () => {
  const built = await fixture('nsis', {
    'main.js': Buffer.from('fixture'),
    'hidden/renamed.bin': bytes['yt-dlp']
  })
  const result = verifyPackage({ target: 'nsis', input: built.input, locksDir: built.locksDir })
  assert.equal(result.ok, false)
  assert.match(messages(result), /app\.asar:hidden\/renamed\.bin/)
})

test('manifest policy mismatch and sidecar mutation are rejected', async () => {
  const built = await fixture('nsis')
  const manifestPath = join(built.input, 'resources', 'runtime-manifest.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  manifest.capabilities.urlImport = false
  writeFileSync(manifestPath, JSON.stringify(manifest))
  writeFileSync(join(built.input, 'resources', 'sidecar', 'pyproject.toml'), 'changed')
  const result = verifyPackage({ target: 'nsis', input: built.input, locksDir: built.locksDir })
  assert.equal(result.ok, false)
  assert.match(messages(result), /urlImport does not match nsis distribution policy/)
  assert.match(messages(result), /sidecarSourceDigest mismatch/)
})

test('runtimeId stays identical across distribution channels', async () => {
  const runtimeIds = []
  for (const target of ['nsis', 'zip', 'appx']) {
    const built = await fixture(target)
    const manifest = JSON.parse(
      readFileSync(join(built.input, 'resources', 'runtime-manifest.json'), 'utf8')
    )
    runtimeIds.push(manifest.runtimeId)
  }
  assert.equal(new Set(runtimeIds).size, 1)
})

test('null, falsy and array manifests cannot bypass validation', async () => {
  const built = await fixture('nsis')
  const manifestPath = join(built.input, 'resources', 'runtime-manifest.json')
  for (const invalid of [null, false, 0, '', []]) {
    writeFileSync(manifestPath, JSON.stringify(invalid))
    const result = verifyPackage({ target: 'nsis', input: built.input, locksDir: built.locksDir })
    assert.equal(result.ok, false)
    assert.match(messages(result), /runtime manifest must be an object/)
  }
})

test('matching manifest and locks still require every declared tool', async () => {
  const built = await fixture('nsis')
  const resources = join(built.input, 'resources')
  const tools = JSON.parse(readFileSync(join(built.locksDir, 'tools.lock.json'), 'utf8'))
  tools.artifacts = tools.artifacts.filter((artifact) => artifact.id !== 'deno')
  for (const dir of [built.locksDir, join(resources, 'locks')]) {
    writeFileSync(join(dir, 'tools.lock.json'), JSON.stringify(tools))
  }
  await writeRuntimeManifest({
    target: 'nsis',
    locksDir: join(resources, 'locks'),
    sidecarDir: join(resources, 'sidecar'),
    outPath: join(resources, 'runtime-manifest.json')
  })
  const result = verifyPackage({ target: 'nsis', input: built.input, locksDir: built.locksDir })
  assert.equal(result.ok, false)
  assert.match(messages(result), /missing tool lock entry: deno/)
})

test('CLI exits 0 for a valid NSIS fixture and 1 after forbidden-tool injection', async () => {
  const built = await repositoryNsisFixture()
  const args = [
    join(repoRoot, 'scripts/runtime-lock/cli.mjs'),
    'verify-package',
    '--target',
    'nsis',
    '--input',
    built.input
  ]
  const accepted = spawnSync(process.execPath, args, { cwd: repoRoot, encoding: 'utf8' })
  assert.equal(accepted.status, 0, `${accepted.stdout}\n${accepted.stderr}`)

  mkdirSync(join(built.input, 'resources', 'bin'), { recursive: true })
  writeFileSync(join(built.input, 'resources', 'bin', 'uv.exe'), 'injected')
  const rejected = spawnSync(process.execPath, args, { cwd: repoRoot, encoding: 'utf8' })
  assert.equal(rejected.status, 1)
  assert.match(`${rejected.stdout}\n${rejected.stderr}`, /forbidden tool payload/)
})
