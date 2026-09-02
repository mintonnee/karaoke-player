// AnalysisService 테스트용 가짜 analyze 워커. argv[2]로 시나리오를 고르고
// 뒤에는 실제 워커 인자(analyze --input <inst.wav> --json)가 이어진다.
import { existsSync } from 'fs'

const mode = process.argv[2]
const rest = process.argv.slice(3)
const input = rest[rest.indexOf('--input') + 1]

const emit = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`)

if (rest[0] !== 'analyze' || !rest.includes('--json')) {
  process.stderr.write(`unexpected args: ${rest.join(' ')}\n`)
  process.exit(2)
}
if (!input || !existsSync(input)) {
  emit({ type: 'error', code: 'FILE_NOT_FOUND', msg: `no such file: ${input}` })
  process.exit(1)
}

switch (mode) {
  case 'ok':
    emit({ type: 'progress', stage: 'analyze', pct: 30, msg: 'bpm' })
    emit({ type: 'progress', stage: 'analyze', pct: 70, msg: 'key' })
    emit({
      type: 'done',
      result: { bpm: 128.0, bpm_conf: 0.72, key: 'C#m', key_conf: 0.41, version: 1 }
    })
    break
  case 'partial':
    process.stderr.write('checkpoint download failed\n')
    emit({
      type: 'done',
      result: { bpm: null, bpm_conf: null, key: 'Am', key_conf: 0.55, version: 1 }
    })
    break
  case 'error':
    emit({ type: 'error', code: 'UNSUPPORTED_FORMAT', msg: 'not a wav file' })
    process.exit(1)
    break
  default:
    process.stderr.write(`unknown mode: ${mode}\n`)
    process.exit(2)
}
