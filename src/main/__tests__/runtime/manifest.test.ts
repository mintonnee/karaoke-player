import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  ERROR_CODES,
  computeRuntimeId,
  computeSidecarSourceDigest,
  verifyManifest
} from '../../runtime'
import { miniLocks, miniManifest, writeMiniSidecar } from './helpers'

let root: string
let sidecar: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'karaoke-manifest-'))
  sidecar = join(root, 'sidecar')
  await writeMiniSidecar(sidecar)
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('computeSidecarSourceDigest', () => {
  it('.python-version 변경 시 digest가 바뀐다', async () => {
    const initial = await computeSidecarSourceDigest(sidecar)
    await writeFile(join(sidecar, '.python-version'), '3.13\n')
    expect(await computeSidecarSourceDigest(sidecar)).not.toBe(initial)
  })

  it('pyproject.toml·uv.lock·src 변경도 digest를 바꾼다', async () => {
    const initial = await computeSidecarSourceDigest(sidecar)
    await writeFile(join(sidecar, 'src', 'karaoke_worker', 'cli.py'), 'updated')
    expect(await computeSidecarSourceDigest(sidecar)).not.toBe(initial)
  })

  it('제외 캐시 파일은 digest에 넣지 않는다', async () => {
    const initial = await computeSidecarSourceDigest(sidecar)
    await mkdir(join(sidecar, 'src', 'karaoke_worker', '__pycache__'), { recursive: true })
    await writeFile(join(sidecar, 'src', 'karaoke_worker', '__pycache__', 'cli.pyc'), 'bin')
    expect(await computeSidecarSourceDigest(sidecar)).toBe(initial)
  })
})

describe('verifyManifest / runtimeId', () => {
  it('일치하는 lock·sidecar는 수락한다', async () => {
    const { manifest, locks } = await miniManifest(sidecar)
    const result = await verifyManifest(manifest, locks, sidecar)
    expect(result.ok).toBe(true)
    expect(result.runtimeId).toBe(manifest.runtimeId)
  })

  it('앱 표시 버전은 runtimeId에 영향을 주지 않는다', async () => {
    const sidecarDigest = await computeSidecarSourceDigest(sidecar)
    const a = computeRuntimeId({
      platform: 'win32-x64',
      interpreter: { patch: '3.12.14', distributionBuild: '20260901' },
      wheelListDigest: 'w',
      uvToolDigest: 'u',
      sidecarSourceDigest: sidecarDigest
    })
    const b = computeRuntimeId({
      platform: 'win32-x64',
      interpreter: { patch: '3.12.14', distributionBuild: '20260901' },
      wheelListDigest: 'w',
      uvToolDigest: 'u',
      sidecarSourceDigest: sidecarDigest
    })
    expect(a).toBe(b)
  })

  it('모델 digest는 runtimeId에 넣지 않는다', async () => {
    const sidecarDigest = await computeSidecarSourceDigest(sidecar)
    const input = {
      platform: 'win32-x64' as const,
      interpreter: { patch: '3.12.14', distributionBuild: '20260901' },
      wheelListDigest: 'w',
      uvToolDigest: 'u',
      sidecarSourceDigest: sidecarDigest
    }
    expect(computeRuntimeId(input)).toBe(computeRuntimeId(input))
  })

  it('sidecar digest 불일치를 거부한다', async () => {
    const { manifest, locks } = await miniManifest(sidecar)
    manifest.sidecarSourceDigest = '0'.repeat(64)
    const result = await verifyManifest(manifest, locks, sidecar)
    expect(result.ok).toBe(false)
    expect(result.errors.some((e) => e.code === ERROR_CODES.HASH_MISMATCH)).toBe(true)
  })

  it('platform 불일치를 거부한다', async () => {
    const { manifest, locks } = await miniManifest(sidecar)
    const broken = { ...manifest, platform: 'darwin-arm64' as typeof manifest.platform }
    const result = await verifyManifest(broken, locks, sidecar)
    expect(result.ok).toBe(false)
    expect(result.errors.some((e) => e.code === ERROR_CODES.BAD_PLATFORM)).toBe(true)
  })

  it('필수 sidecar 파일 누락을 거부한다', async () => {
    const { manifest, locks } = await miniManifest(sidecar)
    await rm(join(sidecar, '.python-version'))
    const result = await verifyManifest(manifest, locks, sidecar)
    expect(result.ok).toBe(false)
    expect(result.errors.some((e) => e.message.includes('.python-version'))).toBe(true)
  })

  it('runtimeId 불일치를 거부한다', async () => {
    const { manifest, locks } = await miniManifest(sidecar)
    manifest.runtimeId = 'deadbeef'
    const result = await verifyManifest(manifest, locks, sidecar)
    expect(result.ok).toBe(false)
    expect(result.errors.some((e) => e.id === 'runtimeId')).toBe(true)
  })

  it('lock digest 불일치를 거부한다', async () => {
    const { manifest } = await miniManifest(sidecar)
    const other = miniLocks({ pythonBytes: Buffer.from('other-python') })
    const result = await verifyManifest(manifest, other, sidecar)
    expect(result.ok).toBe(false)
    expect(result.errors.some((e) => e.code === ERROR_CODES.HASH_MISMATCH)).toBe(true)
  })
})
