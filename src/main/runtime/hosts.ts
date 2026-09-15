import { ERROR_CODES, LockError } from './schema'

/** 이 슬라이스가 실제로 쓰는 HTTPS 호스트만 허용한다. */
export const ALLOWED_HOSTS = Object.freeze(
  new Set([
    'github.com',
    'objects.githubusercontent.com',
    'release-assets.githubusercontent.com',
    'github-releases.githubusercontent.com',
    'files.pythonhosted.org',
    'huggingface.co',
    'cas-bridge.xethub.hf.co',
    'cdn-lfs.huggingface.co',
    'download.pytorch.org',
    'download-r2.pytorch.org',
    'dl.fbaipublicfiles.com',
    'cloud.cp.jku.at'
  ])
)

export function redactUrl(url: string): string {
  try {
    const parsed = new URL(url)
    parsed.search = ''
    parsed.hash = ''
    parsed.username = ''
    parsed.password = ''
    return parsed.toString()
  } catch {
    return '<invalid-url>'
  }
}

export function parseHttpsUrl(url: string): { host: string; url: URL } {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new LockError(ERROR_CODES.DISALLOWED_HOST, `invalid url: ${redactUrl(url)}`)
  }
  if (parsed.protocol !== 'https:') {
    throw new LockError(ERROR_CODES.DISALLOWED_HOST, `non-HTTPS url: ${redactUrl(url)}`, {
      path: parsed.hostname
    })
  }
  return { host: parsed.hostname.toLowerCase(), url: parsed }
}

export function assertAllowedUrl(url: string, details: { id?: string } = {}): string {
  const { host } = parseHttpsUrl(url)
  if (!ALLOWED_HOSTS.has(host)) {
    throw new LockError(ERROR_CODES.DISALLOWED_HOST, `disallowed host: ${host}`, {
      id: details.id,
      path: host
    })
  }
  return host
}

export function isHuggingFaceUrl(url: string): boolean {
  try {
    const { host } = parseHttpsUrl(url)
    return host === 'huggingface.co' || host.endsWith('.huggingface.co') || host.endsWith('.hf.co')
  } catch {
    return false
  }
}
