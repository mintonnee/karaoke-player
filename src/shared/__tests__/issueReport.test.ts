import { describe, expect, it } from 'vitest'
import {
  ISSUES_NEW_URL,
  buildIssueBody,
  buildIssueTitle,
  buildIssueUrl,
  redactPaths
} from '../issueReport'
import type { AppErrorReport, AppInfo } from '../types'

const info: AppInfo = { version: '0.1.0', platform: 'win32', arch: 'x64', electron: '33.0.0' }

function error(overrides: Partial<AppErrorReport> = {}): AppErrorReport {
  return {
    source: 'separate',
    message: 'sidecar exited with code 1',
    at: '2026-09-04T01:00:00.000Z',
    ...overrides
  }
}

describe('redactPaths', () => {
  it('Windows/Unix 홈 경로의 사용자명을 지운다', () => {
    expect(redactPaths('read C:\\Users\\mingyu\\Music\\a.flac failed')).toBe(
      'read <home>\\Music\\a.flac failed'
    )
    expect(redactPaths('/home/alice/x and /Users/bob/y')).toBe('<home>/x and <home>/y')
  })
})

describe('buildIssueTitle', () => {
  it('출처 라벨 + 한 줄 메시지, 80자 말줄임', () => {
    expect(buildIssueTitle(error())).toBe('[보컬 분리] sidecar exited with code 1')
    const long = buildIssueTitle(error({ message: 'x'.repeat(200) }))
    expect(long.length).toBe(80)
    expect(long.endsWith('…')).toBe(true)
  })

  it('개행은 공백으로 접는다', () => {
    expect(buildIssueTitle(error({ message: 'line1\n  line2' }))).toBe('[보컬 분리] line1 line2')
  })

  it('runtime 오류는 실행 환경으로 표시한다', () => {
    expect(buildIssueTitle(error({ source: 'runtime', message: 'manifest missing' }))).toBe(
      '[실행 환경] manifest missing'
    )
  })
})

describe('buildIssueBody', () => {
  it('오류 목록과 환경 정보를 담고 경로는 가린다', () => {
    const body = buildIssueBody(
      [error(), error({ source: 'lyrics', message: 'align failed: C:\\Users\\me\\v.wav' })],
      info
    )
    expect(body).toContain('**보컬 분리** — sidecar exited with code 1')
    expect(body).toContain('**가사** — align failed: <home>\\v.wav')
    expect(body).toContain('- 앱 버전: 0.1.0')
    expect(body).toContain('- OS: win32 x64')
    expect(body).not.toContain('mingyu')
  })
})

describe('buildIssueUrl', () => {
  it('새 이슈 URL에 title/body 쿼리를 붙인다', () => {
    const url = new URL(buildIssueUrl([error()], info))
    expect(`${url.origin}${url.pathname}`).toBe(ISSUES_NEW_URL)
    expect(url.searchParams.get('title')).toBe('[보컬 분리] sidecar exited with code 1')
    expect(url.searchParams.get('body')).toContain('## 오류 기록')
  })

  it('길이 상한을 넘기면 뒤쪽 오류부터 떨어뜨린다', () => {
    const many = Array.from({ length: 60 }, (_, i) =>
      error({ message: `error number ${i} ${'y'.repeat(150)}` })
    )
    const url = buildIssueUrl(many, info)
    expect(url.length).toBeLessThanOrEqual(7000)
    const body = new URL(url).searchParams.get('body')!
    expect(body).toContain('error number 0 ')
    expect(body).not.toContain('error number 59 ')
  })

  it('오류가 없으면 던진다', () => {
    expect(() => buildIssueUrl([], info)).toThrow()
  })
})
