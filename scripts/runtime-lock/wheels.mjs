import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { evaluateMarker, parseUvLock, WIN32_CPYTHON_312 } from './uv-lock.mjs'

const ROOT_NAME = 'karaoke-worker'
const DEV_GROUP = new Set(['pytest', 'iniconfig', 'pluggy', 'pygments'])

/**
 * @param {string} url
 */
export function parseWheelFilename(url) {
  const filename = decodeURIComponent(url.split('?')[0].split('/').pop() ?? '')
  if (!filename.endsWith('.whl')) return null
  const body = filename.slice(0, -4)
  const bits = body.split('-')
  if (bits.length < 5) return null
  const platform = bits.pop()
  const abi = bits.pop()
  const python = bits.pop()
  return { filename, python, abi, platform }
}

/**
 * @param {{ python: string, abi: string, platform: string }} tag
 */
export function wheelScore(tag) {
  const plats = tag.platform.split('.')
  let platScore = -1
  if (plats.includes('win_amd64')) platScore = 100
  else if (plats.includes('any')) platScore = 10
  else return null

  const py = tag.python.split('.')
  let pyScore = -1
  for (const p of py) {
    if (p === 'cp312' || p === 'py312') pyScore = Math.max(pyScore, 50)
    else if (/^cp3\d+$/.test(p) && Number(p.slice(2)) <= 312 && tag.abi === 'abi3') {
      pyScore = Math.max(pyScore, 30)
    } else if (p === 'py3' || p === 'py2.py3' || p === 'py3.py2') pyScore = Math.max(pyScore, 10)
    else if (p === 'cp3') pyScore = Math.max(pyScore, 8)
  }
  if (pyScore < 0) return null

  if (tag.abi !== 'none' && tag.abi !== 'abi3' && tag.abi !== 'cp312') return null
  if (plats.some((p) => /macosx|manylinux|musllinux|linux|win32$|win_arm64|aarch64/.test(p))) {
    if (!plats.includes('win_amd64') && !plats.includes('any')) return null
  }
  return platScore + pyScore
}

/**
 * @param {{ url: string, hash?: string, size?: string | number }[]} wheels
 */
export function selectWindowsWheel(wheels) {
  /** @type {{ url: string, hash: string, size: number | null, tag: ReturnType<typeof parseWheelFilename>, score: number } | null} */
  let best = null
  for (const wheel of wheels) {
    const tag = parseWheelFilename(wheel.url)
    if (!tag) continue
    const score = wheelScore(tag)
    if (score == null) continue
    if (!best || score > best.score) {
      const hash = String(wheel.hash ?? '')
        .replace(/^sha256:/, '')
        .toLowerCase()
      best = {
        url: wheel.url,
        hash,
        size: wheel.size == null || wheel.size === '' ? null : Number(wheel.size),
        tag,
        score
      }
    }
  }
  return best
}

function packageKey(name, version) {
  return `${name}==${version}`
}

function envMatchesPackage(pkg, env) {
  if (!pkg.resolutionMarkers || pkg.resolutionMarkers.length === 0) return true
  return pkg.resolutionMarkers.some((m) => evaluateMarker(m, env))
}

/**
 * Windows x64 / CPython 3.12 런타임 설치 집합.
 * dependency-group `dev`(pytest)는 제외한다.
 * @param {string | { header: object, packages: object[] }} lock
 * @param {Record<string, string>} [env]
 */
export function selectRuntimeWheels(lock, env = WIN32_CPYTHON_312) {
  const parsed = typeof lock === 'string' ? parseUvLock(lock) : lock
  const byName = new Map()
  for (const pkg of parsed.packages) {
    if (!byName.has(pkg.name)) byName.set(pkg.name, [])
    byName.get(pkg.name).push(pkg)
  }

  const selected = new Map()
  const queue = []

  const root = (byName.get(ROOT_NAME) ?? []).find((p) => envMatchesPackage(p, env))
  if (!root) throw new Error('karaoke-worker package not found in uv.lock')
  queue.push(root)

  while (queue.length) {
    const pkg = queue.shift()
    const key = packageKey(pkg.name, pkg.version)
    if (selected.has(key)) continue
    selected.set(key, pkg)
    for (const dep of pkg.dependencies ?? []) {
      if (dep.marker && !evaluateMarker(dep.marker, env)) continue
      const candidates = byName.get(dep.name) ?? []
      const match = candidates.find((c) => {
        if (dep.version && c.version !== dep.version) return false
        return envMatchesPackage(c, env)
      })
      if (match) queue.push(match)
    }
  }

  selected.delete(packageKey(ROOT_NAME, root.version))

  const artifacts = []
  const missing = []
  for (const pkg of selected.values()) {
    if (DEV_GROUP.has(pkg.name) && !isRuntimeReachable(pkg.name, selected, root)) continue
    const wheel = selectWindowsWheel(pkg.wheels ?? [])
    if (wheel) {
      artifacts.push({
        id: pkg.name,
        kind: 'wheel',
        version: pkg.version,
        platform: 'win32-x64',
        url: wheel.url,
        size: wheel.size,
        sha256: wheel.hash,
        dest: `wheels/${wheel.tag.filename}`,
        source: pkg.source?.registry ?? 'pypi',
        license: 'see-package',
        wheelTag: `${wheel.tag.python}-${wheel.tag.abi}-${wheel.tag.platform}`,
        userPcBuild: false
      })
      continue
    }
    if (pkg.sdist?.url) {
      artifacts.push({
        id: pkg.name,
        kind: 'sdist-build',
        version: pkg.version,
        platform: 'win32-x64',
        url: pkg.sdist.url,
        size: pkg.sdist.size == null ? 0 : Number(pkg.sdist.size),
        sha256: String(pkg.sdist.hash ?? '')
          .replace(/^sha256:/, '')
          .toLowerCase(),
        dest: `sdists/${pkg.name}-${pkg.version}.tar.gz`,
        source: pkg.source?.registry ?? 'pypi',
        license: 'see-package',
        buildEnvironment: 'controlled',
        userPcBuild: false
      })
      continue
    }
    missing.push(`${pkg.name}==${pkg.version}`)
  }

  artifacts.sort((a, b) => a.id.localeCompare(b.id) || a.version.localeCompare(b.version))
  return { artifacts, missing, root }
}

function isRuntimeReachable(name, selected, root) {
  // pytest 등 dev 전용은 root.dependencies에 없다
  const direct = new Set((root.dependencies ?? []).map((d) => d.name))
  if (direct.has(name)) return true
  for (const pkg of selected.values()) {
    if (pkg.name === name) continue
    if (DEV_GROUP.has(pkg.name)) continue
    if ((pkg.dependencies ?? []).some((d) => d.name === name)) return true
  }
  return false
}

export function uvLockDigestFromBytes(buf) {
  return `sha256:${createHash('sha256').update(buf).digest('hex')}`
}

export function uvLockDigestFromFile(path) {
  return uvLockDigestFromBytes(readFileSync(path))
}

/**
 * wheels.lock 선택 결과가 현재 uv.lock과 같은지 검사.
 * @param {object} wheelsLock
 * @param {string} uvLockText
 * @param {string} uvLockDigest
 */
export function diffWheelSelection(wheelsLock, uvLockText, uvLockDigest) {
  const expected = selectRuntimeWheels(uvLockText)
  const errors = []
  if (wheelsLock.uvLockDigest !== uvLockDigest) {
    errors.push(`uvLockDigest mismatch: lock=${wheelsLock.uvLockDigest} actual=${uvLockDigest}`)
  }
  const actual = new Map(
    (wheelsLock.artifacts ?? [])
      .filter((a) => a.kind === 'wheel' || a.kind === 'sdist-build')
      .map((a) => [`${a.id}==${a.version}`, a])
  )
  const want = new Map(expected.artifacts.map((a) => [`${a.id}==${a.version}`, a]))
  for (const [key, art] of want) {
    const got = actual.get(key)
    if (!got) {
      errors.push(`missing wheel selection ${key}`)
      continue
    }
    if (got.sha256 !== art.sha256) errors.push(`hash mismatch for ${key}`)
    if (got.url !== art.url) errors.push(`url mismatch for ${key}`)
  }
  return { errors, expected: expected.artifacts }
}
