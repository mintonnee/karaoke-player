/**
 * 오류 센터 → GitHub 이슈 링크. 새 이슈 페이지의 title/body 쿼리로 내용을 미리 채운다.
 * 순수 함수라 메인/렌더러 어디서든 쓰고 테스트할 수 있다.
 */
import type { AppErrorReport, AppInfo } from './types'

export const ISSUES_NEW_URL = 'https://github.com/plan12be/karaoke-player/issues/new'

/** 브라우저·GitHub가 안전하게 받는 URL 길이. 넘치면 본문을 자른다 */
const MAX_URL_LENGTH = 7000
const MAX_TITLE_LENGTH = 80

const SOURCE_LABEL: Record<AppErrorReport['source'], string> = {
  import: '가져오기',
  separate: '보컬 분리',
  analyze: 'BPM·키 분석',
  lyrics: '가사',
  player: '재생',
  jobs: '작업 큐',
  'url-import': 'URL 가져오기'
}

export function sourceLabel(source: AppErrorReport['source']): string {
  return SOURCE_LABEL[source]
}

/** 한 줄 요약. 개행은 공백으로, 길면 말줄임 */
function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

/** 사용자 홈 경로 등 개인 식별 정보를 지운다 (C:\Users\name\..., /home/name/...) */
export function redactPaths(text: string): string {
  return text
    .replace(/[A-Za-z]:\\Users\\[^\\\s]+/g, '<home>')
    .replace(/\/(?:home|Users)\/[^/\s]+/g, '<home>')
}

export function buildIssueTitle(error: AppErrorReport): string {
  return oneLine(`[${sourceLabel(error.source)}] ${redactPaths(error.message)}`, MAX_TITLE_LENGTH)
}

export function buildIssueBody(errors: AppErrorReport[], info: AppInfo): string {
  const lines = [
    '## 증상',
    '',
    '<!-- 무엇을 하다가 어떤 문제가 생겼는지 적어 주세요 -->',
    '',
    '## 오류 기록',
    '',
    ...errors.map(
      (error) =>
        `- \`${error.at}\` **${sourceLabel(error.source)}** — ${redactPaths(error.message)}`
    ),
    '',
    '## 환경',
    '',
    `- 앱 버전: ${info.version}`,
    `- OS: ${info.platform} ${info.arch}`,
    `- Electron: ${info.electron}`
  ]
  return lines.join('\n')
}

/**
 * 새 이슈 URL. 길이 상한을 넘기면 오류 기록을 뒤에서부터 줄여 맞춘다.
 * 가장 오래된 항목이 아니라 목록 끝부터 잘리므로 errors는 중요한 순으로 넘긴다.
 */
export function buildIssueUrl(errors: AppErrorReport[], info: AppInfo): string {
  if (errors.length === 0) throw new Error('no errors to report')
  const title = buildIssueTitle(errors[0])
  let kept = errors
  for (;;) {
    const params = new URLSearchParams({ title, body: buildIssueBody(kept, info) })
    const url = `${ISSUES_NEW_URL}?${params.toString()}`
    if (url.length <= MAX_URL_LENGTH || kept.length <= 1) return url
    kept = kept.slice(0, -1)
  }
}
