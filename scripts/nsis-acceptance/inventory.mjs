import { createReadStream } from 'node:fs'
import { lstat, readdir } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'

export async function fileDigest(path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

export async function inventory(root) {
  const entries = []
  async function visit(relative) {
    const absolute = join(root, relative)
    const info = await lstat(absolute)
    if (info.isSymbolicLink()) throw new Error(`payload link is forbidden: ${relative}`)
    if (info.isDirectory()) {
      for (const name of (await readdir(absolute)).sort()) {
        await visit(relative ? `${relative}/${name}` : name)
      }
    } else if (info.isFile()) {
      entries.push({ path: relative, size: info.size, sha256: await fileDigest(absolute) })
    } else {
      throw new Error(`unsupported payload entry: ${relative}`)
    }
  }
  await visit('')
  return entries
}

export function compareInventories(expected, actual) {
  const remaining = new Map(actual.map((entry) => [entry.path, entry]))
  const errors = []
  for (const entry of expected) {
    const found = remaining.get(entry.path)
    if (!found) errors.push(`missing: ${entry.path}`)
    else if (found.size !== entry.size || found.sha256 !== entry.sha256) {
      errors.push(`changed: ${entry.path}`)
    }
    remaining.delete(entry.path)
  }
  for (const path of remaining.keys()) errors.push(`unexpected: ${path}`)
  return errors
}
