/**
 * MSIX(appx, Store 제출용) 타깃 — 스펙 001 §4.2, 008 기준 9.
 * Store 정책상 yt-dlp.exe 만 제외한다. lock·runtime-manifest 는 포함한다.
 */
import { extraResourcesFor, writeRuntimeManifest } from './electron-builder.manifest.mjs'

const env = process.env

export default {
  extends: 'file:electron-builder.yml',
  artifactName: '${name}-${version}-win-${arch}.${ext}',
  win: {
    target: [{ target: 'appx', arch: ['x64'] }]
  },
  appx: {
    identityName: env.APPX_IDENTITY_NAME ?? 'MintonneeKaraokePlayer',
    publisher: env.APPX_PUBLISHER ?? 'CN=Karaoke Player Placeholder Publisher',
    publisherDisplayName: env.APPX_PUBLISHER_DISPLAY_NAME ?? 'mintonnee',
    applicationId: env.APPX_APPLICATION_ID ?? 'KaraokePlayer',
    displayName: 'Karaoke Player',
    // build/appx 타일 배경(둥근 모서리 바깥 투명 영역)과 맞춘 다크 톤 — src/renderer/src/assets/base.css --ev-c-black
    backgroundColor: '#1b1b1f',
    languages: ['en-US', 'ko-KR'],
    addAutoLaunchExtension: false
  },
  extraResources: extraResourcesFor('appx'),
  beforePack: async () => {
    await writeRuntimeManifest()
  }
}
