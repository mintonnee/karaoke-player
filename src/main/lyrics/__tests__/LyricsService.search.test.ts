import { mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LrclibRecord } from '../../../shared/lrclib'
import type { Track } from '../../../shared/types'
import { LyricsService, type LyricsServiceOptions } from '../LyricsService'

describe('manual LRCLIB selection', () => {
  let root: string
  let dir: string
  let service: LyricsService
  let track: Track
  const fetchMock = vi.fn()
  const record: LrclibRecord = {
    id: 42,
    trackName: '노래',
    artistName: '가수',
    albumName: '앨범',
    duration: 300,
    instrumental: false,
    syncedLyrics: '[00:01.00]새 가사',
    plainLyrics: '새 가사'
  }

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'lyrics-search-'))
    dir = join(root, 'track')
    await mkdir(dir)
    track = { id: 'track', status: 'ready', lyricsSource: 'user_aligned', duration: 10 } as Track
    fetchMock.mockReset()
    vi.stubGlobal('fetch', fetchMock)
    service = new LyricsService({
      tracksDir: root,
      userAgent: 'test',
      notify: vi.fn(),
      store: {
        getTrack: (id: string) => (id === track.id ? track : undefined),
        updateLyricsSource: (_id: string, source: Track['lyricsSource']) => {
          track.lyricsSource = source
          return track
        }
      }
    } as unknown as LyricsServiceOptions)
  })

  afterEach(async () => {
    vi.unstubAllGlobals()
    await rm(root, { recursive: true, force: true })
  })

  function respond(value: unknown, status = 200): void {
    fetchMock.mockResolvedValue(new Response(JSON.stringify(value), { status }))
  }

  it('encodes a free-text query and preserves candidates with different durations', async () => {
    respond([record])
    expect(await service.search('  노래 & 가수  ')).toEqual([record])
    const url = new URL(fetchMock.mock.calls[0][0])
    expect(url.pathname).toBe('/api/search')
    expect(url.searchParams.get('q')).toBe('노래 & 가수')
    expect(await service.search('   ')).toEqual([])
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('persists the selected ID and clears obsolete alignment and pronunciation', async () => {
    respond(record)
    await writeFile(join(dir, 'align.json'), '[]')
    await writeFile(join(dir, 'pronunciation.json'), '[]')
    const result = await service.select('track', 42)
    expect(fetchMock.mock.calls[0][0]).toBe('https://lrclib.net/api/get/42')
    expect(result).toMatchObject({
      source: 'lrclib_synced',
      lrc: record.syncedLyrics,
      plain: record.plainLyrics,
      lines: null,
      pronunciation: null
    })
    expect(await service.getLyrics('track')).toEqual(result)
  })

  it('plain-only selection removes old synced lyrics and remains available for alignment', async () => {
    respond({ ...record, syncedLyrics: null })
    await writeFile(join(dir, 'lyrics.lrc'), '[00:01.00]이전 가사')
    const result = await service.select('track', 42)
    expect(result).toMatchObject({ source: 'none', lrc: null, plain: '새 가사' })
  })

  it('synced-only selection removes stale plain lyrics', async () => {
    respond({ ...record, plainLyrics: null })
    await writeFile(join(dir, 'lyrics.txt'), '이전 가사')
    expect(await service.select('track', 42)).toMatchObject({
      plain: null,
      lrc: record.syncedLyrics
    })
  })

  it('network failures and unusable selections preserve existing lyrics', async () => {
    await writeFile(join(dir, 'lyrics.txt'), '기존 가사')
    respond({}, 503)
    await expect(service.search('노래')).rejects.toThrow('503')
    await expect(service.select('track', 42)).rejects.toThrow('503')
    respond({ ...record, instrumental: true })
    await expect(service.select('track', 42)).rejects.toThrow('적용할 가사가 없습니다')
    respond(null, 404)
    await expect(service.select('track', 42)).rejects.toThrow('적용할 가사가 없습니다')
    expect(await readFile(join(dir, 'lyrics.txt'), 'utf-8')).toBe('기존 가사')
  })

  it('rejects unknown tracks and invalid IDs before requesting the service', async () => {
    await expect(service.select('missing', 42)).rejects.toThrow('track not found')
    await expect(service.select('track', -1)).rejects.toThrow('ID')
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
