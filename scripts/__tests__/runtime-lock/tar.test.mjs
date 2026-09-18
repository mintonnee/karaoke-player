import { test } from 'node:test'
import assert from 'node:assert/strict'
import { gzipSync } from 'node:zlib'
import { createHash } from 'node:crypto'
import { extractTarGzVerified, listTarEntries } from '../../runtime-lock/tar.mjs'

function entry(name, data, prefix = '', type = '0') {
  const header = Buffer.alloc(512)
  header.write(name, 0, 100)
  header.write('0000644\0', 100)
  header.write(data.length.toString(8).padStart(11, '0') + '\0', 124)
  header.write(type, 156)
  header.write(prefix, 345, 155)
  return Buffer.concat([header, data, Buffer.alloc((512 - (data.length % 512)) % 512)])
}

test('extracts a locked BAT file despite bytes after the name terminator', () => {
  const path = 'python/Lib/ctypes/macholib/fetch_macholib.bat'
  const data = Buffer.from('echo fixture')
  const tar = entry(path + '\0lib.bat', data)
  const sha256 = createHash('sha256').update(data).digest('hex')
  const written = []
  const result = extractTarGzVerified(gzipSync(tar), {
    targetDir: process.cwd(),
    allowlist: new Map([[path, { size: data.length, sha256 }]]),
    writeFile: (_path, bytes) => {
      written.push(bytes)
    }
  })
  assert.deepEqual(
    result.map((f) => f.path),
    [path]
  )
  assert.deepEqual(written, [data])
})

test('terminates prefix and GNU long names at the first NUL', () => {
  const prefixed = entry('file.txt\0junk', Buffer.alloc(0), 'python/Lib\0junk')
  const long = Buffer.concat([
    entry('././@LongLink', Buffer.from('python/long/file.txt\0junk'), '', 'L'),
    entry('short.txt', Buffer.alloc(0))
  ])
  assert.equal(listTarEntries(prefixed)[0].name, 'python/Lib/file.txt')
  assert.equal(listTarEntries(long)[0].name, 'python/long/file.txt')
})
