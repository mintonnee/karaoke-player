// YtDlpService 테스트용 가짜 yt-dlp. -o 템플릿에서 스크래치 경로를 얻고,
// URL의 마지막 경로 조각으로 시나리오를 고른다.
import { writeFileSync } from 'fs'
import { dirname, join } from 'path'

const args = process.argv.slice(2)
const outputTemplate = args[args.indexOf('-o') + 1]
const scratch = dirname(outputTemplate)
const url = args[args.length - 1]
const mode = url.split('/').pop()

const emitProgress = () => {
  process.stdout.write('[download] Destination: fake\n')
  process.stdout.write('[download]   0.3% of  302.04KiB at  291.68KiB/s ETA 00:01\n')
  process.stdout.write('[download]  45.3% of  302.04KiB at    1.52MiB/s ETA 00:00\n')
  process.stdout.write('[download] 100% of  302.04KiB in 00:00:00 at 2.21MiB/s\n')
}

const mediaPath = join(scratch, 'Fake Song [abc123].m4a')
const thumbPath = join(scratch, 'Fake Song [abc123].webp')

switch (mode) {
  case 'ok':
    emitProgress()
    writeFileSync(mediaPath, 'fake-m4a-bytes')
    writeFileSync(thumbPath, 'fake-webp-bytes')
    process.stdout.write(`${mediaPath}\n`)
    break
  case 'nothumb':
    emitProgress()
    writeFileSync(mediaPath, 'fake-m4a-bytes')
    process.stdout.write(`${mediaPath}\n`)
    break
  case 'noprint':
    // --print 출력이 없어도 스크래치 글로빙으로 파일을 찾아야 한다
    emitProgress()
    writeFileSync(mediaPath, 'fake-m4a-bytes')
    writeFileSync(thumbPath, 'fake-webp-bytes')
    break
  case 'empty':
    emitProgress()
    break
  case 'fail':
    process.stderr.write('WARNING: [youtube] some noisy warning\n')
    process.stderr.write('ERROR: [youtube] zzz: Requested format is not available\n')
    process.exit(1)
    break
  default:
    process.stderr.write(`unknown mode: ${mode}\n`)
    process.exit(2)
}
