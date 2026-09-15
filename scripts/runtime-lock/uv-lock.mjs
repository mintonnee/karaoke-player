import { readFileSync } from 'node:fs'

/**
 * sidecar/uv.lock 전용 파서. 일반 TOML 전체가 아니라 uv lock 형태만 다룬다.
 * @param {string} text
 */
export function parseUvLock(text) {
  const header = {
    version: null,
    revision: null,
    requiresPython: null
  }
  const mVersion = text.match(/^version\s*=\s*(\d+)/m)
  if (mVersion) header.version = Number(mVersion[1])
  const mRev = text.match(/^revision\s*=\s*(\d+)/m)
  if (mRev) header.revision = Number(mRev[1])
  const mReq = text.match(/^requires-python\s*=\s*"([^"]+)"/m)
  if (mReq) header.requiresPython = mReq[1]

  const packages = []
  const chunks = text.split(/^\[\[package\]\]\s*$/m).slice(1)
  for (const chunk of chunks) {
    packages.push(parsePackage(chunk))
  }
  return { header, packages }
}

function parsePackage(chunk) {
  const name = strField(chunk, 'name')
  const version = strField(chunk, 'version')
  const source = objectField(chunk, 'source')
  const resolutionMarkers = stringArrayField(chunk, 'resolution-markers')
  const dependencies = objectArrayField(chunk, 'dependencies')
  const wheels = objectArrayField(chunk, 'wheels')
  const sdist = objectField(chunk, 'sdist')
  const devDependencies = parseDevDependencies(chunk)
  return {
    name,
    version,
    source,
    resolutionMarkers,
    dependencies,
    wheels,
    sdist,
    devDependencies
  }
}

function strField(chunk, key) {
  const m = chunk.match(new RegExp(`^${key}\\s*=\\s*"([^"]*)"`, 'm'))
  return m ? m[1] : null
}

function objectField(chunk, key) {
  const m = chunk.match(new RegExp(`^${key}\\s*=\\s*\\{([^}]*)\\}`, 'm'))
  if (!m) return null
  return parseInlineTable(m[1])
}

function stringArrayField(chunk, key) {
  const m = chunk.match(new RegExp(`^${key}\\s*=\\s*\\[([\\s\\S]*?)\\]`, 'm'))
  if (!m) return []
  return [...m[1].matchAll(/"([^"]*)"/g)].map((x) => x[1])
}

function objectArrayField(chunk, key) {
  const re = new RegExp(`^${key}\\s*=\\s*\\[`, 'm')
  const start = chunk.search(re)
  if (start < 0) return []
  const bracket = chunk.indexOf('[', start)
  const end = findMatchingBracket(chunk, bracket)
  const body = chunk.slice(bracket + 1, end)
  return splitTopLevelObjects(body).map(parseInlineTable)
}

function splitTopLevelObjects(body) {
  const items = []
  let depth = 0
  let start = -1
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]
    if (ch === '{') {
      if (depth === 0) start = i + 1
      depth++
    } else if (ch === '}') {
      depth--
      if (depth === 0 && start >= 0) {
        items.push(body.slice(start, i))
        start = -1
      }
    }
  }
  return items
}

function findMatchingBracket(text, openIdx) {
  let depth = 0
  for (let i = openIdx; i < text.length; i++) {
    const ch = text[i]
    if (ch === '[') depth++
    else if (ch === ']') {
      depth--
      if (depth === 0) return i
    }
  }
  return text.length
}

function parseInlineTable(body) {
  /** @type {Record<string, string>} */
  const out = {}
  let i = 0
  while (i < body.length) {
    const m = /^(\s*,\s*|\s*)([A-Za-z0-9_-]+)\s*=\s*/.exec(body.slice(i))
    if (!m) break
    i += m[0].length
    const key = m[2]
    if (body[i] === '{') {
      let depth = 0
      const from = i
      for (; i < body.length; i++) {
        if (body[i] === '{') depth++
        else if (body[i] === '}') {
          depth--
          if (depth === 0) {
            i++
            break
          }
        }
      }
      out[key] = body.slice(from, i)
    } else if (body[i] === '"') {
      i++
      let val = ''
      while (i < body.length && body[i] !== '"') val += body[i++]
      i++
      out[key] = val
    } else {
      const n = /^-?\d+/.exec(body.slice(i))
      if (!n) break
      out[key] = n[0]
      i += n[0].length
    }
  }
  return out
}

function parseDevDependencies(chunk) {
  const idx = chunk.indexOf('[package.dev-dependencies]')
  if (idx < 0) return []
  const rest = chunk.slice(idx)
  const m = rest.match(/dev\s*=\s*\[([\s\S]*?)\]/)
  if (!m) return []
  return splitTopLevelObjects(m[1]).map(parseInlineTable)
}

export const WIN32_CPYTHON_312 = Object.freeze({
  sys_platform: 'win32',
  platform_machine: 'AMD64',
  python_full_version: '3.12.14',
  python_version: '3.12',
  os_name: 'nt',
  platform_system: 'Windows',
  implementation_name: 'cpython'
})

/**
 * PEP 508 마커 부분집합.
 * @param {string | null | undefined} expr
 * @param {Record<string, string>} env
 */
export function evaluateMarker(expr, env = WIN32_CPYTHON_312) {
  if (expr == null || String(expr).trim() === '') return true
  const tokens = tokenize(String(expr))
  let i = 0
  function peek() {
    return tokens[i]
  }
  function eat() {
    return tokens[i++]
  }
  function parseOr() {
    let left = parseAnd()
    while (peek() === 'or') {
      eat()
      const right = parseAnd()
      left = left || right
    }
    return left
  }
  function parseAnd() {
    let left = parseNot()
    while (peek() === 'and') {
      eat()
      const right = parseNot()
      left = left && right
    }
    return left
  }
  function parseNot() {
    if (peek() === 'not') {
      eat()
      return !parseNot()
    }
    return parsePrimary()
  }
  function parsePrimary() {
    if (peek() === '(') {
      eat()
      const inner = parseOr()
      if (eat() !== ')') throw new Error(`marker: expected ) in ${expr}`)
      return inner
    }
    const leftTok = eat()
    const op = eat()
    const rightTok = eat()
    if (op === 'in' || (op === 'not' && peek() === 'in')) {
      let realOp = op
      if (op === 'not') {
        eat()
        realOp = 'not in'
      }
      return compare(valueOf(leftTok, env), realOp, valueOf(rightTok, env), leftTok)
    }
    return compare(valueOf(leftTok, env), op, valueOf(rightTok, env), leftTok)
  }
  const result = parseOr()
  if (i !== tokens.length) throw new Error(`marker: trailing tokens in ${expr}`)
  return result
}

function tokenize(expr) {
  const tokens = []
  const re =
    /\s*(?:("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')|(<=|>=|==|!=|<|>)|([A-Za-z_][A-Za-z0-9._]*)|([()]))/g
  let m
  while ((m = re.exec(expr))) {
    if (m[1]) tokens.push(m[1])
    else if (m[2]) tokens.push(m[2])
    else if (m[3]) tokens.push(m[3])
    else if (m[4]) tokens.push(m[4])
  }
  return tokens
}

function valueOf(token, env) {
  if (token.startsWith('"') || token.startsWith("'")) return token.slice(1, -1)
  if (Object.prototype.hasOwnProperty.call(env, token)) return env[token]
  return token
}

function compare(left, op, right, leftName) {
  const versioned = leftName === 'python_full_version' || leftName === 'python_version'
  if (versioned && ['<', '<=', '>', '>=', '==', '!='].includes(op)) {
    const cmp = cmpVersion(left, right)
    switch (op) {
      case '==':
        return cmp === 0
      case '!=':
        return cmp !== 0
      case '<':
        return cmp < 0
      case '<=':
        return cmp <= 0
      case '>':
        return cmp > 0
      case '>=':
        return cmp >= 0
    }
  }
  switch (op) {
    case '==':
      return left === right
    case '!=':
      return left !== right
    case 'in':
      return String(right).includes(String(left))
    case 'not in':
      return !String(right).includes(String(left))
    default:
      throw new Error(`unsupported marker op ${op}`)
  }
}

function cmpVersion(a, b) {
  const pa = String(a)
    .split('.')
    .map((x) => Number.parseInt(x, 10) || 0)
  const pb = String(b)
    .split('.')
    .map((x) => Number.parseInt(x, 10) || 0)
  const n = Math.max(pa.length, pb.length)
  for (let i = 0; i < n; i++) {
    const da = pa[i] ?? 0
    const db = pb[i] ?? 0
    if (da > db) return 1
    if (da < db) return -1
  }
  return 0
}

export function readUvLockFile(path) {
  return parseUvLock(readFileSync(path, 'utf8'))
}
