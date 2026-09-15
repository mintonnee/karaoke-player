import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { ERROR_CODES, LockError } from './schema.mjs'
import { isWindowsExecutableName } from './paths.mjs'
import { LOCK_FILES, readLock } from './verify.mjs'

/**
 * 합성 dist fixture를 검사한다. 실제 electron-builder 배선은 L4.
 * @param {{ target: 'zip' | 'appx', input: string, locksDir: string }} opts
 */
export function verifyPackage(opts) {
  const { target, input, locksDir } = opts
  if (target !== 'zip' && target !== 'appx') {
    throw new LockError(ERROR_CODES.SCHEMA_ERROR, `unknown package target: ${target}`)
  }
  const tools = readLock(locksDir, LOCK_FILES.tools).json
  /** @type {LockError[]} */
  const errors = []
  const binDir = join(input, 'resources', 'bin')
  const present = existsSync(binDir)
    ? readdirSync(binDir).filter((name) => statSync(join(binDir, name)).isFile())
    : []
  const presentLower = new Set(present.map((n) => n.toLowerCase()))

  const required = tools.artifacts.filter((a) => {
    const cap = a.capability ?? 'always'
    if (cap === 'always') return true
    if (cap === 'zip-url-import') return target === 'zip'
    return false
  })
  const forbidden = tools.artifacts.filter((a) => {
    const cap = a.capability ?? 'always'
    return cap === 'zip-url-import' && target === 'appx'
  })

  for (const artifact of required) {
    const name = artifact.dest.split('/').pop()
    if (!presentLower.has(name.toLowerCase())) {
      errors.push(
        new LockError(ERROR_CODES.SCHEMA_ERROR, `missing required ${name} for ${target}`, {
          id: artifact.id,
          path: artifact.dest
        })
      )
    }
  }

  for (const artifact of forbidden) {
    const name = artifact.dest.split('/').pop()
    if (presentLower.has(name.toLowerCase())) {
      errors.push(
        new LockError(ERROR_CODES.SCHEMA_ERROR, `APPX must not include ${name}`, {
          id: artifact.id,
          path: artifact.dest
        })
      )
    }
  }

  const allowedNames = new Set(
    tools.artifacts
      .flatMap((a) => {
        const names = [a.dest.split('/').pop()]
        for (const file of a.archive?.files ?? []) {
          names.push((file.dest ?? file.path).split('/').pop())
        }
        return names
      })
      .map((n) => n.toLowerCase())
  )

  for (const name of present) {
    if (!isWindowsExecutableName(name)) continue
    if (!allowedNames.has(name.toLowerCase())) {
      errors.push(
        new LockError(
          ERROR_CODES.UNEXPECTED_EXECUTABLE,
          `extra unsigned unexpected exe not in lock: ${name}`,
          { path: `resources/bin/${name}` }
        )
      )
    }
  }

  const sidecar = join(input, 'resources', 'sidecar')
  if (!existsSync(join(sidecar, 'pyproject.toml')) || !existsSync(join(sidecar, 'uv.lock'))) {
    errors.push(
      new LockError(ERROR_CODES.SCHEMA_ERROR, 'missing staged sidecar project files', {
        path: 'resources/sidecar'
      })
    )
  }

  return { ok: errors.length === 0, errors, target, present }
}
