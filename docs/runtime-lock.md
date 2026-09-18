# 런타임 의존성 lock 운영

앱 배포물과 같은 검증된 Python·도구·모델만 실행한다. 계약은 `docs/specs/008-runtime-dependency-lock.md`다.

## 파일

| 경로                                                  | 역할                                                                       |
| ----------------------------------------------------- | -------------------------------------------------------------------------- |
| `build/locks/tools.lock.json`                         | uv·yt-dlp·Deno 자산 (archive면 외부 hash + 추출 파일 hash)                 |
| `build/locks/python.lock.json`                        | CPython 3.12.x patch·배포 빌드·내부 파일 inventory                         |
| `build/locks/wheels.lock.json`                        | Windows x64 런타임 wheel. `uvLockDigest`가 `sidecar/uv.lock`에 묶인다      |
| `build/locks/models.lock.json`                        | 모델 ID → revision·필요 파일·loader                                        |
| `build/locks/*.provenance.json`                       | 각 hash를 어디서 채택했는지                                                |
| `dist/runtime-staging/<target>/runtime-manifest.json` | 타깃별 생성 manifest v2. lock/sidecar digest·runtimeId·채널·도구 배치 정책 |
| `sidecar/uv.lock`                                     | Python 해석의 원본. wheel lock과 불일치하면 `verify` 실패                  |

lock은 코드 검토 대상이다. 일반 `verify`·빌드는 lock을 수정하지 않는다.

## 명령

```bash
# 커밋된 lock 검증. 파일 변경 없음
node scripts/runtime-lock/cli.mjs verify

# 검토용 후보만 생성. build/locks 는 그대로
node scripts/runtime-lock/cli.mjs propose --output dist/lock-candidate

# 패키징 산출물 검사
node scripts/runtime-lock/cli.mjs verify-package --target zip --input dist/win-unpacked
node scripts/runtime-lock/cli.mjs verify-package --target appx --input dist/win-unpacked
node scripts/runtime-lock/cli.mjs verify-package --target nsis --input dist/nsis/win-unpacked

# NSIS는 도구를 받지 않고 metadata·sidecar만 준비
node scripts/prepare-resources.mjs --target nsis
pnpm build:nsis

# fixture 통합. 실자산은 opt-in
node scripts/runtime-acceptance/run.mjs
node scripts/runtime-acceptance/run.mjs --real-assets --data-dir dist/runtime-acceptance
```

패키징 스크립트는 pack 전에 `verify`를 실행한다. ZIP/APPX는 각 빌드 직후 해당 unpacked 디렉터리를 검사한다. NSIS는 실제 설치 파일에 삽입된 앱 payload까지 대조하며 상세 절차는 [NSIS 인수 검증](../scripts/nsis-acceptance/README.md)을 따른다.

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
├─ runtime-tools/
│  └─ <id>/<digest>/        # NSIS에서 검증·활성화한 도구. 설치 디렉터리에 쓰지 않음
├─ sidecar/                 # 001 당시 경로. 보존하되 준비 완료로 신뢰하지 않음
└─ library.sqlite
```

실행은 현재 앱 manifest의 `runtimeId`와 포인터가 같을 때만 한다. 과거 앱 환경은 fallback이 아니다. 실패해도 이전 포인터와 공용 캐시는 남는다.

모델 파일은 앱 시작이 아니라 작업 시점(분리·전사·정렬·분석)에만 `KARAOKE_MODELS_DIR`로 준비한다.

## 개발 vs 패키징

|            | 개발 (`pnpm dev`)                           | 패키징                                          |
| ---------- | ------------------------------------------- | ----------------------------------------------- |
| sidecar    | 레포 `sidecar/` + PATH의 `uv run`           | 검증된 CPython 절대경로 + offline wheelhouse    |
| 부트스트랩 | 건너뜀 (`createReadyBootstrap`)             | hash 검증 후 포인터 선택                        |
| 모델 lock  | 레포 `build/locks/models.lock.json`         | 번들 `resources/locks/`                         |
| URL 임포트 | `resources/bin`에 yt-dlp·deno가 있으면 켜짐 | ZIP 번들 / NSIS 첫 실행 다운로드. APPX 기능 off |

NSIS는 배포 manifest의 `capabilities.urlImport`로 지원 여부를 정한다. 도구가 아직 없어도 지원 UI는 보이며 준비 완료 후 사용할 수 있다. Deno·yt-dlp 준비 실패는 Python 환경 준비 상태와 분리하므로 정상 로컬 작업을 막지 않는다. URL 미리보기에는 URL 도구, URL 가져오기에는 URL 도구와 Python 환경이 모두 필요하다.

일반 NSIS 빌드와 앱 실행에서는 원격 checksum을 새 신뢰 기준으로 채택하지 않는다. lock에 고정된 전체 SHA-256으로 다운로드·캐시·exe를 검사한다. uv·Deno ZIP의 hash와 내부 exe hash를 구분하며 `latest`, self-update, 시스템 PATH 도구로 우회하지 않는다. 새 버전은 새 digest 경로에 준비하고 이전 정상 파일은 보존한다.

## 실패 안내

초기화의 파일 SHA-256 검증, CPython/도구 압축 해제, 검증된 파일 복사는 공유 Node.js Worker에서 순차 처리한다. 다운로드와 진행 상태 전달, 프로세스 잠금, Python/uv 실행 제어는 메인 프로세스가 비동기로 담당한다. Worker는 `?modulePath`로 별도 번들에 포함되며 Python 설치 전에도 실행할 수 있다.

취소는 공유 플래그로 전달한다. 해시 청크와 파일 확정 전 경계에서 확인하며, 진행 중인 OS 파일 복사는 반환 후 취소를 확인하고 임시 파일을 정리한다. 호출자는 Worker 응답까지 기다린 뒤 잠금을 해제하므로 취소 직후 재시도가 이전 쓰기와 겹치지 않는다. Worker 비정상 종료 시 대기 요청을 실패시키고 다음 요청에서 새 Worker를 생성한다.

오류 문자열에 `id=`(논리 ID)·`stage=`(download/verify/env-prep/model-prep)·`retryable=`이 들어간다. 재시도는 같은 준비를 다시 돌린다. 정상 캐시 삭제나 라이브러리 초기화는 요구하지 않는다.

검증 실패를 GPU 실패로 보고 CPU/다른 모델로 우회하지 않는다.
