import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'fs'
import { createHash, randomBytes } from 'crypto'
import { dirname, join, posix as posixPath } from 'path'
import { ERROR_CODES, LockError, type Artifact } from './schema'
import { extractZipVerified, type ArchiveAllowSpec } from './zip'
import { extractTarGzVerified } from './tar'
import { posixDest, resolveInside } from './paths'

let checkpoint: () => void = () => {}
function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true })
}
export function hashFile(path: string): string {
  checkpoint()
  const hash = createHash('sha256')
  const fd = openSync(path, 'r')
  try {
    const buf = Buffer.alloc(1024 * 1024)
    let n = 0
    while ((n = readSync(fd, buf, 0, buf.length, null)) > 0) {
      checkpoint()
      hash.update(buf.subarray(0, n))
    }
    return hash.digest('hex')
  } finally {
    closeSync(fd)
  }
}

function copyFileAtomic(source: string, dest: string): void {
  ensureDir(dirname(dest))
  const tmp = dest + '.' + process.pid + '.' + randomBytes(6).toString('hex') + '.tmp'
  try {
    copyFileSync(source, tmp)
    checkpoint()
    renameSync(tmp, dest)
  } finally {
    rmSync(tmp, { force: true })
  }
}

function writeFileAtomic(dest: string, data: Buffer): void {
  ensureDir(dirname(dest))
  const tmp = `${dest}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
  try {
    checkpoint()
    writeFileSync(tmp, data)
    checkpoint()
    renameSync(tmp, dest)
  } catch (err) {
    try {
      rmSync(tmp, { force: true })
    } catch {
      // ignore
    }
    if (existsSync(dest)) {
      throw new LockError(
        ERROR_CODES.SCHEMA_ERROR,
        `rename failed; kept existing complete file: ${dest}`
      )
    }
    throw err
  }
}

function archiveDest(artifact: Artifact, file: { path: string; dest?: string }): string {
  return file.dest ?? posixDest(posixPath.join(posixPath.dirname(artifact.dest), file.path))
}

function destMatches(artifact: Artifact, destPath: string): boolean {
  try {
    verifyExistingFile(destPath, artifact)
    return true
  } catch {
    checkpoint()
    return false
  }
}

export function artifactDestMatches(artifact: Artifact, destRoot: string): boolean {
  try {
    if (artifact.kind === 'archive') {
      if (!artifact.archive?.files.length) return false
      for (const file of artifact.archive.files) {
        verifyExistingFile(resolveInside(destRoot, archiveDest(artifact, file)), file)
      }
      return true
    }
    return destMatches(artifact, resolveInside(destRoot, artifact.dest))
  } catch {
    checkpoint()
    return false
  }
}

function publishArchive(artifact: Artifact, blobPath: string, destRoot: string): void {
  if (!artifact.archive) {
    throw new LockError(ERROR_CODES.SCHEMA_ERROR, 'archive metadata required', { id: artifact.id })
  }
  const allowlist = new Map<string, ArchiveAllowSpec>()
  for (const file of artifact.archive.files) {
    allowlist.set(file.path, {
      sha256: file.sha256,
      size: file.size,
      executable: file.executable,
      dest: archiveDest(artifact, file)
    })
  }
  const writeFile = (absPath: string, data: Buffer): void => {
    checkpoint()
    writeFileAtomic(absPath, data)
  }
  const bytes = readFileSync(blobPath)
  const extractOpts = { targetDir: destRoot, allowlist, id: artifact.id, writeFile }
  if (artifact.archive.format === 'zip') extractZipVerified(bytes, extractOpts)
  else extractTarGzVerified(bytes, extractOpts)
}

export function verifyExistingFile(
  path: string,
  expected: { sha256: string; size: number; id?: string }
): void {
  if (!existsSync(path)) {
    throw new LockError(ERROR_CODES.SCHEMA_ERROR, `missing verified file: ${path}`, {
      id: expected.id,
      path
    })
  }
  const size = statSync(path).size
  if (size !== expected.size) {
    throw new LockError(
      ERROR_CODES.SIZE_MISMATCH,
      `size mismatch for ${path}: ${size} != ${expected.size}`,
      { id: expected.id, path }
    )
  }
  const actual = hashFile(path)
  if (actual !== expected.sha256) {
    throw new LockError(ERROR_CODES.HASH_MISMATCH, `sha256 mismatch for ${path}`, {
      id: expected.id,
      path
    })
  }
}

export type FileJob =
  | { kind: 'hash'; path: string }
  | { kind: 'verify'; path: string; expected: { sha256: string; size: number; id?: string } }
  | { kind: 'matches'; artifact: Artifact; destRoot: string }
  | { kind: 'publish'; artifact: Artifact; blob: string; destRoot: string; cacheRoot: string }

export function executeFileJob(job: FileJob, check: () => void): string | boolean | void {
  checkpoint = check
  try {
    checkpoint()
    switch (job.kind) {
      case 'hash':
        return hashFile(job.path)
      case 'verify':
        return verifyExistingFile(job.path, job.expected)
      case 'matches':
        return artifactDestMatches(job.artifact, job.destRoot)
      case 'publish':
        return publishArtifact(job)
    }
  } finally {
    checkpoint = () => {}
  }
}

function publishArtifact(opts: Extract<FileJob, { kind: 'publish' }>): void {
  const { artifact, blob, cacheRoot } = opts
  const destPath = resolveInside(opts.destRoot, artifact.dest, { id: artifact.id })
  if (artifact.kind === 'archive') {
    const extractDir = join(
      cacheRoot,
      'tmp',
      `extract-${artifact.sha256}-${randomBytes(4).toString('hex')}`
    )
    ensureDir(extractDir)
    try {
      // Verify every member in isolation before publishing any member.
      publishArchive(artifact, blob, extractDir)
      for (const file of artifact.archive!.files) {
        const dest = archiveDest(artifact, file)
        writeFileAtomic(
          resolveInside(opts.destRoot, dest),
          readFileSync(resolveInside(extractDir, dest))
        )
      }
    } finally {
      rmSync(extractDir, { recursive: true, force: true })
    }
  } else {
    try {
      copyFileAtomic(blob, destPath)
    } catch (err) {
      if (existsSync(destPath) && destMatches(artifact, destPath)) {
        throw new LockError(
          ERROR_CODES.SCHEMA_ERROR,
          `windows lock/rename failed; kept existing complete file (${artifact.id})`,
          { id: artifact.id }
        )
      }
      throw err
    }
  }
}
