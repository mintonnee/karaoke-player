import { mkdirSync, writeFileSync, readFileSync, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { canonicalizeLock, canonicalJson, lockDigest } from './schema.mjs'
import { LOCK_FILES, defaultPaths, readLock } from './verify.mjs'
import { selectRuntimeWheels, uvLockDigestFromFile } from './wheels.mjs'
import { redactUrl } from './hosts.mjs'

/**
 * 검토용 후보만 --output 아래에 쓴다. build/locks 는 절대 덮어쓰지 않는다.
 * @param {{ root: string, output: string, locksDir?: string }} opts
 */
export function proposeLocks(opts) {
  const paths = defaultPaths(opts.root)
  const locksDir = opts.locksDir ?? paths.locksDir
  mkdirSync(opts.output, { recursive: true })

  const before = snapshotLocks(locksDir)
  const current = {}
  for (const [kind, name] of Object.entries(LOCK_FILES)) {
    current[kind] = readLock(locksDir, name).json
  }

  const uvText = readFileSync(paths.uvLock, 'utf8')
  const uvLockDigest = uvLockDigestFromFile(paths.uvLock)
  const pythonVersion = readFileSync(paths.pythonVersion, 'utf8').trim()
  const selected = selectRuntimeWheels(uvText)

  const wheelsCandidate = {
    ...current.wheels,
    uvLockDigest,
    python: { requiresMajorMinor: pythonVersion, implementation: 'cpython' },
    artifacts: selected.artifacts.map((a) => ({
      ...a,
      license: a.license === 'see-package' ? licenseFor(a.id) : a.license
    }))
  }

  const summary = []
  summary.push('# runtime-lock candidate')
  summary.push('')
  summary.push(`uv.lock digest: \`${uvLockDigest}\``)
  summary.push(`.python-version: ${pythonVersion}`)
  summary.push('')
  summary.push('## wheels')
  const curWheels = new Map(
    (current.wheels.artifacts ?? []).map((a) => [`${a.id}==${a.version}`, a])
  )
  for (const art of wheelsCandidate.artifacts) {
    const key = `${art.id}==${art.version}`
    const prev = curWheels.get(key)
    const changed = !prev || prev.sha256 !== art.sha256 || prev.url !== art.url
    summary.push(
      `- ${changed ? 'CHANGE' : 'same'} ${key} ${art.kind} size=${art.size ?? 'unknown'} sha256=${art.sha256 || 'MISSING'} url=${redactUrl(art.url)} license=${art.license}`
    )
  }
  summary.push('')
  summary.push('## tools / python / models')
  summary.push(
    '현재 committed lock을 후보에 복사한다. 업스트림 재조회는 유지보수자가 검토 후 채택한다.'
  )
  summary.push(
    `tools digest ${lockDigest(current.tools)} artifacts=${current.tools.artifacts.length}`
  )
  summary.push(
    `python digest ${lockDigest(current.python)} artifacts=${current.python.artifacts.length}`
  )
  summary.push(
    `models digest ${lockDigest(current.models)} artifacts=${current.models.artifacts.length}`
  )
  if (current.wheels.uvLockDigest !== uvLockDigest) {
    summary.push('')
    summary.push(
      `wheels.lock uvLockDigest 불일치: lock=${current.wheels.uvLockDigest} actual=${uvLockDigest}`
    )
  }

  writeJson(join(opts.output, LOCK_FILES.tools), current.tools)
  writeJson(join(opts.output, LOCK_FILES.python), current.python)
  writeJson(join(opts.output, LOCK_FILES.models), current.models)
  writeJson(join(opts.output, LOCK_FILES.wheels), wheelsCandidate)
  writeFileSync(join(opts.output, 'SUMMARY.md'), summary.join('\n') + '\n', 'utf8')

  const after = snapshotLocks(locksDir)
  const mutated = before.some(
    (b, i) => b.mtimeMs !== after[i].mtimeMs || Buffer.compare(b.bytes, after[i].bytes) !== 0
  )
  if (mutated) {
    throw new Error('propose mutated build/locks — this is a bug')
  }
  return { output: opts.output, uvLockDigest }
}

function writeJson(path, value) {
  writeFileSync(path, `${canonicalJson(canonicalizeLock(value))}\n`, 'utf8')
}

function snapshotLocks(locksDir) {
  return Object.values(LOCK_FILES).map((name) => {
    const path = join(locksDir, name)
    if (!existsSync(path)) return { path, mtimeMs: 0, bytes: Buffer.alloc(0) }
    return { path, mtimeMs: statSync(path).mtimeMs, bytes: readFileSync(path) }
  })
}

function licenseFor(id) {
  const known = {
    torch: 'BSD-3-Clause',
    torchaudio: 'BSD-2-Clause',
    demucs: 'MIT',
    'faster-whisper': 'MIT',
    'beat-this': 'MIT',
    numpy: 'BSD-3-Clause',
    hatchling: 'MIT'
  }
  return known[id] ?? 'see-upstream'
}
