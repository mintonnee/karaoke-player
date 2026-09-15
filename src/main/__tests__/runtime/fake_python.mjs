// 테스트용 가짜 인터프리터. 실제 CPython을 받지 않는다.
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'

const args = process.argv.slice(2)

if (args[0] === '-m' && args[1] === 'venv') {
  const dest = args[2]
  mkdirSync(join(dest, 'Scripts'), { recursive: true })
  writeFileSync(join(dest, 'pyvenv.cfg'), 'home = fake\ninclude-system-site-packages = false\n')
  writeFileSync(join(dest, 'Scripts', 'python.exe'), 'fake')
  process.exit(0)
}

if (args[0] === '-m' && args[1] === 'pip') {
  process.exit(0)
}

if (args[0] === '-c') {
  process.exit(0)
}

if (args[0] === '-m' && args[1] === 'karaoke_worker') {
  process.stdout.write(`${JSON.stringify({ type: 'done', result: { ok: true } })}\n`)
  process.exit(0)
}

process.exit(0)
