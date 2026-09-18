import { cpSync, existsSync, mkdirSync, rmSync, statSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { ensureArtifact } from './download.mjs'
import { LOCK_FILES, readLock, verifyLocks } from './verify.mjs'
import { formatErrors, getDistributionPolicy, isRuntimeDistribution } from './schema.mjs'

const STAGE_EXCLUDE = /(^|[\\/])(\.venv|__pycache__)([\\/]|$)|\.pyc$|\.egg-info([\\/]|$)/i

/**
 * tools.lock 을 읽어 검증 후 resources/bin 에 배치하고 sidecar 를 스테이징한다.
 * lock 파일은 쓰지 않는다.
 */
export async function prepareResources(opts) {
  const root = resolve(opts.root)
  const target = opts.target
  if (target != null && !isRuntimeDistribution(target)) {
    throw new Error(`unsupported prepare target: ${String(target)}`)
  }
  const locksDir = opts.locksDir ?? join(root, 'build', 'locks')
  const sidecarSrcDir = opts.sidecarSrcDir ?? join(root, 'sidecar')
  const targetStageDir =
    target == null
      ? null
      : resolve(opts.targetStageDir ?? join(root, 'dist', 'runtime-staging', target))
  if (targetStageDir) assertSafeTargetStage(root, targetStageDir)
  const binDir =
    opts.binDir ??
    (targetStageDir ? join(targetStageDir, 'resources', 'bin') : join(root, 'resources', 'bin'))
  const sidecarStageDir =
    opts.sidecarStageDir ??
    (targetStageDir ? join(targetStageDir, 'sidecar') : join(root, 'resources', 'sidecar'))
  const destRoot = opts.destRoot ?? targetStageDir ?? root
  const cacheRoot = opts.cacheRoot
  const fetchImpl = opts.fetchImpl
  const force = Boolean(opts.force)
  const log = opts.log ?? console.log

  const verified = verifyLocks({ root, locksDir })
  if (!verified.ok) {
    throw new Error(`lock verify failed\n${formatErrors(verified.errors)}`)
  }

  const tools = readLock(locksDir, LOCK_FILES.tools).json
  if (targetStageDir) {
    rmSync(targetStageDir, { recursive: true, force: true })
    mkdirSync(targetStageDir, { recursive: true })
    cpSync(locksDir, join(targetStageDir, 'locks'), { recursive: true })
  }

  const policy = target == null ? null : getDistributionPolicy(target)
  const artifacts =
    policy == null
      ? tools.artifacts
      : tools.artifacts.filter((artifact) => policy.toolDelivery[artifact.id] === 'bundled')
  if (artifacts.length > 0) mkdirSync(binDir, { recursive: true })
  for (const artifact of artifacts) {
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
  log(target == null ? 'resources ready' : `resources ready (${target})`)
  return { target: target ?? null, targetStageDir, binDir, sidecarStageDir }
}

function assertSafeTargetStage(root, targetStageDir) {
  const stagingRoot = resolve(root, 'dist', 'runtime-staging')
  const rel = relative(stagingRoot, targetStageDir)
  if (isAbsolute(rel) || rel === '' || rel.startsWith('..')) {
    throw new Error(`unsafe runtime staging path: ${targetStageDir}`)
  }
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
