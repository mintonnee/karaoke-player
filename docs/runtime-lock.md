# 런타임 의존성 lock 운영

앱 배포물과 같은 검증된 Python·도구·모델만 실행한다. 계약은 `docs/specs/008-runtime-dependency-lock.md`다.

## 파일

| 경로                            | 역할                                                                  |
| ------------------------------- | --------------------------------------------------------------------- |
| `build/locks/tools.lock.json`   | uv·yt-dlp·Deno 자산 (archive면 외부 hash + 추출 파일 hash)            |
| `build/locks/python.lock.json`  | CPython 3.12.x patch·배포 빌드·내부 파일 inventory                    |
| `build/locks/wheels.lock.json`  | Windows x64 런타임 wheel. `uvLockDigest`가 `sidecar/uv.lock`에 묶인다 |
| `build/locks/models.lock.json`  | 모델 ID → revision·필요 파일·loader                                   |
| `build/locks/*.provenance.json` | 각 hash를 어디서 채택했는지                                           |
| `build/runtime-manifest.json`   | 패키징 시 생성. lock digest + sidecar source digest + runtimeId       |
| `sidecar/uv.lock`               | Python 해석의 원본. wheel lock과 불일치하면 `verify` 실패             |

lock은 코드 검토 대상이다. 일반 `verify`·빌드는 lock을 수정하지 않는다.

## 명령

```bash
# 커밋된 lock 검증. 파일 변경 없음
node scripts/runtime-lock/cli.mjs verify

# 검토용 후보만 생성. build/locks 는 그대로
node scripts/runtime-lock/cli.mjs propose --output dist/lock-candidate

# 패키징 산출물 검사
node scripts/runtime-lock/cli.mjs verify-package --target zip --input dist
node scripts/runtime-lock/cli.mjs verify-package --target appx --input dist

# fixture 통합. 실자산은 opt-in
node scripts/runtime-acceptance/run.mjs
node scripts/runtime-acceptance/run.mjs --real-assets --data-dir dist/runtime-acceptance
```

패키징 스크립트(`pnpm build:zip` / `build:msix`)는 pack 전에 `verify`를 실행한다.

## 갱신 절차

1. `propose --output dist/lock-candidate`로 후보를 받는다.
2. 출처·라이선스·버전·용량·hash와 최소 실행 결과를 검토한다. GitHub checksum, PyPI/`uv.lock`, HF LFS sha256, 직접 받은 파일의 provenance를 대조한다.
3. 수용할 값만 `build/locks/`에 반영하고 provenance를 갱신한다. 내려받은 값을 verify가 자동 수용하지 않는다.
4. `sidecar/pyproject.toml` 의존성을 바꾸면 `uv lock` 후 **wheels.lock를 다시 선택**한다. `uvLockDigest`가 바뀌면 기존 wheels.lock은 `verify`에서 실패한다.
5. Python patch를 올리면 `python.lock.json`과 `.python-version` 가족(3.12)이 맞는지 확인한다.

`--force`는 다시 받기만 한다. hash 불일치를 무시하거나 lock을 고치지 않는다.

## 런타임 레이아웃 (패키징 앱)

Windows `userData`는 보통 `%APPDATA%\Karaoke Player`다.

```text
<userData>/
├─ runtimes/
│  ├─ current.json          # 선택 포인터. 성공 시에만 교체
│  └─ <runtimeId>/          # 최종 경로에서 구성. temp venv rename 없음
│     ├─ venv/
│     ├─ sidecar/
│     ├─ inventory.json
│     └─ smoke.json
├─ runtime-cache/
│  └─ sha256/<digest>/      # 내용 주소 캐시. incomplete는 complete로 승격하지 않음
├─ sidecar/                 # 001 당시 경로. 보존하되 준비 완료로 신뢰하지 않음
└─ library.sqlite
```

실행은 현재 앱 manifest의 `runtimeId`와 포인터가 같을 때만 한다. 과거 앱 환경은 fallback이 아니다. 실패해도 이전 포인터와 공용 캐시는 남는다.

모델 파일은 앱 시작이 아니라 작업 시점(분리·전사·정렬·분석)에만 `KARAOKE_MODELS_DIR`로 준비한다.

## 개발 vs 패키징

|            | 개발 (`pnpm dev`)                           | 패키징                                        |
| ---------- | ------------------------------------------- | --------------------------------------------- |
| sidecar    | 레포 `sidecar/` + PATH의 `uv run`           | 검증된 CPython 절대경로 + offline wheelhouse  |
| 부트스트랩 | 건너뜀 (`createReadyBootstrap`)             | hash 검증 후 포인터 선택                      |
| 모델 lock  | 레포 `build/locks/models.lock.json`         | 번들 `resources/locks/`                       |
| URL 임포트 | `resources/bin`에 yt-dlp·deno가 있으면 켜짐 | zip만 yt-dlp 포함. APPX는 기능 off(오류 아님) |

## 실패 안내

오류 문자열에 `id=`(논리 ID)·`stage=`(download/verify/env-prep/model-prep)·`retryable=`이 들어간다. 재시도는 같은 준비를 다시 돌린다. 정상 캐시 삭제나 라이브러리 초기화는 요구하지 않는다.

검증 실패를 GPU 실패로 보고 CPU/다른 모델로 우회하지 않는다.
