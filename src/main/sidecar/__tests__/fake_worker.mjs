// SidecarManager 테스트용 가짜 워커. argv[2]로 시나리오를 고른다.
const mode = process.argv[2]

const emit = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`)

switch (mode) {
  case 'ok':
    emit({ type: 'progress', stage: 'probe', pct: 10, msg: 'reading' })
    emit({ type: 'progress', stage: 'probe', pct: 90, msg: 'almost' })
    emit({ type: 'done', result: { duration: 187.2, title: 'fake song' } })
    break
  case 'error':
    emit({ type: 'error', code: 'CUDA_OOM', msg: 'out of memory' })
    process.exit(1)
    break
  case 'hang':
    emit({ type: 'progress', stage: 'separate', pct: 1, msg: 'stuck' })
    setInterval(() => {}, 1000)
    break
  case 'garbage':
    process.stdout.write('this is not json\n')
    emit({ type: 'done', result: { ok: true } })
    break
  case 'silent':
    process.exit(3)
    break
  default:
    process.stderr.write(`unknown mode: ${mode}\n`)
    process.exit(2)
}
