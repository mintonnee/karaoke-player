import {
  ERROR_CODES,
  LockError,
  isMutableRevision,
  validateArtifactShape,
  validateLockShape,
  type Artifact,
  type LockKind
} from './schema'
import { assertAllowedUrl, isHuggingFaceUrl } from './hosts'

export function validateArtifactRuntime(artifact: Artifact, lockKind: string): LockError[] {
  const errors: LockError[] = []
  if (artifact.url) {
    try {
      assertAllowedUrl(artifact.url, { id: artifact.id })
    } catch (err) {
      if (err instanceof LockError) errors.push(err)
      else throw err
    }
    if (isHuggingFaceUrl(artifact.url)) {
      if (isMutableRevision(artifact.revision, { requireGitSha: true })) {
        errors.push(
          new LockError(
            ERROR_CODES.MUTABLE_REVISION,
            `HF artifact requires immutable git SHA: ${artifact.id}`,
            { id: artifact.id }
          )
        )
      }
    }
  }
  if (
    lockKind === 'models' &&
    artifact.revision &&
    isMutableRevision(artifact.revision, { requireGitSha: true })
  ) {
    errors.push(
      new LockError(ERROR_CODES.MUTABLE_REVISION, `mutable revision: ${artifact.revision}`, {
        id: artifact.id
      })
    )
  }
  return errors
}

export interface ParityFixture {
  lock?: unknown
  entry?: unknown
  expected: { accept: boolean; reasonCode?: string }
}

/** L1 parity.test.mjs 와 동일한 수락/거부 평가. */
export function evaluateParityFixture(data: ParityFixture): LockError[] {
  if (data.lock) return validateLockShape(data.lock)
  const shape = validateArtifactShape(data.entry)
  const runtime = validateArtifactRuntime(data.entry as Artifact, 'models' satisfies LockKind)
  return [...shape, ...runtime]
}
