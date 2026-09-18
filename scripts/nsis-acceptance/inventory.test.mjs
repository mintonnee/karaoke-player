import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { compareInventories, inventory } from './inventory.mjs'

test('payload comparison catches changed bytes, missing and unexpected files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nsis-inventory-'))
  try {
    await mkdir(join(root, 'resources'))
    await writeFile(join(root, 'resources', 'app.asar'), 'original')
    await writeFile(join(root, 'app.exe'), 'app')
    const before = await inventory(root)
    assert.deepEqual(compareInventories(before, await inventory(root)), [])
    await writeFile(join(root, 'resources', 'app.asar'), 'modified')
    await rm(join(root, 'app.exe'))
    await writeFile(join(root, 'uv.exe'), 'unexpected')
    assert.deepEqual(compareInventories(before, await inventory(root)), [
      'missing: app.exe',
      'changed: resources/app.asar',
      'unexpected: uv.exe'
    ])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
