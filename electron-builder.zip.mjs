/**
 * zip(포터블·무서명) 타깃 — 스펙 001 §4.2.
 * uv / yt-dlp / deno 3종과 사이드카 스테이징본을 모두 동봉한다.
 * 앱은 packaged 시 process.resourcesPath 기준 bin/*.exe, sidecar/ 를 찾는다.
 */
export default {
  extends: 'file:electron-builder.yml',
  artifactName: '${name}-${version}-win-${arch}.${ext}',
  win: {
    target: [{ target: 'zip', arch: ['x64'] }]
  },
  extraResources: [
    { from: 'resources/bin/uv.exe', to: 'bin/uv.exe' },
    { from: 'resources/bin/yt-dlp.exe', to: 'bin/yt-dlp.exe' },
    { from: 'resources/bin/deno.exe', to: 'bin/deno.exe' },
    { from: 'resources/sidecar', to: 'sidecar' }
  ]
}
