import { existsSync } from 'fs'
import { mkdir, readFile, rename, rm, writeFile } from 'fs/promises'
import { dirname, join } from 'path'
import { randomBytes } from 'crypto'
import { ERROR_CODES, LockError } from './schema'
import type { RuntimeInputDigests, RuntimeManifest } from './manifest'

export const RUNTIMES_DIR = 'runtimes'
export const POINTER_FILE = 'current.json'
export const INVENTORY_FILE = 'inventory.json'
export const SMOKE_FILE = 'smoke.json'
export const META_FILE = 'meta.json'
export const VENV_DIR = 'venv'
export const PYTHON_DIR = 'python'
export const WHEELHOUSE_DIR = 'wheelhouse'
export const SIDECAR_DIR = 'sidecar'

export interface RuntimePointer {
  runtimeId: string
  inputDigests: RuntimeInputDigests
}

export function runtimesRoot(userDataDir: string): string {
  return join(userDataDir, RUNTIMES_DIR)
}

export function runtimeDir(userDataDir: string, runtimeId: string): string {
  return join(runtimesRoot(userDataDir), runtimeId)
}

export function runtimePointerPath(userDataDir: string): string {
  return join(runtimesRoot(userDataDir), POINTER_FILE)
}

export async function readPointer(userDataDir: string): Promise<RuntimePointer | null> {
  try {
    const raw = await readFile(runtimePointerPath(userDataDir), 'utf8')
    const parsed = JSON.parse(raw) as RuntimePointer
    if (!parsed?.runtimeId || typeof parsed.runtimeId !== 'string') return null
    return parsed
  } catch {
    return null
  }
}

async function writeFileAtomic(dest: string, data: string): Promise<void> {
  await mkdir(dirname(dest), { recursive: true })
  const tmp = `${dest}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
  await writeFile(tmp, data, 'utf8')
  try {
    await rename(tmp, dest)
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => undefined)
    if (existsSync(dest)) {
      throw new LockError(
        ERROR_CODES.SCHEMA_ERROR,
        `rename failed; kept existing complete file: ${dest}`
      )
    }
    throw err
  }
}

/** 성공한 inventory+smoke 이후에만 호출한다. */
export async function writePointer(userDataDir: string, pointer: RuntimePointer): Promise<void> {
  await writeFileAtomic(runtimePointerPath(userDataDir), `${JSON.stringify(pointer, null, 2)}\n`)
}

export interface RuntimeReadyFiles {
  inventory: boolean
  smoke: boolean
  smokeOk: boolean
  metaRuntimeId: string | null
}

export async function readRuntimeReadyFiles(dir: string): Promise<RuntimeReadyFiles> {
  const out: RuntimeReadyFiles = {
    inventory: false,
    smoke: false,
    smokeOk: false,
    metaRuntimeId: null
  }
  try {
    const raw = await readFile(join(dir, INVENTORY_FILE), 'utf8')
    JSON.parse(raw)
    out.inventory = true
  } catch {
    out.inventory = false
  }
  try {
    const raw = await readFile(join(dir, SMOKE_FILE), 'utf8')
    const smoke = JSON.parse(raw) as { ok?: boolean }
    out.smoke = true
    out.smokeOk = smoke.ok === true
  } catch {
    out.smoke = false
  }
  try {
    const raw = await readFile(join(dir, META_FILE), 'utf8')
    const meta = JSON.parse(raw) as { runtimeId?: string }
    out.metaRuntimeId = typeof meta.runtimeId === 'string' ? meta.runtimeId : null
  } catch {
    out.metaRuntimeId = null
  }
  return out
}

export async function isRuntimeSelected(
  userDataDir: string,
  manifest: RuntimeManifest
): Promise<boolean> {
  const pointer = await readPointer(userDataDir)
  if (!pointer) return false
  if (pointer.runtimeId !== manifest.runtimeId) return false
  const dir = runtimeDir(userDataDir, pointer.runtimeId)
  const files = await readRuntimeReadyFiles(dir)
  return (
    files.inventory && files.smoke && files.smokeOk && files.metaRuntimeId === manifest.runtimeId
  )
}

export function assertRuntimeMatchesManifest(runtimeId: string, manifest: RuntimeManifest): void {
  if (runtimeId !== manifest.runtimeId) {
    throw new LockError(
      ERROR_CODES.HASH_MISMATCH,
      `runtimeId ${runtimeId} does not match current manifest ${manifest.runtimeId}`,
      { id: 'runtimeId' }
    )
  }
}

export async function resolveSelectedRuntime(
  userDataDir: string,
  manifest: RuntimeManifest
): Promise<string> {
  const pointer = await readPointer(userDataDir)
  if (!pointer) {
    throw new LockError(ERROR_CODES.SCHEMA_ERROR, 'no runtime selection pointer')
  }
  assertRuntimeMatchesManifest(pointer.runtimeId, manifest)
  const dir = runtimeDir(userDataDir, pointer.runtimeId)
  const files = await readRuntimeReadyFiles(dir)
  if (!files.inventory || !files.smokeOk || files.metaRuntimeId !== manifest.runtimeId) {
    throw new LockError(ERROR_CODES.SCHEMA_ERROR, 'selected runtime is not ready', {
      id: pointer.runtimeId
    })
  }
  return dir
}
