import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { inspectCoverImage, isDecodableCoverBytes } from '../coverImage'
import { JPEG_SOF, PNG_1X1, WEBP_1X1 } from './coverFixtures'

describe('coverImage', () => {
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'karaoke-cover-image-'))
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('PNG/JPEG/WebP 헤더를 디코딩하고 손상 파일은 거부한다', () => {
    expect(isDecodableCoverBytes(PNG_1X1)).toBe(true)
    expect(isDecodableCoverBytes(JPEG_SOF)).toBe(true)
    expect(isDecodableCoverBytes(WEBP_1X1)).toBe(true)
    expect(isDecodableCoverBytes(Buffer.from('not-an-image'))).toBe(false)
    const fakeJpg = Buffer.from(PNG_1X1)
    fakeJpg[0] = 0x00
    expect(isDecodableCoverBytes(fakeJpg)).toBe(false)
  })

  it('확장자만 jpg인 손상 파일과 크기 초과·디렉토리를 거부한다', async () => {
    const ok = join(root, 'ok.png')
    await writeFile(ok, PNG_1X1)
    expect(await inspectCoverImage(ok)).toEqual({ ok: true })

    const corrupt = join(root, 'bad.jpg')
    await writeFile(corrupt, 'jpeg-but-not')
    expect(await inspectCoverImage(corrupt)).toEqual({
      ok: false,
      message: '커버 이미지를 읽을 수 없습니다'
    })

    const missing = join(root, 'missing.webp')
    expect(await inspectCoverImage(missing)).toEqual({
      ok: false,
      message: '커버 파일을 찾을 수 없습니다'
    })

    const dir = join(root, 'dir.jpg')
    await mkdir(dir)
    expect(await inspectCoverImage(dir)).toEqual({
      ok: false,
      message: '커버가 일반 파일이 아닙니다'
    })

    const txt = join(root, 'notes.txt')
    await writeFile(txt, PNG_1X1)
    expect(await inspectCoverImage(txt)).toEqual({
      ok: false,
      message: '커버는 JPG/PNG/WebP만 사용할 수 있습니다'
    })
  })
})
