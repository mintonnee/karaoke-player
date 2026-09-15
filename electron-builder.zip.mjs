/**
 * zip(포터블·무서명) 타깃 — 스펙 001 §4.2, 008 기준 9.
 * uv / yt-dlp / deno 와 sidecar, lock, runtime-manifest 를 동봉한다.
 */
import { extraResourcesFor, writeRuntimeManifest } from './electron-builder.manifest.mjs'

export default {
  extends: 'file:electron-builder.yml',
  artifactName: '${name}-${version}-win-${arch}.${ext}',
  win: {
    target: [{ target: 'zip', arch: ['x64'] }]
  },
  extraResources: extraResourcesFor('zip'),
  beforePack: async () => {
    await writeRuntimeManifest()
  }
}
