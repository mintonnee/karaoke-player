const unmuted = { masterMuted: false, instMuted: false, vocalMuted: false }
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ANALYSIS_VERSION } from '../../../shared/types'
import { LibraryStore } from '../LibraryStore'

/** 스펙 002 이전(v2) 스키마의 DB를 만든다. 마이그레이션 테스트용 */
function createV2Database(dbPath: string): void {
  const db = new Database(dbPath)
  db.exec(`
    CREATE TABLE tracks (
      id            TEXT PRIMARY KEY,
      title         TEXT NOT NULL,
      artist        TEXT,
      album         TEXT,
      duration      REAL NOT NULL,
      source_path   TEXT NOT NULL,
      status        TEXT NOT NULL,
      lyrics_source TEXT NOT NULL DEFAULT 'none',
      created_at    TEXT NOT NULL,
      updated_at    TEXT NOT NULL,
      search_keys   TEXT NOT NULL DEFAULT ''
    )
  `)
  db.prepare(
    `INSERT INTO tracks (id, title, artist, album, duration, source_path, status, lyrics_source, created_at, updated_at, search_keys)
     VALUES ('old', '옛 트랙', 'Eve', null, 200, 'C:\\music\\old.flac', 'ready', 'lrclib_synced', '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z', '요루시카')`
  ).run()
  db.pragma('user_version = 2')
  db.close()
}

/** 스펙 004 이전(v4) 스키마. import_kind/guide_kind 없음 */
function createV4Database(dbPath: string): void {
  const db = new Database(dbPath)
  db.exec(`
    CREATE TABLE tracks (
      id            TEXT PRIMARY KEY,
      title         TEXT NOT NULL,
      artist        TEXT,
      album         TEXT,
      duration      REAL NOT NULL,
      source_path   TEXT NOT NULL,
      status        TEXT NOT NULL,
      lyrics_source TEXT NOT NULL DEFAULT 'none',
      created_at    TEXT NOT NULL,
      updated_at    TEXT NOT NULL,
      search_keys   TEXT NOT NULL DEFAULT '',
      bpm           REAL,
      music_key     TEXT,
      bpm_conf      REAL,
      key_conf      REAL,
      analysis_version INTEGER NOT NULL DEFAULT 0,
      analysis_source  TEXT NOT NULL DEFAULT 'none',
      sort_order    INTEGER NOT NULL DEFAULT 0
    )
  `)
  db.prepare(
    `INSERT INTO tracks (id, title, artist, album, duration, source_path, status, lyrics_source,
                         created_at, updated_at, search_keys, sort_order)
     VALUES ('old', '옛 트랙', 'Eve', null, 200, 'C:\\music\\old.flac', 'ready', 'lrclib_synced',
             '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z', '요루시카', 0)`
  ).run()
  db.pragma('user_version = 4')
  db.close()
}

describe('LibraryStore', () => {
  let dir: string
  let store: LibraryStore

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'karaoke-library-'))
    store = new LibraryStore(join(dir, 'library.sqlite'))
  })

  afterEach(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  const createTrack = (
    id: string,
    overrides: Partial<Parameters<LibraryStore['createTrack']>[0]> = {}
  ): ReturnType<LibraryStore['createTrack']> =>
    store.createTrack({
      id,
      title: `title-${id}`,
      artist: 'artist',
      album: null,
      duration: 187.2,
      sourcePath: `C:\\music\\${id}.flac`,
      ...overrides
    })

  it('트랙 생성 시 imported/none 기본 상태와 separated/vocal_only를 저장한다', () => {
    const track = createTrack('t1')

    expect(track.status).toBe('imported')
    expect(track.lyricsSource).toBe('none')
    expect(track.importKind).toBe('separated')
    expect(track.guideKind).toBe('vocal_only')
    expect(track.title).toBe('title-t1')
    expect(track.createdAt).toBe(track.updatedAt)
    expect(store.getTrack('t1')).toEqual(track)
  })

  it('조정키는 곡별로 DB 재개방 후 유지하며 메타·볼륨과 독립적이다', () => {
    const a = createTrack('pitch-a')
    createTrack('pitch-b')
    expect(store.getTrackPitch(a.id)).toBe(0)
    store.setTrackPitch(a.id, 6)
    store.setTrackPitch('pitch-b', -6)
    store.close()
    store = new LibraryStore(join(dir, 'library.sqlite'))
    expect(store.getTrackPitch(a.id)).toBe(6)
    expect(store.getTrackPitch('pitch-b')).toBe(-6)
    expect(store.getTrack(a.id)).toEqual(a)
    expect(store.getTrackVolumes(a.id)).toBeNull()
    store.setTrackPitch(a.id, 0)
    expect(store.getTrackPitch(a.id)).toBe(0)
    for (const value of [NaN, Infinity, -7, 7, 1.5, '2', null]) {
      expect(() => store.setTrackPitch(a.id, value as number)).toThrow('pitch must')
      expect(store.getTrackPitch(a.id)).toBe(0)
    }
    expect(() => store.getTrackPitch('missing')).toThrow('track not found')
    expect(() => store.setTrackPitch('missing', 0)).toThrow('track not found')
  })

  it('v7 곡은 조정키 0으로 마이그레이션한다', () => {
    const a = createTrack('pitch-old')
    store.close()
    const raw = new Database(join(dir, 'library.sqlite'))
    raw.exec('ALTER TABLE tracks DROP COLUMN pitch_semitones')
    raw.pragma('user_version = 7')
    raw.close()
    store = new LibraryStore(join(dir, 'library.sqlite'))
    expect(store.getTrackPitch(a.id)).toBe(0)
    expect(store.getTrack(a.id)).toEqual(a)
  })

  it('곡별 볼륨은 DB 재연결 후에도 유지되고 메타데이터는 변경하지 않는다', () => {
    const a = createTrack('a')
    createTrack('b')
    expect(store.getTrackVolumes('a')).toBeNull()
    store.setTrackVolumes('a', { ...unmuted, masterDb: -4, instDb: -8, vocalDb: -15 })
    store.setTrackVolumes('b', { ...unmuted, masterDb: 0, instDb: -60, vocalDb: -20 })
    store.setTrackVolumes('a', {
      masterMuted: true,
      instMuted: true,
      vocalMuted: true,
      masterDb: -3,
      instDb: -7,
      vocalDb: -14
    })
    store.close()
    store = new LibraryStore(join(dir, 'library.sqlite'))
    expect(store.getTrackVolumes('a')).toEqual({
      masterMuted: true,
      instMuted: true,
      vocalMuted: true,
      masterDb: -3,
      instDb: -7,
      vocalDb: -14
    })
    expect(store.getTrackVolumes('b')).toEqual({
      ...unmuted,
      masterDb: 0,
      instDb: -60,
      vocalDb: -20
    })
    expect(store.mustGetTrack('a')).toEqual(a)
    store.deleteTrack('a')
    createTrack('a')
    expect(store.getTrackVolumes('a')).toBeNull()
  })

  it.each([NaN, Infinity, -Infinity, -61, 1, '-5', null, undefined])(
    '비정상 볼륨 %s를 거부하고 저장값을 보존한다',
    (value) => {
      createTrack('a')
      const original = { ...unmuted, masterDb: -3, instDb: -7, vocalDb: -14 }
      store.setTrackVolumes('a', original)
      for (const key of ['masterDb', 'instDb', 'vocalDb']) {
        expect(() => store.setTrackVolumes('a', { ...original, [key]: value })).toThrow(
          'volume must'
        )
        expect(store.getTrackVolumes('a')).toEqual(original)
      }
    }
  )

  it.each([0, 1, 'false', null, undefined])('비정상 뮤트 %s를 거부한다', (value) => {
    createTrack('a')
    const original = { ...unmuted, masterDb: -3, instDb: -7, vocalDb: -14 }
    store.setTrackVolumes('a', original)
    for (const key of ['masterMuted', 'instMuted', 'vocalMuted']) {
      expect(() => store.setTrackVolumes('a', { ...original, [key]: value })).toThrow('mute must')
      expect(store.getTrackVolumes('a')).toEqual(original)
    }
  })

  it('v6 볼륨 저장값을 보존하면서 뮤트는 해제 상태로 마이그레이션한다', () => {
    store.close()
    const dbPath = join(dir, 'v6.sqlite')
    createV4Database(dbPath)
    const raw = new Database(dbPath)
    raw.exec(`
      ALTER TABLE tracks ADD COLUMN import_kind TEXT NOT NULL DEFAULT 'separated';
      ALTER TABLE tracks ADD COLUMN guide_kind TEXT NOT NULL DEFAULT 'vocal_only';
      ALTER TABLE tracks ADD COLUMN master_db REAL;
      ALTER TABLE tracks ADD COLUMN inst_db REAL;
      ALTER TABLE tracks ADD COLUMN vocal_db REAL;
      UPDATE tracks SET master_db = -3, inst_db = -7, vocal_db = -14;
    `)
    raw.pragma('user_version = 6')
    raw.close()
    store = new LibraryStore(dbPath)
    expect(store.getTrackVolumes('old')).toEqual({
      ...unmuted,
      masterDb: -3,
      instDb: -7,
      vocalDb: -14
    })
  })

  it('없는 곡의 볼륨 읽기와 저장은 실패하며 삭제된 곡을 재생성하지 않는다', () => {
    expect(() => store.getTrackVolumes('missing')).toThrow('track not found')
    expect(() =>
      store.setTrackVolumes('missing', { ...unmuted, masterDb: 0, instDb: 0, vocalDb: 0 })
    ).toThrow('track not found')
    expect(store.listTracks()).toEqual([])
  })

  it('v5 DB 마이그레이션은 기존 곡을 보존하고 볼륨을 미설정으로 둔다', () => {
    store.close()
    const dbPath = join(dir, 'v5.sqlite')
    createV4Database(dbPath)
    const raw = new Database(dbPath)
    raw.exec(
      "ALTER TABLE tracks ADD COLUMN import_kind TEXT NOT NULL DEFAULT 'separated'; ALTER TABLE tracks ADD COLUMN guide_kind TEXT NOT NULL DEFAULT 'vocal_only';"
    )
    raw.pragma('user_version = 5')
    raw.close()
    store = new LibraryStore(dbPath)
    expect(store.mustGetTrack('old')).toMatchObject({ title: '옛 트랙', status: 'ready' })
    expect(store.getTrackVolumes('old')).toBeNull()
    store.setTrackVolumes('old', { ...unmuted, masterDb: -1, instDb: -2, vocalDb: -3 })
    store.close()
    store = new LibraryStore(dbPath)
    expect(store.getTrackVolumes('old')).toEqual({
      ...unmuted,
      masterDb: -1,
      instDb: -2,
      vocalDb: -3
    })
  })

  it('separated + full_mix 조합은 거부하고 행을 만들지 않는다', () => {
    expect(() => createTrack('bad', { importKind: 'separated', guideKind: 'full_mix' })).toThrow(
      'separated tracks cannot have guideKind full_mix'
    )
    expect(store.getTrack('bad')).toBeUndefined()
  })

  it('paired + full_mix 는 ready 한 행으로 저장할 수 있다', () => {
    const track = createTrack('p1', {
      importKind: 'paired',
      guideKind: 'full_mix',
      status: 'ready'
    })
    expect(track.status).toBe('ready')
    expect(track.importKind).toBe('paired')
    expect(track.guideKind).toBe('full_mix')
  })

  it('상태 갱신 시 updated_at이 바뀌고 조회에 반영된다', () => {
    const created = createTrack('t1')
    const updated = store.updateStatus('t1', 'separating')

    expect(updated.status).toBe('separating')
    expect(Date.parse(updated.updatedAt)).toBeGreaterThanOrEqual(Date.parse(created.updatedAt))
    expect(store.getTrack('t1')?.status).toBe('separating')
  })

  it('failStaleSeparating은 separating만 failed로 바꾼다', () => {
    createTrack('a')
    createTrack('b')
    createTrack('c')
    store.updateStatus('a', 'separating')
    store.updateStatus('b', 'ready')

    expect(store.failStaleSeparating()).toBe(1)
    expect(store.getTrack('a')?.status).toBe('failed')
    expect(store.getTrack('b')?.status).toBe('ready')
    expect(store.getTrack('c')?.status).toBe('imported')
  })

  it('재오픈 후에도 데이터가 남아 있다 (S3 DoD 기반)', () => {
    createTrack('t1')
    store.close()

    store = new LibraryStore(join(dir, 'library.sqlite'))
    expect(store.getTrack('t1')?.title).toBe('title-t1')
  })

  it('없는 트랙 갱신은 오류를 던진다', () => {
    expect(() => store.updateStatus('missing', 'ready')).toThrow('track not found')
  })

  it('검색은 title/artist/album 부분 일치로 필터한다', () => {
    createTrack('a', { title: '廻廻奇譚', artist: 'Eve', album: null })
    createTrack('b', { title: '夜に駆ける', artist: 'YOASOBI', album: 'THE BOOK' })
    createTrack('c', { title: 'ハルジオン', artist: 'YOASOBI', album: 'THE BOOK' })

    expect(
      store
        .listTracks('YOASOBI')
        .map((t) => t.id)
        .sort()
    ).toEqual(['b', 'c'])
    expect(store.listTracks('廻廻').map((t) => t.id)).toEqual(['a'])
    expect(
      store
        .listTracks('BOOK')
        .map((t) => t.id)
        .sort()
    ).toEqual(['b', 'c'])
    expect(store.listTracks('없는검색어')).toEqual([])
    expect(store.listTracks('  ')).toHaveLength(3)
  })

  it('메타 편집: trim 후 저장, 빈 값은 null, 빈 제목은 거부', () => {
    createTrack('t1')
    const updated = store.updateMeta('t1', { title: '  새 제목 ', artist: ' Eve ', album: '' })

    expect(updated.title).toBe('새 제목')
    expect(updated.artist).toBe('Eve')
    expect(updated.album).toBeNull()
    expect(() => store.updateMeta('t1', { title: '   ', artist: null, album: null })).toThrow(
      'title must not be empty'
    )
  })

  it('삭제하면 목록에서 사라지고 반환값으로 성공 여부를 알린다', () => {
    createTrack('t1')
    expect(store.deleteTrack('t1')).toBe(true)
    expect(store.getTrack('t1')).toBeUndefined()
    expect(store.deleteTrack('t1')).toBe(false)
  })

  describe('드래그 정렬 (sort_order)', () => {
    it('새 트랙은 목록 맨 위로 들어간다 (최신 순 기본 유지)', () => {
      createTrack('a')
      createTrack('b')
      createTrack('c')
      expect(store.listTracks().map((t) => t.id)).toEqual(['c', 'b', 'a'])
    })

    it('reorderTracks로 준 순서가 listTracks에 반영되고 재오픈 후에도 남는다', () => {
      createTrack('a')
      createTrack('b')
      createTrack('c')
      store.reorderTracks(['a', 'c', 'b'])
      expect(store.listTracks().map((t) => t.id)).toEqual(['a', 'c', 'b'])

      store.close()
      store = new LibraryStore(join(dir, 'library.sqlite'))
      expect(store.listTracks().map((t) => t.id)).toEqual(['a', 'c', 'b'])
    })

    it('정렬 뒤 새로 만든 트랙도 맨 위로 온다', () => {
      createTrack('a')
      createTrack('b')
      store.reorderTracks(['a', 'b'])
      createTrack('c')
      expect(store.listTracks().map((t) => t.id)).toEqual(['c', 'a', 'b'])
    })

    it('ids에 빠진 트랙은 기존 순서대로 뒤에 붙고, 모르는 id는 무시한다', () => {
      createTrack('a')
      createTrack('b')
      createTrack('c')
      store.reorderTracks(['a', 'ghost'])
      expect(store.listTracks().map((t) => t.id)).toEqual(['a', 'c', 'b'])
    })

    it('검색 필터 결과도 저장된 순서를 따른다', () => {
      createTrack('a', { title: '노래 하나' })
      createTrack('b', { title: '다른 곡' })
      createTrack('c', { title: '노래 둘' })
      store.reorderTracks(['c', 'b', 'a'])
      expect(store.listTracks('노래').map((t) => t.id)).toEqual(['c', 'a'])
    })
  })

  describe('스키마 v4 마이그레이션 (드래그 정렬)', () => {
    it('v2 DB를 열면 최신 버전까지 올라가고 기존 행은 최신 순으로 번호가 매겨진다', () => {
      store.close()
      const dbPath = join(dir, 'v2-to-v4.sqlite')
      createV2Database(dbPath)

      store = new LibraryStore(dbPath)
      const raw = new Database(dbPath, { readonly: true })
      expect(raw.pragma('user_version', { simple: true })).toBe(8)
      const row = raw.prepare('SELECT sort_order FROM tracks WHERE id = ?').get('old') as {
        sort_order: number
      }
      expect(row.sort_order).toBe(0)
      raw.close()

      // 마이그레이션 이후 새 트랙은 기존 행보다 위
      createTrack('new')
      expect(store.listTracks().map((t) => t.id)).toEqual(['new', 'old'])
    })
  })

  describe('스키마 v3 마이그레이션 (스펙 002 기준 3)', () => {
    it('v2 DB를 열면 최신 버전으로 올라가고 기존 행이 보존되며 분석 컬럼은 기본값이다', () => {
      store.close()
      const dbPath = join(dir, 'v2.sqlite')
      createV2Database(dbPath)

      store = new LibraryStore(dbPath)
      const raw = new Database(dbPath, { readonly: true })
      expect(raw.pragma('user_version', { simple: true })).toBe(8)
      raw.close()

      const old = store.getTrack('old')!
      expect(old.title).toBe('옛 트랙')
      expect(old.status).toBe('ready')
      expect(old.lyricsSource).toBe('lrclib_synced')
      expect(old.updatedAt).toBe('2026-01-02T00:00:00.000Z')
      expect(old.bpm).toBeNull()
      expect(old.musicKey).toBeNull()
      expect(old.bpmConf).toBeNull()
      expect(old.keyConf).toBeNull()
      expect(old.analysisSource).toBe('none')
      // 검색 키도 보존되어 백필 없이 검색된다
      expect(store.listTracks('요루시카').map((t) => t.id)).toEqual(['old'])
      // 기존 ready 트랙은 백필 대상
      expect(store.listTracksNeedingAnalysis().map((t) => t.id)).toEqual(['old'])
    })

    it('새 트랙은 분석 컬럼이 비어 있다', () => {
      const track = createTrack('t1')
      expect(track.bpm).toBeNull()
      expect(track.musicKey).toBeNull()
      expect(track.bpmConf).toBeNull()
      expect(track.keyConf).toBeNull()
      expect(track.analysisSource).toBe('none')
    })
  })

  describe('스키마 v5 마이그레이션 (가져오기 종류)', () => {
    it('v4 DB를 열면 최신 버전으로 올라가고 기존 행은 separated/vocal_only이며 데이터가 보존된다', () => {
      store.close()
      const dbPath = join(dir, 'v4-to-v5.sqlite')
      createV4Database(dbPath)

      store = new LibraryStore(dbPath)
      const raw = new Database(dbPath, { readonly: true })
      expect(raw.pragma('user_version', { simple: true })).toBe(8)
      const row = raw
        .prepare('SELECT import_kind, guide_kind, title, status FROM tracks WHERE id = ?')
        .get('old') as {
        import_kind: string
        guide_kind: string
        title: string
        status: string
      }
      expect(row.import_kind).toBe('separated')
      expect(row.guide_kind).toBe('vocal_only')
      expect(row.title).toBe('옛 트랙')
      expect(row.status).toBe('ready')
      raw.close()

      const old = store.getTrack('old')!
      expect(old.importKind).toBe('separated')
      expect(old.guideKind).toBe('vocal_only')
      expect(old.artist).toBe('Eve')
      expect(old.duration).toBe(200)
      expect(old.sourcePath).toBe('C:\\music\\old.flac')
    })
  })

  describe('setAnalysis / listTracksNeedingAnalysis', () => {
    const analysis = { bpm: 128, musicKey: 'C#m', bpmConf: 0.72, keyConf: 0.41, version: 1 }

    it('auto로 저장하고 updated_at은 바꾸지 않는다', () => {
      const created = createTrack('t1')
      const updated = store.setAnalysis('t1', analysis)

      expect(updated.bpm).toBe(128)
      expect(updated.musicKey).toBe('C#m')
      expect(updated.bpmConf).toBe(0.72)
      expect(updated.keyConf).toBe(0.41)
      expect(updated.analysisSource).toBe('auto')
      expect(updated.updatedAt).toBe(created.updatedAt)
      expect(store.getTrack('t1')).toEqual(updated)
    })

    it('null 결과(추정 불가)도 auto로 저장한다', () => {
      createTrack('t1')
      const updated = store.setAnalysis('t1', {
        bpm: null,
        musicKey: null,
        bpmConf: null,
        keyConf: null,
        version: 1
      })
      expect(updated.bpm).toBeNull()
      expect(updated.musicKey).toBeNull()
      expect(updated.analysisSource).toBe('auto')
    })

    it('user 값이 있는 행은 덮어쓰지 않고 현재 행을 돌려준다', () => {
      createTrack('t1')
      store.updateMeta('t1', { title: 'x', artist: null, album: null, bpm: 96, musicKey: 'Bm' })
      const result = store.setAnalysis('t1', analysis)

      expect(result.bpm).toBe(96)
      expect(result.musicKey).toBe('Bm')
      expect(result.analysisSource).toBe('user')
      expect(store.getTrack('t1')).toEqual(result)
    })

    it('없는 트랙은 오류를 던진다', () => {
      expect(() => store.setAnalysis('missing', analysis)).toThrow('track not found')
    })

    it('ready이고 user가 아니며 버전이 낮은 트랙만 백필 대상이다', () => {
      createTrack('imported')
      createTrack('ready-none')
      createTrack('ready-auto')
      createTrack('ready-old')
      createTrack('ready-user')
      createTrack('failed')
      store.updateStatus('ready-none', 'ready')
      store.updateStatus('ready-auto', 'ready')
      store.updateStatus('ready-old', 'ready')
      store.updateStatus('ready-user', 'ready')
      store.updateStatus('failed', 'failed')
      store.setAnalysis('ready-auto', { ...analysis, version: ANALYSIS_VERSION })
      store.setAnalysis('ready-old', { ...analysis, version: ANALYSIS_VERSION - 1 })
      store.updateMeta('ready-user', { title: 'u', artist: null, album: null, bpm: 100 })

      expect(
        store
          .listTracksNeedingAnalysis()
          .map((t) => t.id)
          .sort()
      ).toEqual(['ready-none', 'ready-old'])
    })
  })

  describe('updateMeta 분석 값 (스펙 002 기준 6)', () => {
    const base = { title: '제목', artist: null, album: null }

    it('bpm·musicKey를 주면 user로 저장하고 conf는 비운다', () => {
      createTrack('t1')
      store.setAnalysis('t1', { bpm: 128, musicKey: 'C#m', bpmConf: 0.7, keyConf: 0.4, version: 1 })
      const updated = store.updateMeta('t1', { ...base, bpm: 96, musicKey: 'Bm' })

      expect(updated.bpm).toBe(96)
      expect(updated.musicKey).toBe('Bm')
      expect(updated.bpmConf).toBeNull()
      expect(updated.keyConf).toBeNull()
      expect(updated.analysisSource).toBe('user')
    })

    it('둘 다 undefined면 분석 컬럼은 그대로 둔다 (touchTrack 경로)', () => {
      createTrack('t1')
      store.setAnalysis('t1', { bpm: 128, musicKey: 'C#m', bpmConf: 0.7, keyConf: 0.4, version: 1 })
      const updated = store.updateMeta('t1', base)

      expect(updated.title).toBe('제목')
      expect(updated.bpm).toBe(128)
      expect(updated.musicKey).toBe('C#m')
      expect(updated.bpmConf).toBe(0.7)
      expect(updated.keyConf).toBe(0.4)
      expect(updated.analysisSource).toBe('auto')
    })

    it('한쪽만 주면 다른 쪽 값은 유지한 채 user로 바뀐다', () => {
      createTrack('t1')
      store.setAnalysis('t1', { bpm: 128, musicKey: 'C#m', bpmConf: 0.7, keyConf: 0.4, version: 1 })
      const updated = store.updateMeta('t1', { ...base, musicKey: 'Bm' })

      expect(updated.bpm).toBe(128)
      expect(updated.musicKey).toBe('Bm')
      expect(updated.analysisSource).toBe('user')
    })

    it('null과 빈 문자열은 값 없음으로 저장한다', () => {
      createTrack('t1')
      store.setAnalysis('t1', { bpm: 128, musicKey: 'C#m', bpmConf: 0.7, keyConf: 0.4, version: 1 })
      const updated = store.updateMeta('t1', { ...base, bpm: null, musicKey: '' })

      expect(updated.bpm).toBeNull()
      expect(updated.musicKey).toBeNull()
      expect(updated.analysisSource).toBe('user')
    })

    it('형식이 틀린 키와 범위 밖 BPM은 거부하고 행을 바꾸지 않는다', () => {
      createTrack('t1')
      const before = store.setAnalysis('t1', {
        bpm: 128,
        musicKey: 'C#m',
        bpmConf: 0.7,
        keyConf: 0.4,
        version: 1
      })

      for (const musicKey of ['H', 'c#', 'Db', 'Cm7', 'C #']) {
        expect(() => store.updateMeta('t1', { ...base, musicKey })).toThrow('invalid music key')
      }
      for (const bpm of [29, 301, 0, -10, Number.NaN, Number.POSITIVE_INFINITY]) {
        expect(() => store.updateMeta('t1', { ...base, bpm })).toThrow('bpm must be between')
      }
      expect(store.getTrack('t1')).toEqual(before)
    })

    it('경계값 30·300과 모든 형식의 키를 허용한다', () => {
      createTrack('t1')
      expect(store.updateMeta('t1', { ...base, bpm: 30 }).bpm).toBe(30)
      expect(store.updateMeta('t1', { ...base, bpm: 300 }).bpm).toBe(300)
      for (const musicKey of ['C', 'F#', 'Am', 'G#m', ' Bm ']) {
        expect(store.updateMeta('t1', { ...base, musicKey }).musicKey).toBe(musicKey.trim())
      }
    })
  })

  describe('applyMetaPatch', () => {
    it('변경 필드만 합치고 생략한 분석 값은 유지한다', () => {
      createTrack('t1', { artist: 'Eve', album: 'album' })
      store.setAnalysis('t1', { bpm: 128, musicKey: 'C#m', bpmConf: 0.7, keyConf: 0.4, version: 1 })
      const updated = store.applyMetaPatch('t1', { title: '  새 제목  ' })

      expect(updated.title).toBe('새 제목')
      expect(updated.artist).toBe('Eve')
      expect(updated.album).toBe('album')
      expect(updated.bpm).toBe(128)
      expect(updated.musicKey).toBe('C#m')
      expect(updated.bpmConf).toBe(0.7)
      expect(updated.analysisSource).toBe('auto')
    })

    it('BPM만 고치면 user가 되고 키는 최신 값을 유지한다', () => {
      createTrack('t1')
      store.setAnalysis('t1', { bpm: 128, musicKey: 'C#m', bpmConf: 0.7, keyConf: 0.4, version: 1 })
      const updated = store.applyMetaPatch('t1', { bpm: 96 })
      expect(updated.bpm).toBe(96)
      expect(updated.musicKey).toBe('C#m')
      expect(updated.bpmConf).toBeNull()
      expect(updated.keyConf).toBeNull()
      expect(updated.analysisSource).toBe('user')
    })

    it('빈 패치도 updatedAt을 올리고 연속 호출은 캐시 키가 겹치지 않는다', () => {
      createTrack('t1')
      const first = store.applyMetaPatch('t1', {})
      const second = store.applyMetaPatch('t1', {})
      expect(second.updatedAt > first.updatedAt).toBe(true)
      expect(second.updatedAt).not.toBe(first.updatedAt)
    })

    it('없는 곡은 거부하고 행을 만들지 않는다', () => {
      expect(() => store.applyMetaPatch('missing', { title: 'x' })).toThrow('track not found')
      expect(store.getTrack('missing')).toBeUndefined()
      expect(store.listTracks()).toEqual([])
    })
  })
})
