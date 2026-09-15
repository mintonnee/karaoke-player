import { cpSync, existsSync, mkdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { ensureArtifact } from './download.mjs'
import { LOCK_FILES, readLock, verifyLocks } from './verify.mjs'
import { formatErrors } from './schema.mjs'

const STAGE_EXCLUDE = /(^|[\\/])(\.venv|__pycache__)([\\/]|$)|\.pyc$|\.egg-info([\\/]|$)/i

/**
 * tools.lock 을 읽어 검증 후 resources/bin 에 배치하고 sidecar 를 스테이징한다.
 * lock 파일은 쓰지 않는다.
 */
export async function prepareResources(opts) {
  const root = opts.root
  const locksDir = opts.locksDir ?? join(root, 'build', 'locks')
  const binDir = opts.binDir ?? join(root, 'resources', 'bin')
  const sidecarSrcDir = opts.sidecarSrcDir ?? join(root, 'sidecar')
  const sidecarStageDir = opts.sidecarStageDir ?? join(root, 'resources', 'sidecar')
  const destRoot = opts.destRoot ?? root
  const cacheRoot = opts.cacheRoot
  const fetchImpl = opts.fetchImpl
  const force = Boolean(opts.force)
  const log = opts.log ?? console.log

  const verified = verifyLocks({ root, locksDir })
  if (!verified.ok) {
    throw new Error(`lock verify failed\n${formatErrors(verified.errors)}`)
  }

  const tools = readLock(locksDir, LOCK_FILES.tools).json
  mkdirSync(binDir, { recursive: true })
  for (const artifact of tools.artifacts) {
    log(`ensure ${artifact.id} ${artifact.version}`)
    const result = await ensureArtifact({
      artifact,
      destRoot,
      cacheRoot,
      force,
      fetchImpl,
      skipHostCheck: opts.skipHostCheck
    })
    log(result.reused ? `  reused ${artifact.dest}` : `  wrote ${artifact.dest}`)
  }

  stageSidecar(sidecarSrcDir, sidecarStageDir, log)
  log('resources ready')
}

function stageSidecar(sidecarSrcDir, sidecarStageDir, log) {
  rmSync(sidecarStageDir, { recursive: true, force: true })
  mkdirSync(sidecarStageDir, { recursive: true })
  for (const name of ['pyproject.toml', 'uv.lock', '.python-version', 'LICENSE']) {
    const from = join(sidecarSrcDir, name)
    if (!existsSync(from)) throw new Error(`sidecar/${name} not found`)
    cpSync(from, join(sidecarStageDir, name))
  }
  let copied = 0
  cpSync(join(sidecarSrcDir, 'src'), join(sidecarStageDir, 'src'), {
    recursive: true,
    filter: (from) => {
      if (STAGE_EXCLUDE.test(from)) return false
      if (statSync(from).isFile()) copied += 1
      return true
    }
  })
  log(`staged resources/sidecar (${copied} source files + project metadata)`)
}
