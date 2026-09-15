/**
 * 유지보수자용: gather 산출물 + uv.lock 으로 committed lock 을 생성한다.
 * 일반 verify/build 는 이 파일을 호출하지 않는다.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { selectRuntimeWheels, uvLockDigestFromFile } from './wheels.mjs'

const rootPath = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const gather = join(tmpdir(), 'karaoke-lock-gather')
const outDir = join(rootPath, 'build', 'locks')

function json(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

const uvInv = json(join(gather, 'uv-x-inventory.json'))
const denoInv = json(join(gather, 'deno-x-inventory.json'))
const pyInv = json(join(gather, 'python-x-inventory.json'))
const uvLockPath = join(rootPath, 'sidecar', 'uv.lock')
const wheelsSel = selectRuntimeWheels(readFileSync(uvLockPath, 'utf8'))
const uvLockDigest = uvLockDigestFromFile(uvLockPath)

const TORCH_SIZES = {
  'torch==2.8.0+cu128': 3461384651,
  'torchaudio==2.8.0+cu128': 4673203
}

const tools = {
  schemaVersion: 1,
  kind: 'tools',
  platform: 'win32-x64',
  artifacts: [
    {
      id: 'uv',
      kind: 'archive',
      version: '0.12.9',
      revision: null,
      platform: 'win32-x64',
      url: 'https://github.com/astral-sh/uv/releases/download/0.12.9/uv-x86_64-pc-windows-msvc.zip',
      size: 16895034,
      sha256: 'ddbfcee1ac615a0499f6aa97b5ec8ebdf3ee4a7714a48055ec2ba0030e3cf810',
      dest: 'resources/bin/uv.exe',
      source: 'github.com/astral-sh/uv',
      license: 'MIT OR Apache-2.0',
      capability: 'always',
      archive: {
        format: 'zip',
        files: uvInv.map((f) => ({
          path: f.path.replaceAll('\\', '/'),
          size: f.size,
          sha256: f.sha256,
          executable: true,
          dest: `resources/bin/${f.path.replaceAll('\\', '/')}`
        }))
      }
    },
    {
      id: 'yt-dlp',
      kind: 'file',
      version: '2026.08.19',
      revision: null,
      platform: 'win32-x64',
      url: 'https://github.com/yt-dlp/yt-dlp/releases/download/2026.08.19/yt-dlp.exe',
      size: 17840399,
      sha256: '66674953fe251b89f4d08c5f0e35e0728679bd67ab3d7d05c0562af101dd3e7a',
      dest: 'resources/bin/yt-dlp.exe',
      source: 'github.com/yt-dlp/yt-dlp',
      license: 'Unlicense',
      capability: 'zip-url-import'
    },
    {
      id: 'deno',
      kind: 'archive',
      version: '2.9.6',
      revision: null,
      platform: 'win32-x64',
      url: 'https://github.com/denoland/deno/releases/download/v2.9.6/deno-x86_64-pc-windows-msvc.zip',
      size: 42601047,
      sha256: '15e5300b0ba3c3695a7621d90160a746ec9e710228cee639afa9d580f6e3cd11',
      dest: 'resources/bin/deno.exe',
      source: 'github.com/denoland/deno',
      license: 'MIT',
      capability: 'always',
      archive: {
        format: 'zip',
        files: denoInv.map((f) => ({
          path: f.path.replaceAll('\\', '/'),
          size: f.size,
          sha256: f.sha256,
          executable: true,
          dest: `resources/bin/${f.path.replaceAll('\\', '/')}`
        }))
      }
    }
  ]
}

const pyPrefix = 'runtimes/cpython-3.12.14+20260901'
const python = {
  schemaVersion: 1,
  kind: 'python',
  platform: 'win32-x64',
  python: {
    requiresMajorMinor: '3.12',
    implementation: 'cpython',
    patch: '3.12.14',
    distributionBuild: '20260901',
    distribution: 'python-build-standalone',
    flavor: 'install_only_stripped'
  },
  artifacts: [
    {
      id: 'cpython',
      kind: 'archive',
      version: '3.12.14+20260901',
      revision: null,
      platform: 'win32-x64',
      url: 'https://github.com/astral-sh/python-build-standalone/releases/download/20260901/cpython-3.12.14%2B20260901-x86_64-pc-windows-msvc-install_only_stripped.tar.gz',
      size: 21980728,
      sha256: '7c45c9622400d578709a9b2cddbe8124cc21d382409d9f13406d706d28e31b14',
      dest: `${pyPrefix}/python/python.exe`,
      source: 'github.com/astral-sh/python-build-standalone',
      license: 'PSF-2.0',
      capability: 'always',
      archive: {
        format: 'tar.gz',
        files: pyInv.map((f) => {
          const path = f.path.replaceAll('\\', '/')
          return {
            path,
            size: f.size,
            sha256: f.sha256,
            executable: /\.(exe|dll|pyd)$/i.test(path),
            dest: `${pyPrefix}/${path}`
          }
        })
      }
    }
  ]
}

const WHISPER_REV = '0a363e9161cbc7ed1431c9597a8ceaf0c4f78fcf'
const WHISPER_REPO = 'mobiuslabsgmbh/faster-whisper-large-v3-turbo'
const whisperFiles = [
  {
    id: 'whisper-large-v3-turbo-config',
    file: 'config.json',
    size: 2263,
    sha256: 'b0253ea6c0d3bea6b1e19e91a02acfd3b53f4467362efcb5a3e6b16c9b3a9b7e'
  },
  {
    id: 'whisper-large-v3-turbo-preprocessor',
    file: 'preprocessor_config.json',
    size: 340,
    sha256: '7ccc62c6f2765af1f3b46c00c9b5894426835a05021c8b9c01eecb6dfb542711'
  },
  {
    id: 'whisper-large-v3-turbo-tokenizer',
    file: 'tokenizer.json',
    size: 2710337,
    sha256: '297b13372ac43916285644fb9687add3cc62ee2a1adb60da3dc25cc94c1871fd'
  },
  {
    id: 'whisper-large-v3-turbo-vocabulary',
    file: 'vocabulary.json',
    size: 1068114,
    sha256: 'c69260f2ab26d659b7c398f9a2b2b48ed0df16c3b47d7326782fd9cba71690c1'
  },
  {
    id: 'whisper-large-v3-turbo-model',
    file: 'model.bin',
    size: 1617884929,
    sha256: 'e76620f83d5f5b69efd3d87e3dc180c1bd21df9fbebacfd4335e5e1efcc018da'
  }
]

function hfArtifact(row) {
  return {
    id: row.id,
    kind: 'file',
    version: 'large-v3-turbo',
    revision: WHISPER_REV,
    platform: 'win32-x64',
    url: `https://huggingface.co/${WHISPER_REPO}/resolve/${WHISPER_REV}/${row.file}`,
    size: row.size,
    sha256: row.sha256,
    dest: `models/whisper-large-v3-turbo/${row.file}`,
    source: `huggingface.co/${WHISPER_REPO}`,
    license: 'MIT'
  }
}

const DEMUCS = [
  {
    id: 'htdemucs',
    file: '955717e8-8726e21a.th',
    root: 'hybrid_transformer',
    size: 84141911,
    sha256: '8726e21a993978c7ba086d3872e7608d7d5bfca646ca4aca459ffda844faa8b4'
  },
  {
    id: 'htdemucs_ft.0',
    file: 'f7e0c4bc-ba3fe64a.th',
    root: 'hybrid_transformer',
    size: 84141271,
    sha256: 'ba3fe64ae8ef66ac9a4857222ce48efbdc5eb3ad375cb79dd13debee5aaa4066'
  },
  {
    id: 'htdemucs_ft.1',
    file: 'd12395a8-e57c48e6.th',
    root: 'hybrid_transformer',
    size: 84141271,
    sha256: 'e57c48e6b0e38af4f7118d7bd08c49f0a0c0edf7d09143bdd902ea0d237303e6'
  },
  {
    id: 'htdemucs_ft.2',
    file: '92cfc3b6-ef3bcb9c.th',
    root: 'hybrid_transformer',
    size: 84141271,
    sha256: 'ef3bcb9c8b40d14ae5d51b6db2587339cc12c6b77c0be151ce6d69002e087bf2'
  },
  {
    id: 'htdemucs_ft.3',
    file: '04573f0d-f3cf25b2.th',
    root: 'hybrid_transformer',
    size: 84141271,
    sha256: 'f3cf25b222c4eed7cd49dd8b2c9597d50c18bd154090f7b919cfa5f93cf22c49'
  },
  {
    id: 'hdemucs_mmi',
    file: '75fc33f5-1941ce65.th',
    root: 'hybrid_transformer',
    size: 167407275,
    sha256: '1941ce654b11df4132b9f4eae408556b4c83fad6fe26b4bc0dbcb36b975befb3'
  },
  {
    id: 'mdx_extra.0',
    file: 'e51eebcc-c1b80bdd.th',
    root: 'mdx_final',
    size: 167399275,
    sha256: 'c1b80bdd6de58274abf359e66822a76f49ce2b9f086fc5dc917ac14598e6bebf'
  },
  {
    id: 'mdx_extra.1',
    file: 'a1d90b5c-ae9d2452.th',
    root: 'mdx_final',
    size: 167391595,
    sha256: 'ae9d245283bf24b552913ee233a1101dcd0aeaed59b1c0a2da0e1f6eda15101b'
  },
  {
    id: 'mdx_extra.2',
    file: '5d2d6c55-db83574e.th',
    root: 'mdx_final',
    size: 167391595,
    sha256: 'db83574e05b2308f76e2764819da673f2d16d437b9e619f5fcb72f275fc0e24f'
  },
  {
    id: 'mdx_extra.3',
    file: 'cfa93e08-61801ae1.th',
    root: 'mdx_final',
    size: 167399275,
    sha256: '61801ae1567d606c97a9c3469e943ae306d0a873eeb60d623ae7cfc7042b3f68'
  },
  {
    id: 'mdx_extra_q.0',
    file: '83fc094f-4a16d450.th',
    root: 'mdx_final',
    size: 50756993,
    sha256: '4a16d450fd8c9277494e23865cadaa4a3e64141c45411d84243b8c95ea4b7cae'
  },
  {
    id: 'mdx_extra_q.1',
    file: '464b36d7-e5a9386e.th',
    root: 'mdx_final',
    size: 38893153,
    sha256: 'e5a9386ecbf6f30bb2bdc7ae162f471d87f3b5bffba1a8cb2cebe4403280967e'
  },
  {
    id: 'mdx_extra_q.2',
    file: '14fc6a69-a89dd0ee.th',
    root: 'mdx_final',
    size: 38491885,
    sha256: 'a89dd0eeb547221dcfd6c0a47baa768ce0bce548eaf86b9a404d6b1088b5d22f'
  },
  {
    id: 'mdx_extra_q.3',
    file: '7fd6ef75-a905dd85.th',
    root: 'mdx_final',
    size: 39436529,
    sha256: 'a905dd8548f7389f1a3686c24c09d7bee61b716e3372e778e2acec88333ecdf4'
  }
]

function demucsArtifact(row) {
  return {
    id: row.id,
    kind: 'file',
    version: row.file.replace(/\.th$/, ''),
    revision: null,
    platform: 'win32-x64',
    url: `https://dl.fbaipublicfiles.com/demucs/${row.root}/${row.file}`,
    size: row.size,
    sha256: row.sha256,
    dest: `models/demucs/${row.file}`,
    source: 'dl.fbaipublicfiles.com/demucs',
    license: 'MIT'
  }
}

const models = {
  schemaVersion: 1,
  kind: 'models',
  platform: 'win32-x64',
  artifacts: [
    ...whisperFiles.map(hfArtifact),
    ...DEMUCS.map(demucsArtifact),
    {
      id: 'mms-fa-model',
      kind: 'file',
      version: 'mms-fa',
      revision: null,
      platform: 'win32-x64',
      url: 'https://dl.fbaipublicfiles.com/mms/torchaudio/ctc_alignment_mling_uroman/model.pt',
      size: 1262047414,
      sha256: '20ef12963ab4924bef49ac4fc7f58ad5da2ee43b2c11bc8c853c9b90ecdbc680',
      dest: 'models/mms-fa/model.pt',
      source: 'dl.fbaipublicfiles.com/mms',
      license: 'CC-BY-NC-4.0'
    },
    {
      id: 'beat-this-final0',
      kind: 'file',
      version: 'final0',
      revision: null,
      platform: 'win32-x64',
      url: 'https://cloud.cp.jku.at/public.php/dav/files/7ik4RrBKTS273gp/final0.ckpt',
      size: 81058141,
      sha256: '8c328b45f59d8dd3dff219253ff6a8d6482be57d0133a29140e2febbf8eb8331',
      dest: 'models/beat-this/final0.ckpt',
      source: 'cloud.cp.jku.at/beat_this',
      license: 'MIT'
    }
  ],
  models: [
    {
      id: 'htdemucs',
      loader: 'demucs.api.Separator',
      loaderBinding: { package: 'demucs', symbol: 'Separator', argument: 'model' },
      revision: '955717e8-8726e21a',
      license: 'MIT',
      artifactIds: ['htdemucs'],
      dependsOn: [],
      configSource: 'wheel:demucs:remote/htdemucs.yaml'
    },
    {
      id: 'htdemucs_ft',
      loader: 'demucs.api.Separator',
      loaderBinding: { package: 'demucs', symbol: 'Separator', argument: 'model' },
      revision: 'bag:f7e0c4bc,d12395a8,92cfc3b6,04573f0d',
      license: 'MIT',
      artifactIds: ['htdemucs_ft.0', 'htdemucs_ft.1', 'htdemucs_ft.2', 'htdemucs_ft.3'],
      dependsOn: ['htdemucs_ft.0', 'htdemucs_ft.1', 'htdemucs_ft.2', 'htdemucs_ft.3'],
      configSource: 'wheel:demucs:remote/htdemucs_ft.yaml'
    },
    {
      id: 'hdemucs_mmi',
      loader: 'demucs.api.Separator',
      loaderBinding: { package: 'demucs', symbol: 'Separator', argument: 'model' },
      revision: '75fc33f5-1941ce65',
      license: 'MIT',
      artifactIds: ['hdemucs_mmi'],
      dependsOn: [],
      configSource: 'wheel:demucs:remote/hdemucs_mmi.yaml'
    },
    {
      id: 'mdx_extra',
      loader: 'demucs.api.Separator',
      loaderBinding: { package: 'demucs', symbol: 'Separator', argument: 'model' },
      revision: 'bag:e51eebcc,a1d90b5c,5d2d6c55,cfa93e08',
      license: 'MIT',
      artifactIds: ['mdx_extra.0', 'mdx_extra.1', 'mdx_extra.2', 'mdx_extra.3'],
      dependsOn: ['mdx_extra.0', 'mdx_extra.1', 'mdx_extra.2', 'mdx_extra.3'],
      configSource: 'wheel:demucs:remote/mdx_extra.yaml'
    },
    {
      id: 'mdx_extra_q',
      loader: 'demucs.api.Separator',
      loaderBinding: { package: 'demucs', symbol: 'Separator', argument: 'model' },
      revision: 'bag:83fc094f,464b36d7,14fc6a69,7fd6ef75',
      license: 'MIT',
      artifactIds: ['mdx_extra_q.0', 'mdx_extra_q.1', 'mdx_extra_q.2', 'mdx_extra_q.3'],
      dependsOn: ['mdx_extra_q.0', 'mdx_extra_q.1', 'mdx_extra_q.2', 'mdx_extra_q.3'],
      configSource: 'wheel:demucs:remote/mdx_extra_q.yaml'
    },
    {
      id: 'large-v3-turbo',
      loader: 'faster_whisper.WhisperModel',
      loaderBinding: { package: 'faster_whisper', symbol: 'WhisperModel' },
      revision: WHISPER_REV,
      repo: WHISPER_REPO,
      license: 'MIT',
      artifactIds: whisperFiles.map((f) => f.id),
      dependsOn: [],
      vadAsset: 'wheel:faster-whisper:assets/silero_vad_v6.onnx'
    },
    {
      id: 'mms-fa',
      loader: 'torchaudio.pipelines.MMS_FA',
      loaderBinding: { package: 'torchaudio.pipelines', symbol: 'MMS_FA' },
      revision: null,
      license: 'CC-BY-NC-4.0',
      artifactIds: ['mms-fa-model'],
      dependsOn: [],
      dictionarySource: 'torchaudio.pipelines.MMS_FA.get_dict'
    },
    {
      id: 'beat-this-final0',
      loader: 'beat_this.inference.Audio2Beats',
      loaderBinding: {
        package: 'beat_this.inference',
        symbol: 'Audio2Beats',
        argument: 'checkpoint_path'
      },
      revision: null,
      license: 'MIT',
      artifactIds: ['beat-this-final0'],
      dependsOn: []
    }
  ]
}

const LICENSE = {
  torch: 'BSD-3-Clause',
  torchaudio: 'BSD-2-Clause',
  numpy: 'BSD-3-Clause',
  demucs: 'MIT',
  'faster-whisper': 'MIT',
  'beat-this': 'MIT',
  'huggingface-hub': 'Apache-2.0',
  certifi: 'MPL-2.0',
  av: 'BSD-3-Clause',
  ctranslate2: 'MIT',
  onnxruntime: 'MIT',
  setuptools: 'MIT'
}

const wheels = {
  schemaVersion: 1,
  kind: 'wheels',
  platform: 'win32-x64',
  uvLockDigest,
  python: { requiresMajorMinor: '3.12', implementation: 'cpython' },
  buildSystem: {
    backend: 'hatchling.build',
    requires: [
      {
        id: 'hatchling',
        kind: 'wheel',
        version: '1.32.0',
        platform: 'win32-x64',
        url: 'https://files.pythonhosted.org/packages/a9/84/1798b6d85ecde0e31546004efd25c5de1a1ef72676f4b252ce6ea266a03a/hatchling-1.32.0-py3-none-any.whl',
        size: 78435,
        sha256: '0e17c9c3b9aa7c625acc8d0f5b622f107d5049af9ecf5ada4de1aada5be7cdbc',
        dest: 'wheels/hatchling-1.32.0-py3-none-any.whl',
        source: 'files.pythonhosted.org',
        license: 'MIT',
        wheelTag: 'py3-none-any',
        userPcBuild: false
      }
    ],
    note: 'sidecar wheel is built in a controlled environment; user PCs must not build sdists'
  },
  localBuilds: [
    {
      id: 'karaoke-worker',
      kind: 'sdist-build',
      version: '0.1.0',
      sourcePath: 'sidecar/',
      backend: 'hatchling.build',
      buildEnvironment: 'controlled',
      userPcBuild: false
    }
  ],
  artifacts: wheelsSel.artifacts.map((a) => ({
    ...a,
    size: a.size ?? TORCH_SIZES[`${a.id}==${a.version}`] ?? a.size,
    license: LICENSE[a.id] ?? 'see-upstream'
  }))
}

const provenance = {
  tools: {
    uv: {
      source:
        'https://github.com/astral-sh/uv/releases/download/0.12.9/uv-x86_64-pc-windows-msvc.zip.sha256',
      archiveSha256: 'ddbfcee1ac615a0499f6aa97b5ec8ebdf3ee4a7714a48055ec2ba0030e3cf810',
      innerFiles: 'maintainer-verified extract of the official zip'
    },
    'yt-dlp': {
      source: 'https://github.com/yt-dlp/yt-dlp/releases/download/2026.08.19/SHA2-256SUMS',
      line: '66674953fe251b89f4d08c5f0e35e0728679bd67ab3d7d05c0562af101dd3e7a  yt-dlp.exe'
    },
    deno: {
      source:
        'https://github.com/denoland/deno/releases/download/v2.9.6/deno-x86_64-pc-windows-msvc.zip.sha256sum',
      archiveSha256: '15e5300b0ba3c3695a7621d90160a746ec9e710228cee639afa9d580f6e3cd11'
    }
  },
  python: {
    source:
      'uv 0.12.9 crates/uv-python/download-metadata.json key cpython-3.12.14-windows-x86_64-none',
    sha256: '7c45c9622400d578709a9b2cddbe8124cc21d382409d9f13406d706d28e31b14',
    innerFiles: 'maintainer-verified extract of install_only_stripped tar.gz'
  },
  wheels: {
    source:
      'sidecar/uv.lock hashes/urls; torch/torchaudio size from HEAD Content-Length of download-r2.pytorch.org',
    uvLockDigest
  },
  models: {
    whisper: {
      repo: WHISPER_REPO,
      revision: WHISPER_REV,
      modelBin: 'Hugging Face tree API lfs.oid (sha256)',
      sidecarFiles: 'downloaded resolve/<sha> and hashed locally'
    },
    'beat-this': {
      url: 'https://cloud.cp.jku.at/public.php/dav/files/7ik4RrBKTS273gp/final0.ckpt',
      method: 'maintainer-verified download SHA-256'
    },
    demucs: {
      urls: 'https://dl.fbaipublicfiles.com/demucs from facebookresearch/demucs remote/files.txt',
      method:
        'maintainer-verified download of locked HTTPS URL; Content-Length and actual bytes matched locked size; SHA-256 of complete response body'
    },
    'mms-fa': {
      url: 'https://dl.fbaipublicfiles.com/mms/torchaudio/ctc_alignment_mling_uroman/model.pt',
      method: 'stream SHA-256 of existing local torch-hub file; size matched lock (1262047414)',
      sha256: '20ef12963ab4924bef49ac4fc7f58ad5da2ee43b2c11bc8c853c9b90ecdbc680'
    }
  }
}

mkdirSync(outDir, { recursive: true })
writeFileSync(join(outDir, 'tools.lock.json'), JSON.stringify(tools, null, 2) + '\n')
writeFileSync(join(outDir, 'python.lock.json'), JSON.stringify(python, null, 2) + '\n')
writeFileSync(join(outDir, 'models.lock.json'), JSON.stringify(models, null, 2) + '\n')
writeFileSync(join(outDir, 'wheels.lock.json'), JSON.stringify(wheels, null, 2) + '\n')
writeFileSync(
  join(outDir, 'tools.provenance.json'),
  JSON.stringify(provenance.tools, null, 2) + '\n'
)
writeFileSync(
  join(outDir, 'python.provenance.json'),
  JSON.stringify(provenance.python, null, 2) + '\n'
)
writeFileSync(
  join(outDir, 'wheels.provenance.json'),
  JSON.stringify(provenance.wheels, null, 2) + '\n'
)
writeFileSync(
  join(outDir, 'models.provenance.json'),
  JSON.stringify(provenance.models, null, 2) + '\n'
)
console.log('wrote', outDir)
console.log('python members', python.artifacts[0].archive.files.length)
console.log('wheels', wheels.artifacts.length)
