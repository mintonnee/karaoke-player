/**
 * 008 L5 통합 시험 러너.
 * 기본은 fixture·lock verify. --real-assets 는 data-dir의 실제 가중치만 검사하며
 * 파일이 없으면 실패한다(가짜 통과 없음). lock 파일은 수정하지 않는다.
 */

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const args = process.argv.slice(2)
const realAssets = args.includes('--real-assets')
const dataDirFlag = args.indexOf('--data-dir')
const dataDir =
  dataDirFlag >= 0 && args[dataDirFlag + 1]
    ? resolve(args[dataDirFlag + 1])
    : join(root, 'dist', 'runtime-acceptance')

const report = {
  at: new Date().toISOString(),
  realAssets,
  dataDir,
  steps: [],
  models: [],
  ok: true
}

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function runStep(name, command, cmdArgs, opts = {}) {
  const result = spawnSync(command, cmdArgs, {
    cwd: root,
    encoding: 'utf8',
    shell: false,
    timeout: opts.timeout ?? 120_000
  })
  const step = {
    name,
    command: [command, ...cmdArgs].join(' '),
    exit: result.status,
    ok: result.status === 0
  }
  if (!step.ok) {
    report.ok = false
    step.stderr = (result.stderr || result.error?.message || '').trim().slice(0, 2000)
  }
  report.steps.push(step)
  const mark = step.ok ? 'ok' : 'FAIL'
  console.log(`${mark}  ${name} (exit ${result.status})`)
  return step.ok
}

function nodeBin() {
  return process.execPath
}

runStep('lock verify', nodeBin(), [join(root, 'scripts', 'runtime-lock', 'cli.mjs'), 'verify'])
runStep('runtime-lock tests', nodeBin(), [
  '--test',
  join(root, 'scripts', '__tests__', 'runtime-lock')
])

if (realAssets) {
  mkdirSync(dataDir, { recursive: true })
  const lockPath = join(root, 'build', 'locks', 'models.lock.json')
  const lock = JSON.parse(readFileSync(lockPath, 'utf8'))
  const searchRoots = [
    dataDir,
    join(dataDir, 'models'),
    process.env.KARAOKE_MODELS_DIR,
    join(process.env.USERPROFILE ?? '', '.cache', 'torch', 'hub', 'checkpoints')
  ].filter(Boolean)

  for (const artifact of lock.artifacts ?? []) {
    const destName = String(artifact.dest ?? '')
      .split('/')
      .pop()
    let found = null
    for (const base of searchRoots) {
      const candidates = [join(base, artifact.dest ?? ''), join(base, destName ?? '')]
      for (const candidate of candidates) {
        if (existsSync(candidate) && statSync(candidate).isFile()) {
          found = candidate
          break
        }
      }
      if (found) break
    }
    if (!found) {
      report.ok = false
      report.models.push({
        id: artifact.id,
        dest: artifact.dest,
        status: 'missing',
        note: '실자산 없음. data-dir 또는 KARAOKE_MODELS_DIR 에 lock dest 파일을 두세요'
      })
      console.log(`FAIL  model ${artifact.id}: missing`)
      continue
    }
    const size = statSync(found).size
    const started = Date.now()
    const hash = sha256File(found)
    const ms = Date.now() - started
    const sizeOk = size === artifact.size
    const hashOk = hash === artifact.sha256
    const ok = sizeOk && hashOk
    if (!ok) report.ok = false
    report.models.push({
      id: artifact.id,
      path: found,
      status: ok ? 'ok' : 'mismatch',
      size,
      expectedSize: artifact.size,
      sha256: hash,
      ms
    })
    console.log(`${ok ? 'ok' : 'FAIL'}  model ${artifact.id} (${ms}ms, ${size} bytes)`)
  }
} else {
  report.models.push({
    status: 'skipped',
    note: '실자산 시험은 --real-assets --data-dir <dir> 로 실행한다'
  })
}

mkdirSync(dataDir, { recursive: true })
const reportPath = join(dataDir, 'report.json')
writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`)
console.log(`report ${reportPath}`)
if (!report.ok) {
  console.error('runtime-acceptance failed')
  process.exit(1)
}
console.log('runtime-acceptance ok')
