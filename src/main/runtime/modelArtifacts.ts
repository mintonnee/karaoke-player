import type { Artifact, LockFile } from './schema'

/** Model bindings and artifact IDs occupy separate namespaces, even when names match. */
export function artifactsForModel(models: LockFile, modelId: string): Artifact[] {
  const bindings = new Map((models.models ?? []).map((binding) => [binding.id, binding]))
  const artifacts = new Map(models.artifacts.map((artifact) => [artifact.id, artifact]))
  const seenModels = new Set<string>()
  const out = new Map<string, Artifact>()
  const addArtifact = (id: string): void => {
    const artifact = artifacts.get(id)
    if (!artifact) throw new Error(`unregistered artifact id: ${id}`)
    out.set(id, artifact)
  }
  const visit = (id: string): void => {
    const binding = bindings.get(id)
    if (!binding) {
      addArtifact(id)
      return
    }
    if (seenModels.has(id)) return
    seenModels.add(id)
    for (const artifactId of binding.artifactIds) addArtifact(artifactId)
    for (const dep of binding.dependsOn) visit(dep)
  }
  visit(modelId)
  return [...out.values()]
}
