// AnalysisService 테스트용 가짜 analyze 워커. argv[2]로 시나리오, argv[3]으로
// 보고할 ANALYSIS_VERSION을 받고, 뒤에는 실제 워커 인자(analyze --input <inst.wav> --json)가 이어진다.
import { existsSync } from 'fs'

const mode = process.argv[2]
const version = Number(process.argv[3])
const rest = process.argv.slice(4)
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

const okResult = { bpm: 128.0, bpm_conf: 0.72, key: 'C#m', key_conf: 0.41, version }

async function run() {
  switch (mode) {
    case 'ok':
      emit({ type: 'progress', stage: 'analyze', pct: 30, msg: 'bpm' })
      emit({ type: 'progress', stage: 'analyze', pct: 70, msg: 'key' })
      emit({ type: 'done', result: okResult })
      return
    case 'partial':
      process.stderr.write('checkpoint download failed\n')
      emit({
        type: 'done',
        result: { bpm: null, bpm_conf: null, key: 'Am', key_conf: 0.55, version }
      })
      return
    case 'error':
      emit({ type: 'error', code: 'UNSUPPORTED_FORMAT', msg: 'not a wav file' })
      process.exit(1)
      return
    case 'low-conf':
      emit({
        type: 'done',
        result: { bpm: 128.0, bpm_conf: 0.2, key: 'C#m', key_conf: 0.41, version }
      })
      return
    case 'null-key':
      emit({
        type: 'done',
        result: { bpm: 128.0, bpm_conf: 0.72, key: null, key_conf: null, version }
      })
      return
    case 'invalid-bpm':
      emit({
        type: 'done',
        result: { bpm: 12, bpm_conf: 0.9, key: 'C#m', key_conf: 0.41, version }
      })
      return
    case 'invalid-key':
      emit({
        type: 'done',
        result: { bpm: 128.0, bpm_conf: 0.72, key: 'Db', key_conf: 0.41, version }
      })
      return
    case 'delay': {
      const ms = Number(process.env.FAKE_ANALYZE_DELAY_MS ?? 200)
      await new Promise((r) => setTimeout(r, Number.isFinite(ms) ? ms : 200))
      emit({ type: 'done', result: okResult })
      return
    }
    case 'hang':
      // Promise만으로는 이벤트 루프가 비어 프로세스가 바로 끝난다
      setInterval(() => {}, 1000)
      return
    default:
      process.stderr.write(`unknown mode: ${mode}\n`)
      process.exit(2)
  }
}

run().catch((error) => {
  process.stderr.write(`${error}\n`)
  process.exit(2)
})
