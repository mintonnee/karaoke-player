/**
 * 패키징용 리소스 준비 (스펙 008 §4.1·§4.2, 001 스테이징 유지).
 * tools.lock 의 hash 검증 후에만 resources/bin 에 배치한다. lock 파일은 쓰지 않는다.
 * 실행: pnpm prepare:resources  (--force 로 재다운로드 후 재검증)
 */

import { dirname, resolve } from 'path'
import { fileURLToPath } from 'url'
import { prepareResources } from './runtime-lock/prepare.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const force = process.argv.includes('--force')

await prepareResources({ root, force })
