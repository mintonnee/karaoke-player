/* eslint-disable @typescript-eslint/explicit-function-return-type -- 타입 표기 불가한 .mjs */
/**
 * 패키징용 리소스 준비 (스펙 001 §4.1·§4.2).
 * 1. uv / yt-dlp / deno 바이너리를 GitHub 릴리즈에서 받아 resources/bin/ 에 배치한다.
 * 2. 레포 sidecar/ 프로젝트를 .venv·__pycache__ 없이 resources/sidecar/ 로 스테이징한다.
 * 두 산출물 모두 .gitignore 대상이며 electron-builder extraResources 가 그대로 배포물에 담는다.
 * 실행: pnpm prepare:resources  (--force 로 바이너리 재다운로드)
 */

import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from 'fs'
import { copyFile, writeFile } from 'fs/promises'
import { spawnSync } from 'child_process'
import { tmpdir } from 'os'
import { dirname, join, resolve } from 'path'
import { fileURLToPath } from 'url'

// 고정 버전 — 갱신 시 이 상수만 바꾼다 (deno 는 yt-dlp JS 챌린지 요구사항상 >=2.3.0)
const UV_VERSION = '0.12.9'
const YT_DLP_VERSION = '2026.08.19'
const DENO_VERSION = 'v2.9.6'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const binDir = join(root, 'resources', 'bin')
const sidecarSrcDir = join(root, 'sidecar')
const sidecarStageDir = join(root, 'resources', 'sidecar')
const force = process.argv.includes('--force')

// zip 해제는 Windows 내장 bsdtar 로 처리한다 (Git Bash 의 GNU tar 는 zip 미지원)
const tarExe =
  process.platform === 'win32'
    ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe')
    : 'tar'

const BINARIES = [
  {
    exe: 'uv.exe',
    version: UV_VERSION,
    url: `https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/uv-x86_64-pc-windows-msvc.zip`,
    archive: 'uv-x86_64-pc-windows-msvc.zip'
  },
  {
    exe: 'yt-dlp.exe',
    version: YT_DLP_VERSION,
    url: `https://github.com/yt-dlp/yt-dlp/releases/download/${YT_DLP_VERSION}/yt-dlp.exe`,
    archive: null
  },
  {
    exe: 'deno.exe',
    version: DENO_VERSION,
    url: `https://github.com/denoland/deno/releases/download/${DENO_VERSION}/deno-x86_64-pc-windows-msvc.zip`,
    archive: 'deno-x86_64-pc-windows-msvc.zip'
  }
]

function fail(message) {
  console.error(`error: ${message}`)
  process.exit(1)
}

function mb(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

// fetch 는 기본이 redirect: 'follow' 라 GitHub 릴리즈 자산의 302 를 그대로 따라간다
async function download(url, destPath) {
  const response = await fetch(url)
  if (!response.ok) {
    fail(`download failed (${response.status} ${response.statusText}): ${url}`)
  }
  const buffer = Buffer.from(await response.arrayBuffer())
  await writeFile(destPath, buffer)
  return buffer.length
}

function findFile(dir, name) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      const found = findFile(full, name)
      if (found) return found
    } else if (entry.name.toLowerCase() === name.toLowerCase()) {
      return full
    }
  }
  return null
}

function smokeTest(exePath) {
  const result = spawnSync(exePath, ['--version'], { encoding: 'utf-8', timeout: 120_000 })
  if (result.error) {
    fail(`smoke test spawn failed for ${exePath}: ${result.error.message}`)
  }
  if (result.status !== 0) {
    fail(`smoke test failed for ${exePath} (exit ${result.status}): ${result.stderr?.trim()}`)
  }
  return (result.stdout || result.stderr).trim().split('\n')[0].trim()
}

async function prepareBinary(spec) {
  const destPath = join(binDir, spec.exe)
  if (existsSync(destPath) && !force) {
    console.log(`skip ${spec.exe} (already present — --force to re-download)`)
    return
  }

  console.log(`download ${spec.exe} ${spec.version} <- ${spec.url}`)
  const tmp = mkdtempSync(join(tmpdir(), 'karaoke-res-'))
  try {
    if (spec.archive == null) {
      const size = await download(spec.url, destPath)
      console.log(`  saved ${spec.exe} (${mb(size)})`)
    } else {
      const archivePath = join(tmp, spec.archive)
      const size = await download(spec.url, archivePath)
      console.log(`  fetched ${spec.archive} (${mb(size)}) — extracting`)
      const extractDir = join(tmp, 'x')
      mkdirSync(extractDir, { recursive: true })
      const untar = spawnSync(tarExe, ['-xf', archivePath, '-C', extractDir], {
        encoding: 'utf-8'
      })
      if (untar.status !== 0) {
        fail(`extract failed for ${spec.archive}: ${untar.stderr || untar.error?.message}`)
      }
      const extracted = findFile(extractDir, spec.exe)
      if (extracted == null) {
        fail(`${spec.exe} not found inside ${spec.archive}`)
      }
      await copyFile(extracted, destPath)
      console.log(`  saved ${spec.exe} (${mb(statSync(destPath).size)})`)
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

const STAGE_EXCLUDE = /(^|[\\/])(\.venv|__pycache__)([\\/]|$)|\.pyc$|\.egg-info([\\/]|$)/i

function stageSidecar() {
  rmSync(sidecarStageDir, { recursive: true, force: true })
  mkdirSync(sidecarStageDir, { recursive: true })

  for (const name of ['pyproject.toml', 'uv.lock', '.python-version']) {
    const from = join(sidecarSrcDir, name)
    if (!existsSync(from)) {
      fail(`sidecar/${name} not found`)
    }
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
  console.log(`staged resources/sidecar (${copied} source files + project metadata)`)
}

mkdirSync(binDir, { recursive: true })
for (const spec of BINARIES) {
  await prepareBinary(spec)
}
for (const spec of BINARIES) {
  console.log(`verify ${spec.exe}: ${smokeTest(join(binDir, spec.exe))}`)
}
stageSidecar()
console.log('resources ready')
