import {
  SCHEMA_VERSION,
  listTracksColumns,
  listUserTables,
  readUserVersion,
  structureMismatch
} from './schema'

export type LibraryInspectResult =
  | { kind: 'empty' }
  | { kind: 'current'; version: number }
  | { kind: 'upgrade'; version: number }
  | { kind: 'too_new'; version: number }
  | { kind: 'invalid'; version: number; reason: string }

export function inspectLibraryDb(db: {
  pragma: (source: string, options?: { simple?: boolean }) => unknown
  prepare: (sql: string) => { all: () => Array<{ name: string }> }
}): LibraryInspectResult {
  const version = readUserVersion(db)
  if (!Number.isInteger(version)) {
    return { kind: 'invalid', version: Number.NaN, reason: 'user_version이 정수가 아닙니다' }
  }
  // 미래 버전은 현재 앱 테이블 구조 검사보다 먼저 거부한다
  if (version > SCHEMA_VERSION) return { kind: 'too_new', version }
  if (version < 0) {
    return { kind: 'invalid', version, reason: `음수 user_version(${version})은 지원하지 않습니다` }
  }

  const userTables = listUserTables(db)
  if (version === 0) {
    if (userTables.length === 0) return { kind: 'empty' }
    return {
      kind: 'invalid',
      version: 0,
      reason: `user_version=0 이지만 사용자 테이블이 있습니다: ${userTables.join(', ')}`
    }
  }

  if (!userTables.includes('tracks')) {
    return { kind: 'invalid', version, reason: `버전 ${version} DB에 tracks 테이블이 없습니다` }
  }
  const mismatch = structureMismatch(listTracksColumns(db), version)
  if (mismatch) return { kind: 'invalid', version, reason: mismatch }
  if (version === SCHEMA_VERSION) return { kind: 'current', version }
  return { kind: 'upgrade', version }
}
