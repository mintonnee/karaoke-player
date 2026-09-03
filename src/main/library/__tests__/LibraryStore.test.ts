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

  it('트랙 생성 시 imported/none 기본 상태로 저장한다', () => {
    const track = createTrack('t1')

    expect(track.status).toBe('imported')
    expect(track.lyricsSource).toBe('none')
    expect(track.title).toBe('title-t1')
    expect(track.createdAt).toBe(track.updatedAt)
    expect(store.getTrack('t1')).toEqual(track)
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
    it('v2 DB를 열면 v4까지 올라가고 기존 행은 최신 순으로 번호가 매겨진다', () => {
      store.close()
      const dbPath = join(dir, 'v2-to-v4.sqlite')
      createV2Database(dbPath)

      store = new LibraryStore(dbPath)
      const raw = new Database(dbPath, { readonly: true })
      expect(raw.pragma('user_version', { simple: true })).toBe(4)
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
      expect(raw.pragma('user_version', { simple: true })).toBe(4)
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
})
