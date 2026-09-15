import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { createZip, extractZipVerified } from '../../runtime-lock/zip.mjs'
import { ERROR_CODES } from '../../runtime-lock/schema.mjs'
import { sha256Hex } from '../../runtime-lock/schema.mjs'
import { tempDir } from './helpers.mjs'

function allow(path, data, extra = {}) {
  const buf = Buffer.from(data)
  return [
    path,
    { sha256: sha256Hex(buf), size: buf.length, executable: extra.executable, dest: extra.dest }
  ]
}

function extract(zip, allowlistEntries) {
  const targetDir = tempDir('zip-x-')
  mkdirSync(targetDir, { recursive: true })
  const allowlist = new Map(allowlistEntries)
  const written = []
  extractZipVerified(zip, {
    targetDir,
    allowlist,
    id: 'test-zip',
    writeFile: (abs, data) => written.push({ abs, data })
  })
  return { targetDir, written }
}

test('zip path escape ../ is rejected', () => {
  const zip = createZip([{ name: '../evil.exe', data: Buffer.from('MZ') }])
  assert.throws(
    () => extract(zip, [allow('../evil.exe', 'MZ', { executable: true })]),
    (err) => {
      return err.code === ERROR_CODES.PATH_ESCAPE
    }
  )
})

test('zip absolute unix path is rejected', () => {
  const zip = createZip([{ name: '/tmp/evil.exe', data: Buffer.from('MZ') }])
  assert.throws(
    () => extract(zip, [allow('/tmp/evil.exe', 'MZ')]),
    (err) => {
      return err.code === ERROR_CODES.PATH_ESCAPE
    }
  )
})

test('zip drive letter path is rejected', () => {
  const zip = createZip([{ name: 'C:/Windows/evil.exe', data: Buffer.from('MZ') }])
  assert.throws(
    () => extract(zip, [allow('C:/Windows/evil.exe', 'MZ')]),
    (err) => {
      return err.code === ERROR_CODES.PATH_ESCAPE
    }
  )
})

test('zip symlink is rejected', () => {
  const zip = createZip([
    { name: 'link.exe', data: Buffer.from('target'), symlink: true, unixMode: 0o120777 }
  ])
  assert.throws(
    () => extract(zip, [allow('link.exe', 'target', { executable: true })]),
    (err) => err.code === ERROR_CODES.SYMLINK_REJECTED
  )
})

test('windows case collision is rejected', () => {
  const zip = createZip([
    { name: 'Foo.exe', data: Buffer.from('A') },
    { name: 'foo.exe', data: Buffer.from('B') }
  ])
  assert.throws(
    () =>
      extract(zip, [
        allow('Foo.exe', 'A', { executable: true }),
        allow('foo.exe', 'B', { executable: true })
      ]),
    (err) => err.code === ERROR_CODES.CASE_COLLISION
  )
})

test('unexpected executable is rejected', () => {
  const zip = createZip([
    { name: 'uv.exe', data: Buffer.from('good') },
    { name: 'evil.exe', data: Buffer.from('bad') }
  ])
  assert.throws(
    () => extract(zip, [allow('uv.exe', 'good', { executable: true })]),
    (err) => err.code === ERROR_CODES.UNEXPECTED_EXECUTABLE
  )
})

test('deflate member is hashed after inflate', () => {
  const payload = Buffer.from('hello-deflate')
  const zip = createZip([{ name: 'a.txt', data: payload, method: 'deflate' }])
  const { written } = extract(zip, [allow('a.txt', payload)])
  assert.equal(written.length, 1)
  assert.equal(written[0].data.toString(), 'hello-deflate')
})
