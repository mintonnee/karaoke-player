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
import {
  MANIFEST_SCHEMA_VERSION,
  buildRuntimeManifest,
  validateRuntimeManifestShape
} from '../../runtime/manifest'
import { getDistributionPolicy } from '../../runtime/schema'
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

  it('interpreter와 modelsDigest 입력 불일치를 거부한다', async () => {
    const { manifest, locks } = await miniManifest(sidecar)
    const broken = {
      ...manifest,
      interpreter: { ...manifest.interpreter, patch: '3.12.15' },
      modelsDigest: '0'.repeat(64)
    }

    const result = await verifyManifest(broken, locks, sidecar)
    expect(result.ok).toBe(false)
    expect(result.errors.some((error) => error.id === 'interpreter.patch')).toBe(true)
    expect(result.errors.some((error) => error.id === 'modelsDigest')).toBe(true)
  })

  it.each([
    ['nsis', true, { uv: 'download', deno: 'download', 'yt-dlp': 'download' }],
    ['zip', true, { uv: 'bundled', deno: 'bundled', 'yt-dlp': 'bundled' }],
    ['appx', false, { uv: 'bundled', deno: 'bundled', 'yt-dlp': 'disabled' }]
  ] as const)(
    '%s manifest에 정확한 배포 정책을 기록한다',
    async (distribution, urlImport, delivery) => {
      const locks = miniLocks()
      const manifest = await buildRuntimeManifest(locks, sidecar, distribution)

      expect(manifest.schemaVersion).toBe(MANIFEST_SCHEMA_VERSION)
      expect(manifest.distribution).toBe(distribution)
      expect(manifest.capabilities).toEqual({ urlImport })
      expect(manifest.toolDelivery).toEqual(delivery)
      expect(validateRuntimeManifestShape(manifest)).toEqual([])
    }
  )

  it('배포 정책은 runtimeId를 바꾸지 않는다', async () => {
    const locks = miniLocks()
    const nsis = await buildRuntimeManifest(locks, sidecar, 'nsis')
    const zip = await buildRuntimeManifest(locks, sidecar, 'zip')
    const appx = await buildRuntimeManifest(locks, sidecar, 'appx')

    expect(nsis.runtimeId).toBe(zip.runtimeId)
    expect(appx.runtimeId).toBe(zip.runtimeId)
  })

  it('배포 채널과 다른 capability·delivery를 거부한다', async () => {
    const { manifest, locks } = await miniManifest(sidecar)
    const broken = {
      ...manifest,
      capabilities: { urlImport: false },
      toolDelivery: { ...manifest.toolDelivery, uv: 'download' }
    }

    const result = await verifyManifest(broken, locks, sidecar)
    expect(result.ok).toBe(false)
    expect(result.errors.some((error) => error.id === 'capabilities.urlImport')).toBe(true)
    expect(result.errors.some((error) => error.id === 'toolDelivery.uv')).toBe(true)
  })

  it.each([null, {}, { schemaVersion: 2 }, { ...getDistributionPolicy('zip'), schemaVersion: 2 }])(
    'malformed manifest를 예외 없이 거부한다',
    async (malformed) => {
      const result = await verifyManifest(malformed, miniLocks(), sidecar)
      expect(result.ok).toBe(false)
      expect(result.errors.some((error) => error.code === ERROR_CODES.SCHEMA_ERROR)).toBe(true)
    }
  )
})
