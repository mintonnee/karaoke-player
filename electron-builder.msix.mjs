/**
 * MSIX(appx, Store 제출용) 타깃 — 스펙 001 §4.2.
 * Store 정책상 yt-dlp.exe 만 제외한다 → 앱이 리소스 부재를 감지해 URL 임포트를 끈다 (§4.3).
 * identity 값은 Partner Center 발급 전까지 placeholder 를 쓰고 env 로 덮어쓴다.
 */
const env = process.env

export default {
  extends: 'file:electron-builder.yml',
  artifactName: '${name}-${version}-win-${arch}.${ext}',
  win: {
    target: [{ target: 'appx', arch: ['x64'] }]
  },
  appx: {
    identityName: env.APPX_IDENTITY_NAME ?? 'MgkwakKaraokePlayer',
    publisher: env.APPX_PUBLISHER ?? 'CN=Karaoke Player Placeholder Publisher',
    publisherDisplayName: env.APPX_PUBLISHER_DISPLAY_NAME ?? 'mgkwak',
    applicationId: env.APPX_APPLICATION_ID ?? 'KaraokePlayer',
    displayName: 'Karaoke Player',
    // build/appx 타일 배경(둥근 모서리 바깥 투명 영역)과 맞춘 다크 톤 — src/renderer/src/assets/base.css --ev-c-black
    backgroundColor: '#1b1b1f',
    languages: ['en-US', 'ko-KR'],
    addAutoLaunchExtension: false
  },
  extraResources: [
    { from: 'resources/bin/uv.exe', to: 'bin/uv.exe' },
    { from: 'resources/bin/deno.exe', to: 'bin/deno.exe' },
    { from: 'resources/sidecar', to: 'sidecar' }
  ]
}
