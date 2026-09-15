import { mkdirSync } from 'fs'
import { describe, expect, it } from 'vitest'
import { ERROR_CODES, LockError, createZip, extractZipVerified, sha256Hex } from '../../runtime'
import { tempDir } from './helpers'

function allow(
  path: string,
  data: string,
  extra: { executable?: boolean; dest?: string } = {}
): [string, { sha256: string; size: number; executable?: boolean; dest?: string }] {
  const buf = Buffer.from(data)
  return [
    path,
    { sha256: sha256Hex(buf), size: buf.length, executable: extra.executable, dest: extra.dest }
  ]
}

function extract(
  zip: Buffer,
  allowlistEntries: Array<
    [string, { sha256: string; size: number; executable?: boolean; dest?: string }]
  >
): void {
  const targetDir = tempDir('zip-x-')
  mkdirSync(targetDir, { recursive: true })
  extractZipVerified(zip, {
    targetDir,
    allowlist: new Map(allowlistEntries),
    id: 'test-zip',
    writeFile: () => undefined
  })
}

function expectCode(fn: () => void, code: string): void {
  try {
    fn()
    expect.unreachable('expected LockError')
  } catch (err) {
    expect(err).toBeInstanceOf(LockError)
    expect((err as LockError).code).toBe(code)
  }
}

describe('extractZipVerified', () => {
  it('rejects path escape ../', () => {
    const zip = createZip([{ name: '../evil.exe', data: Buffer.from('MZ') }])
    expectCode(
      () => extract(zip, [allow('../evil.exe', 'MZ', { executable: true })]),
      ERROR_CODES.PATH_ESCAPE
    )
  })

  it('rejects absolute unix path', () => {
    const zip = createZip([{ name: '/tmp/evil.exe', data: Buffer.from('MZ') }])
    expectCode(() => extract(zip, [allow('/tmp/evil.exe', 'MZ')]), ERROR_CODES.PATH_ESCAPE)
  })

  it('rejects drive letter path', () => {
    const zip = createZip([{ name: 'C:/Windows/evil.exe', data: Buffer.from('MZ') }])
    expectCode(() => extract(zip, [allow('C:/Windows/evil.exe', 'MZ')]), ERROR_CODES.PATH_ESCAPE)
  })

  it('rejects symlink members', () => {
    const zip = createZip([
      { name: 'link.exe', data: Buffer.from('target'), symlink: true, unixMode: 0o120777 }
    ])
    expectCode(
      () => extract(zip, [allow('link.exe', 'target', { executable: true })]),
      ERROR_CODES.SYMLINK_REJECTED
    )
  })

  it('rejects windows case collision', () => {
    const zip = createZip([
      { name: 'Foo.exe', data: Buffer.from('A') },
      { name: 'foo.exe', data: Buffer.from('B') }
    ])
    expectCode(
      () =>
        extract(zip, [
          allow('Foo.exe', 'A', { executable: true }),
          allow('foo.exe', 'B', { executable: true })
        ]),
      ERROR_CODES.CASE_COLLISION
    )
  })

  it('rejects unexpected executable', () => {
    const zip = createZip([
      { name: 'uv.exe', data: Buffer.from('good') },
      { name: 'evil.exe', data: Buffer.from('bad') }
    ])
    expectCode(
      () => extract(zip, [allow('uv.exe', 'good', { executable: true })]),
      ERROR_CODES.UNEXPECTED_EXECUTABLE
    )
  })
})
