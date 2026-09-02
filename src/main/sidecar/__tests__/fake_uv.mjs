// SidecarBootstrap 테스트용 가짜 uv. argv[2]로 시나리오를 고른다.
import { existsSync, writeFileSync } from 'fs'

const mode = process.argv[2]

switch (mode) {
  case 'ok':
    process.stderr.write('Resolved 42 packages in 1.2s\n')
    process.stderr.write('Installed 42 packages in 3.4s\n')
    process.exit(0)
    break
  case 'fail':
    process.stderr.write('error: Failed to download torch (network unreachable)\n')
    process.exit(1)
    break
  case 'flaky': {
    // 첫 호출은 실패, 두 번째부터 성공 (재시도 흐름). argv[3]은 호출 마커 파일
    const marker = process.argv[3]
    if (!existsSync(marker)) {
      writeFileSync(marker, '1')
      process.stderr.write('error: transient failure\n')
      process.exit(1)
    }
    process.stderr.write('Installed 42 packages in 0.1s\n')
    process.exit(0)
    break
  }
  default:
    process.stderr.write(`unknown mode: ${mode}\n`)
    process.exit(2)
}
