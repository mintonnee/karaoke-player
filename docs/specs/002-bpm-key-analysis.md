# Karaoke Player BPM·키 분석 표시 스펙

- 작성일: 2026-09-02
- 연관 스펙: `000-karaoke-app-spec-draft.md`
- 대상: 000 §2 목표에 2026-09-02 추가된 "BPM·키 표시", 000 §4.2 사이드카 명령 `analyze`, 000 §5 S6(키 변경)의 UI 확장

이 문서는 000에서 다루지 않던 곡 분석 정보(BPM, 조성)를 분리 파이프라인 뒤에 자동으로 추출해 라이브러리와 트랜스포트에 표시하고, 키 변경(±6 반음)과 결합해 "원키 → 현재 키"를 보여 주는 범위를 다룬다. 템포 변경, 비트 그리드 기반 루프, 채점·음역대 추천은 다루지 않는다.

## 1. 목표와 비목표

```text
곡을 임포트해 분리가 끝나면 라이브러리 행에 "128 BPM · C#m"이 자동으로 표시되고,
재생 중 키를 +2 올리면 트랜스포트에 "C#m → D#m"이 보인다.
```

**목표**

| 영역            | 내용                                                                                                                                                         |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 사이드카 분석   | `analyze` 명령 추가. 반주 스템(`inst.wav`)에서 BPM과 조성(으뜸음 + 장/단조)을 추정하고 각각 신뢰도(0–1)를 함께 반환한다                                      |
| 파이프라인 연결 | 분리 성공 직후 같은 JobQueue에서 분석을 실행한다. 분석 실패는 트랙 상태(`ready`)에 영향을 주지 않는다. 기존 `ready` 트랙은 앱 시작 시 백필한다               |
| 저장            | `tracks` 스키마 v3: `bpm`, `music_key`, `bpm_conf`, `key_conf`, `analysis_version`, `analysis_source` 컬럼 추가. SQLite가 유일한 source of truth             |
| 표시            | 라이브러리 행 메타 줄과 트랜스포트 키 컨트롤에 표시. 신뢰도가 임계값 미만이면 `?` 접미로 불확실함을 드러낸다                                                 |
| 변조 키 계산    | 렌더러 공용 헬퍼로 원키에 현재 `pitch`(반음)를 더한 키를 계산한다. `pitch === 0`이면 원키만, 아니면 "원키 → 현재 키"                                         |
| 사용자 수정     | 메타 편집 폼에 BPM·키 입력을 추가한다. 사용자가 입력한 값은 `analysis_source='user'`로 저장돼 백필·재분석이 덮어쓰지 않는다                                  |
| 의존성          | BPM은 `beat-this`(PyPI, MIT)를 런타임 의존성으로 추가해 사용한다. 키는 numpy·torch(이미 설치됨)만으로 자체 구현한다. 그 외 분석 라이브러리는 추가하지 않는다 |

**비목표**

| 항목                                            | 제외 이유                                                                                                                                                                                                                     |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 템포(속도) 변경                                 | 000 §2 "템포는 v1 범위 밖" 결정 유지. BPM은 표시 전용                                                                                                                                                                         |
| 비트 그리드·마디 단위 루프 스냅                 | 후속 스펙. Beat This!가 비트·다운비트 시각을 내놓으므로 도입 비용은 낮지만, 이 스펙은 BPM 숫자만 저장하고 비트 배열은 저장하지 않는다. 필요가 확인되면 스키마 확장과 함께 결정한다                                            |
| librosa / madmom / essentia 도입                | 현재 venv에 scipy·numba가 없다(`sidecar/.venv` 확인). librosa는 numba 의존으로 numpy 2.5.2 고정과 해석 충돌 위험, madmom은 유지보수 중단, essentia는 Windows 휠 불안정. 000 §7 MMS_FA 결정과 같은 원칙(빌드·해석 리스크 회피) |
| Beat This! DBN 후처리(`dbn=True`)               | madmom 의존이라 위와 같은 이유로 쓰지 않는다. 기본 후처리로 충분                                                                                                                                                              |
| 키 검출에 외부 모델 사용                        | 크로마 템플릿 방식이 50줄 안팎으로 끝나고 의존성이 없다. 상대조 혼동은 변조 반음 수에 영향이 없어 노래방 용도에서 실질 손해가 작다                                                                                            |
| 체크포인트 동봉                                 | 001 "모델 미동봉" 결정을 따라 첫 사용 시 내려받는다. 다운로드 출처가 연구실 서버라 실패가 관측되면 `small0`(약 8 MB) 동봉을 별도 결정으로 재검토한다                                                                          |
| 코드(화음) 진행 검출                            | 노래방 핵심 가치와 무관. 조성 하나로 충분                                                                                                                                                                                     |
| 보컬 멜로디 기반 원키·음역대 추정, 성별 키 추천 | v2 채점(000 S9)의 피치 곡선 추출과 함께 설계. 지금 넣으면 v2와 중복                                                                                                                                                           |
| BPM·키 기준 라이브러리 정렬/필터                | 표시가 먼저. 필요가 확인되면 후속                                                                                                                                                                                             |
| `meta.json`에 분석 결과 기록                    | 이중 기록은 불일치만 만든다. SQLite 컬럼만 쓴다                                                                                                                                                                               |
| 분석 결과의 단어/줄 가사 정렬 활용              | 정렬은 MMS_FA가 담당(000 §4.4). 결합 근거 없음                                                                                                                                                                                |

**결정 기록**

- BPM은 Beat This!(`beat-this>=1.1`, ISMIR 2024 비트 트래커)로 검출한다 (2026-09-02, 사용자 결정). 자기상관 방식의 절반·두 배 템포 오류를 피하기 위함이다. 처음 검토 때는 PyPI 미등록으로 알았으나 1.1.0(2026-04-14)이 순수 Python 휠로 배포돼 있고 의존성(numpy, torch, torchaudio, einops, rotary-embedding-torch, soxr)이 모두 프리빌트라 빌드 리스크가 없다. 체크포인트는 `final0`(약 78 MB) 고정.
- 키는 외부 모델 없이 크로마 + Krumhansl–Kessler 템플릿으로 자체 구현한다. Beat This!는 조성을 내놓지 않는다.
- BPM 단계와 키 단계는 서로 독립이다. 한쪽이 실패(체크포인트 다운로드 실패 등)해도 다른 값은 반환하고, 실패 사유는 stderr에만 남긴다.
- 분석 입력은 원본이 아니라 `inst.wav`다. 보컬이 빠진 신호에서 온셋(드럼)이 또렷해 템포 추정이 안정적이고, 화성 정보는 반주에 그대로 남아 조성 추정에도 충분하다. 파일 하나만 읽어 두 값을 뽑는다.
- 조성 표기는 샤프 통일 12음(`C C# D D# E F F# G G# A A# B`) + 단조는 `m` 접미(예: `C#m`). 이명동음(Db 등)을 쓰지 않는다 — 변조 계산이 정수 덧셈으로 끝나고, 노래방 기기 표기와 같다.
- 신뢰도는 "1위 후보와 2위 후보의 격차"를 0–1로 정규화한 값이다. 임계값은 상수(`ANALYSIS_LOW_CONF`, 초기값 0.3)로 두고 §5 실곡 검증에서 보정한다.
- 알고리즘 버전(`ANALYSIS_VERSION`, 정수)을 결과와 함께 저장한다. 알고리즘을 바꾸면 버전을 올리고, 백필이 `analysis_version < ANALYSIS_VERSION AND analysis_source != 'user'`인 트랙을 다시 분석한다.

## 2. 성공 기준

1. 합성 신호(120 BPM 클릭 + C 장조 3화음 패드, 30초, 44.1 kHz)로 `karaoke_worker analyze`를 실행하면 `done.result`에 `bpm`이 119–121 범위, `key === "C"`, `bpm_conf`·`key_conf`가 0–1 범위로 나오고 exit 0이다. A 단조 화음(A–C–E 지속)으로 바꾸면 `key === "Am"`이다. 이 검증은 `sidecar/tests/test_analyze.py`가 자동으로 수행한다. 키 부분은 순수 함수 단위 테스트로도 커버해 체크포인트 없이 통과한다.
2. 실제 곡을 임포트하면 분리 완료 후 별도 조작 없이 라이브러리 행 메타 줄에 `<n> BPM · <키>`가 나타나고, `library.sqlite`의 해당 행에 `bpm`, `music_key`, `analysis_source='auto'`가 기록된다. 분석 중에도 트랙은 `ready` 상태로 즉시 재생할 수 있다.
3. 스키마 v2 DB(분석 컬럼 없음)로 앱을 시작하면 `user_version`이 3으로 올라가고 기존 행이 보존되며, `status='ready'`이고 `analysis_source='none'`인 트랙이 시작 후 순차 분석돼 값이 채워진다. 상태 전이(`separating` 등)는 발생하지 않는다.
4. 분석이 실패하면(fake worker가 `error`를 반환하거나 `inst.wav`가 손상된 경우) 트랙 상태는 `ready`로 유지되고, 표시는 비어 있으며, 메인 로그에 `[analysis]` 실패 줄이 남는다. 앱은 크래시하지 않는다. 체크포인트 다운로드만 실패한 경우(네트워크 차단으로 재현)에는 `bpm: null`, `key`는 정상값으로 `done`이 오고, 키만 표시된다.
5. 원키 `C#m`인 곡에서 키를 +2 하면 트랜스포트에 `C#m → D#m`, −3이면 `C#m → A#m`, +6이면 `C#m → Gm`이 표시되고, 원키 리셋 후에는 `C#m`만 표시된다. 순수 함수 `transposeKey`의 단위 테스트가 12음 × ±6 경계와 `null` 입력을 커버한다.
6. `key_conf`가 임계값 미만이면 키가 `C#m?`처럼 표시된다. 메타 편집 폼에서 키를 `Bm`, BPM을 `96`으로 입력·저장하면 즉시 반영되고, 앱을 재시작해도 값이 유지되며 백필이 덮어쓰지 않는다(`analysis_source='user'`). 형식이 틀린 키(`H`, `c#`)와 범위 밖 BPM(30 미만, 300 초과)은 저장이 거부된다.
7. `pnpm typecheck && pnpm lint && pnpm test`가 exit 0이다. 기존 테스트(LibraryStore, JobQueue, SidecarManager 등)는 수정 없이 통과한다.
8. 5분 길이 곡의 `inst.wav` 분석(체크포인트 캐시된 상태)이 CUDA에서 5초, CPU(`KARAOKE_DEVICE=cpu`)에서 30초 이내에 끝난다. 사이드카 stderr에 단계별 소요 시간이 기록되어 확인할 수 있다. 상한은 실측 후 §4.5 구현 기록에서 조정할 수 있다.

## 3. 전제 조건

| 전제                                                               | source of truth / 확인 방법                                                                                                                                                          |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| numpy 2.5.2, torch 2.8, torchaudio 2.8, einops이 venv에 있음       | `sidecar/uv.lock`. scipy·numba·librosa는 없음(`sidecar/.venv/Lib/site-packages` 목록). 키 검출은 이 범위 안에서 구현한다                                                             |
| `beat-this` 1.1.0이 PyPI에 순수 Python 휠로 있음                   | pypi.org `beat-this` (2026-04-14, `py3-none-any`, MIT). 의존성 numpy>=1.20, torch>=2, torchaudio, einops, rotary-embedding-torch, soxr. madmom은 DBN 옵션에만 필요해 설치하지 않는다 |
| soxr·rotary-embedding-torch가 Windows에 빌드 없이 설치됨           | soxr는 프리빌트 휠, rotary-embedding-torch는 순수 Python. `uv lock` 결과로 확인한다                                                                                                  |
| `Audio2Beats`가 텐서 + 샘플레이트 입력을 받음                      | beat_this README Python API. `inst.wav`를 soundfile로 읽어 넘기므로 ffmpeg가 필요 없다                                                                                               |
| 체크포인트는 첫 사용 시 자동 다운로드                              | beat_this README (`final0` 약 78 MB). 캐시 경로는 구현 시 확인해 §4.5에 기록한다. 001 §4.1 "모델은 각 라이브러리 캐시" 결정과 같은 패턴                                              |
| 분리 산출물 `inst.wav`가 Demucs 모델 샘플레이트(44.1 kHz) 스테레오 | `sidecar/src/karaoke_worker/separate.py` (`separator.samplerate`로 저장), 000 §4.3 데이터 레이아웃                                                                                   |
| 사이드카 프로토콜: stdout JSONL, `done`/`error`/`progress`         | `sidecar/src/karaoke_worker/protocol.py`, 000 §4.2                                                                                                                                   |
| `tracks` 스키마 현재 v2, 마이그레이션 패턴                         | `src/main/library/LibraryStore.ts` `SCHEMA_VERSION`·`migrate()`. 컬럼 추가는 `ALTER TABLE ... ADD COLUMN`                                                                            |
| 분리 작업은 JobQueue로 직렬화됨                                    | `src/main/library/ImportService.ts` `enqueueSeparation`, `JobQueue.ts`. 분석도 같은 큐에 넣어 torch 프로세스 동시 실행을 막는다                                                      |
| 시작 시 백필 훅이 있음                                             | `src/main/index.ts`의 `searchKeyService.backfill()`·`coverService.backfill()` 호출 지점(부트스트랩 ready 이후). 분석 백필도 같은 자리에 붙인다                                       |
| 렌더러 키 변경 상태는 `pitch`(정수, −6–+6)                         | `src/renderer/src/stores/playerStore.ts` `setPitch`. 트랜스포트 UI는 `src/renderer/src/components/Transport.tsx` `.pitch-control`                                                    |
| 메타 편집 IPC와 입력 타입                                          | `src/shared/types.ts` `TrackMetaInput`, `LibraryStore.updateMeta`, IPC `library:update-meta`                                                                                         |
| 사이드카 테스트 러너 없음                                          | `sidecar/pyproject.toml`에 테스트 의존성 없음. pytest를 `[dependency-groups] dev`로 추가한다                                                                                         |
| `uv.lock` 변경 시 패키징 앱은 재sync                               | 001 §4.1 마커 판정(uv.lock 해시). `beat-this`와 pytest 추가로 lock이 바뀌므로 다음 실행에 한 번 재sync된다. 허용                                                                     |
| 부트스트랩 sync는 `--frozen`                                       | `src/main/sidecar/SidecarBootstrap.ts`. dev 그룹도 함께 설치된다(pytest 수 MB). 별도 `--no-dev` 분기는 만들지 않는다                                                                 |

## 4. 기능 범위

### 4.1 사이드카 `analyze`

- 명령: `analyze --input <inst.wav> [--device auto] --json` → `{"bpm": 128.0, "bpm_conf": 0.72, "key": "C#m", "key_conf": 0.41, "version": 1}`. `key`는 추정 불가(무음, 무조성) 시 `null`, `bpm`은 비트 검출 실패·체크포인트 다운로드 실패 시 `null`. 둘 다 `null`이어도 `done`으로 응답한다 — 오류는 파일 읽기 실패·형식 오류에 한정한다(`WorkerError("FILE_NOT_FOUND" | "UNSUPPORTED_FORMAT")`).
- 의존성: `sidecar/pyproject.toml` dependencies에 `beat-this>=1.1`을 추가한다. `uv lock` 후 새로 들어오는 패키지가 `beat-this`, `rotary-embedding-torch`, `soxr`(및 그 순수 의존성) 범위인지 확인한다. torch·torchaudio 버전 고정(2.8, cu128)은 유지한다.
- 처리 참고 구현(성공 기준이 우선, 구현 방식은 자유):
  - 로드: soundfile로 `inst.wav`를 읽어 모노 다운믹스(float32).
  - BPM: `beat_this.inference.Audio2Beats(checkpoint_path="final0", device=device, dbn=False)`에 파형과 샘플레이트를 넘겨 비트 시각 배열을 받는다. 비트 간격의 중앙값으로 `bpm = 60 / median(diff(beats))`를 구하고 소수 첫째 자리로 반올림한다. 결과가 200 초과면 절반, 60 미만이면 두 배로 접는다. 비트가 4개 미만이면 `null`.
  - BPM 신뢰도: 비트 간격의 분산이 작을수록 1에 가깝게, 예: `clip(1 - 4 * std(ibi) / median(ibi), 0, 1)`. 템포가 변하는 곡은 자연히 낮게 나온다.
  - 키: STFT 크기 스펙트럼(n_fft 8192, hop 4096)을 55–2000 Hz 대역에서 12 피치 클래스로 접어 로그 압축 후 시간 평균 크로마를 만들고, Krumhansl–Kessler 장조·단조 프로파일 24개와 피어슨 상관을 구해 최댓값을 고른다. 드럼의 광대역 잡음은 대역 제한과 로그 압축으로 억제한다. 튜닝 오프셋 보정은 넣지 않는다(§5 정확도 기록에서 필요가 확인되면 추가).
  - 키 신뢰도: 후보 상관 1위와 2위의 차를 1위로 나눈 값을 0–1로 클램프한다.
  - 두 단계는 각각 try/except로 감싸 독립적으로 실패한다. 체크포인트 다운로드 실패는 stderr에 원인을 남기고 `bpm: null`로 진행한다.
- `progress`는 `stage: "analyze"`로 0(로드)·30(BPM 시작)·70(키 시작)·100이면 충분하다. 단계별 소요 시간을 stderr `log()`로 남긴다(기준 8).
- 디바이스: `--device`는 `separate`와 같은 `_resolve_device` 규칙(`KARAOKE_DEVICE` 우선)을 따른다. 키는 결정적 연산이라 디바이스와 무관하게 같은 값이어야 한다. BPM은 신경망 추론이라 디바이스 간 ±0.5 이내 차이를 허용한다.

### 4.2 저장과 파이프라인

- 스키마 v3 마이그레이션(`SCHEMA_VERSION = 3`):

  ```sql
  ALTER TABLE tracks ADD COLUMN bpm              REAL;
  ALTER TABLE tracks ADD COLUMN music_key        TEXT;
  ALTER TABLE tracks ADD COLUMN bpm_conf         REAL;
  ALTER TABLE tracks ADD COLUMN key_conf         REAL;
  ALTER TABLE tracks ADD COLUMN analysis_version INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE tracks ADD COLUMN analysis_source  TEXT NOT NULL DEFAULT 'none';  -- none | auto | user
  ```

- `Track` 타입에 `bpm: number | null`, `musicKey: string | null`, `bpmConf: number | null`, `keyConf: number | null`, `analysisSource: 'none' | 'auto' | 'user'`를 추가한다. `ANALYSIS_VERSION`, `ANALYSIS_LOW_CONF` 상수와 키 문자열 정규식(`^[A-G]#?m?$`)은 `src/shared/types.ts`에 둔다(메인 검증과 렌더러 표시가 공유).
- `LibraryStore`: `setAnalysis(id, {bpm, musicKey, bpmConf, keyConf, version})`(source `auto`), `listTracksNeedingAnalysis()`(`status='ready' AND analysis_source != 'user' AND analysis_version < ANALYSIS_VERSION`). `updateMeta`는 `TrackMetaInput`에 `bpm?`·`musicKey?`가 포함되면 검증 후 저장하고 `analysis_source='user'`·`analysis_version=ANALYSIS_VERSION`으로 바꾼다. 분석 값 갱신은 `updated_at`을 건드리지 않는다(커버 캐시 키와 무관하게 유지).
- `AnalysisService`(신규): `refresh(trackId)`와 `backfill()`. 사이드카 `analyze`를 호출해 `setAnalysis` 후 `trackUpdated`를 통지한다. 실패는 로그만 남긴다. 타임아웃 120초.
- `ImportService.enqueueSeparation`: 분리 성공 → `meta.json` 기록 → `ready` 통지까지는 그대로 두고, 그 뒤 같은 JobQueue에 분석 작업을 넣는다(옵션 훅 `analyze?: (track) => void` 주입, 기존 `extractCover` 패턴). 재생 가능 시점을 늦추지 않는다.
- 시작 시 백필: `src/main/index.ts`의 기존 백필 지점에서 `analysisService.backfill()`을 호출한다. 백필은 JobQueue를 통해 직렬로 돈다.

### 4.3 표시와 변조 키

- 공용 헬퍼 `src/shared/musicKey.ts`: `parseKey(s): {root: 0–11, minor: boolean} | null`, `formatKey`, `transposeKey(key: string | null, semitones: number): string | null`. 표기는 §1 결정 기록(샤프 통일)을 따른다.
- 라이브러리 행(`App.tsx` `track-meta`): 기존 `아티스트 · 3:45` 뒤에 ` · 128 BPM · C#m`을 붙인다. 값이 `null`이면 해당 항목만 생략한다. 신뢰도 미만이면 `?` 접미(`128 BPM? · C#m?`).
- 트랜스포트(`Transport.tsx` `.pitch-control`): `pitch-value` 옆에 키 표기를 추가한다. `pitch === 0`이면 `C#m`, 아니면 `C#m → D#m`. 원키가 `null`이면 표기를 생략한다. 신뢰도 미만이면 원키 쪽에만 `?`.
- 메타 편집 폼: BPM(숫자, 30–300)과 키(텍스트, 정규식 검증, 빈 값은 `null`) 입력을 추가한다. 저장은 기존 `updateTrackMeta` IPC를 확장해 쓴다.
- README `기능` 절의 라이브러리·키 변경 항목에 한 줄씩 보강한다.

### 4.4 구현 슬라이스

| 슬라이스 | 산출물                                            | 소유(수정 가능) 경로                                                                                                                                                                                                                                       | 수정 금지 경로                                     | 선행 조건                                         | 상태   |
| -------- | ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- | ------------------------------------------------- | ------ |
| A1       | 사이드카 `analyze` + 합성 신호 테스트             | `sidecar/src/karaoke_worker/analyze.py`(신규), `sidecar/src/karaoke_worker/cli.py`(서브커맨드 추가만), `sidecar/tests/**`(신규), `sidecar/pyproject.toml`(`beat-this` 런타임 의존성 + dev 그룹 pytest), `sidecar/uv.lock`                                  | `src/**`, `docs/**`                                | 없음                                              | 미착수 |
| A2       | 스키마 v3 + AnalysisService + 파이프라인·백필·IPC | `src/main/library/AnalysisService.ts`(신규), `src/main/library/LibraryStore.ts`, `src/main/library/ImportService.ts`, `src/main/index.ts`, `src/main/ipc.ts`, `src/preload/index.ts`, `src/shared/types.ts`, `src/main/library/__tests__/**`(추가·확장)    | `sidecar/**`, `src/renderer/**`                    | 없음 (A1과 병렬. 테스트는 `fake_worker.mjs` 확장) | 미착수 |
| A3       | 변조 키 헬퍼 + 라이브러리/트랜스포트/메타 폼 UI   | `src/shared/musicKey.ts`(신규), `src/shared/__tests__/musicKey.test.ts`(신규), `src/renderer/src/App.tsx`, `src/renderer/src/components/Transport.tsx`, `src/renderer/src/stores/libraryStore.ts`, `src/renderer/src/assets/main.css`(추가만), `README.md` | `src/main/**`, `sidecar/**`, `src/shared/types.ts` | A2 완료 (`Track`·`TrackMetaInput` 타입 확정)      | 미착수 |

- 슬라이스 완료 판정: A1 = 기준 1·8, A2 = 기준 2(저장)·3·4·7, A3 = 기준 2(표시)·5·6.
- 공유 파일 소유: `src/shared/types.ts`·`src/preload/index.ts`·`src/main/ipc.ts`는 A2. A3가 타입 추가가 필요하면 감독자가 A2에 반영한 뒤 진행한다. `sidecar/cli.py`는 A1.
- 프로토콜 계약: A1과 A2는 §4.1의 `analyze` 입출력 JSON을 계약으로 삼아 병렬로 진행한다. 필드명 변경은 감독자 승인 후 양쪽 동시 반영.
- 감독 규칙: 각 에이전트는 종료 전 §5의 자동 검증 명령을 실행하고 exit code를 보고한다. 훅 우회(`--no-verify`, `LEFTHOOK=0`) 금지. git 상태 변경(commit/stage)은 감독자 또는 사용자만 수행한다. 완료된 슬라이스는 재작업하지 않는다.
- 이 표를 실행할 때는 `orchestrate-slices` 스킬을 사용한다.

## 5. 검증 방법

```bash
pnpm typecheck && pnpm lint && pnpm test                       # 기준 7 회귀 + 기준 3(마이그레이션)·4(실패 격리)·5(transposeKey)·6(입력 검증) 단위 테스트
uv run --project sidecar pytest sidecar/tests -q               # 기준 1 합성 신호(첫 실행은 final0 체크포인트 다운로드 필요), 기준 8 소요 시간 assert(30초 신호 기준 비례 상한)
uv run --project sidecar karaoke_worker analyze --input "%APPDATA%/karaoke-player/tracks/<id>/inst.wav" --json   # 기준 2·8 실곡 단독 확인 (stderr에 소요 시간)
pnpm dev                                                       # 기준 2·3·4·6 수동 확인
```

- 기준 2 (수동): `pnpm dev`에서 곡 임포트 → 분리 완료 직후 재생 가능한지, 몇 초 뒤 행에 BPM·키가 나타나는지 확인. `library.sqlite`를 열어 컬럼 값 확인.
- 기준 3 (수동): 이 스펙 이전 커밋으로 만든 `library.sqlite`(v2)를 두고 앱 시작 → 기존 트랙에 값이 순차로 채워지는지, 상태 표시가 흔들리지 않는지 확인.
- 기준 4 (수동 보조): 한 트랙의 `inst.wav`를 0바이트로 바꾸고 `analysis_source`를 `none`으로 되돌린 뒤 재시작 → 로그에 실패 줄, 행은 `ready` 유지.
- 기준 6 (수동): 메타 편집에서 키·BPM 입력·저장 → 재시작 → 유지 확인. 틀린 형식 입력 시 저장 거부 메시지 확인.
- 기준 4 후반 (수동): 체크포인트 캐시를 비우고 네트워크를 차단한 채 위 단독 명령 실행 → `bpm: null`, `key` 정상, exit 0, stderr에 다운로드 실패 원인.
- 기준 8 (수동): 5분 안팎 곡의 `inst.wav`로 위 단독 명령을 CUDA와 `KARAOKE_DEVICE=cpu`로 각각 실행해 stderr 시간을 읽는다.
- 정확도 기록(후속 판단용, 성공 기준 아님): 실제 곡 10곡(K-POP 5, J-POP 5)에서 BPM·키를 사람이 확인해 표에 남긴다. 절반·두 배 템포 오류, 상대조 혼동, 그 외 키 오류 건수와 `ANALYSIS_LOW_CONF` 보정값을 §4.5 구현 기록에 적는다. 키 오류가 상대조 혼동 외에도 잦으면 튜닝 오프셋 보정 추가를 검토한다.
