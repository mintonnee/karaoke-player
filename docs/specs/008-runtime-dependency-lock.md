# Karaoke Player 외부 실행 의존성 lock 스펙

- 작성일: 2026-09-15
- 연관 스펙: `001-packaging-distribution.md`, `007-db-schema-safety.md`
- 대상: 001 §4.1 사이드카 부트스트랩·§4.2 번들 리소스·§4.3 URL 임포트의 의존성 고정
- 상태: 구현됨 (fixture 자동 검증 통과, 실자산·패키징 바이트·수동 UI 확인 대기)

이 문서는 001의 다운로드·부트스트랩에서 Python 런타임과 패키지, sidecar 코드, 모델, uv·yt-dlp·Deno의 고정·검증·활성화를 분리해 다룬다. 기존 001의 파일 존재 기반 재사용과 기존 venv에 직접 sync하는 방식은 이 스펙 구현 완료 후 대체한다.

후속 [`012-nsis-installer.md`](012-nsis-installer.md)는 이 lock·검증·캐시 계약을 재사용해 NSIS 채널에서 세 도구를 첫 앱 실행에 다운로드하도록 확장한다. NSIS에는 도구 exe/ZIP을 포함하지 않으며 manifest v2의 채널·배치 정책, 도구 readiness와 재시도, 최종 설치 payload 검증을 추가한다. 아래 ZIP/APPX 정책은 유지하며 012의 구현 상태는 별도로 관리한다.

## 1. 목표와 비목표

```text
같은 앱 배포물은 같은 검증된 실행 의존성을 사용하고, 파일 불일치·다운로드 중단·환경 준비 실패가 발생해도 검증되지 않은 파일을 실행하거나 기존 정상 환경을 덮어쓰지 않는다.
```

| 영역 | 목표                                                               |
| ---- | ------------------------------------------------------------------ |
| 고정 | 버전·플랫폼·출처·크기·SHA-256을 검토 가능한 lock으로 관리한다      |
| 검증 | 다운로드·캐시·실행·모델 로드 경로에서 검증 우회를 막는다           |
| 재현 | Python 설치 입력과 모델 구성 파일을 모두 고정한다                  |
| 복구 | 새 환경 검증 후 선택하며 이전 환경과 공용 다운로드 캐시를 보존한다 |

| 비목표                                                           | 이유                                                                         |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| CI workflow·태그·릴리즈·서명 서비스 구축                         | 이 문서는 후속 CI가 호출할 로컬 명령·배포 입력 계약까지 정의한다             |
| 앱과 독립된 원격 lock 업데이트                                   | 앱 버전과 의존성 조합을 함께 검증한다                                        |
| 모델·CUDA 전체 설치 파일 번들                                    | 001의 필요 시 다운로드와 배포 크기 정책을 유지한다                           |
| 모델 추론 결과의 비트 단위 재현                                  | GPU·알고리즘 비결정성과 설치 입력의 재현성은 별개다                          |
| 동일 사용자 권한의 악성 프로세스·앱 자체 변조에 대한 완전한 방어 | 검증기와 로컬 파일을 동시에 바꿀 수 있는 공격은 hash lock만으로 막을 수 없다 |
| macOS/Linux·새 모델 추가·CPU 배포 변형                           | 현재 Windows x64와 기존 모델 선택 범위를 먼저 고정한다                       |

## 2. 성공 기준

1. lock schema 오류, 누락된 hash, 중복/충돌 경로, 잘못된 크기·플랫폼, mutable revision, 허용하지 않은 출처는 실행·패키징 전에 실패한다. 일반 검증·빌드가 lock 파일을 수정하지 않는다.
2. uv·yt-dlp·Deno 다운로드/캐시의 1바이트 변조, truncated archive, 잘못된 exe를 검출하며 `--version`조차 검증 전에 실행하지 않는다. ZIP 경로 탈출·링크·대소문자 충돌을 거부한다.
3. Python 인터프리터의 패치 버전·배포 빌드·아카이브와 Windows x64 설치 wheel 집합이 고정된다. 사용자 PC에서는 sdist 빌드·온라인 dependency resolve·시스템 Python fallback을 하지 않는다.
4. sidecar `.python-version`, 프로젝트 메타·lock·소스·최종 wheel 중 어느 하나라도 바뀌면 환경 ID가 바뀐다. 번들 및 실제 실행 소스가 검증되고, 기존 `.ready`나 `.venv` 존재만으로 준비 완료가 되지 않는다.
5. 새 환경 준비·검사 실패 및 강제 종료 후에도 이전 정상 환경이 보존된다. 재시도는 성공 시에만 선택 포인터를 변경하며, 현재 manifest와 맞지 않는 과거 환경을 현재 앱에서 실행하지 않는다.
6. 기존 UI가 허용하는 모든 Demucs 모델, Whisper 기본 모델, MMS_FA, Beat This! 및 전이적 보조 모델의 실제 필요 파일이 목록화된다. 각 파일의 크기·전체 SHA-256을 검사한 로컬 경로만 로더에 전달한다.
7. 모델 캐시의 가중치·config/tokenizer 변조를 각각 검출한다. 파일 누락 시 라이브러리의 자동 다운로드로 우회하지 않으며, 모든 파일 준비 후 네트워크 차단 상태에서 각 모델의 최소 실행이 성공한다.
8. 동일 리소스의 동시 요청은 다운로드·활성화를 하나로 합친다. 한 호출자의 취소가 다른 대기자를 취소하지 않고, 모든 대기자 취소/프로세스 종료 시 불완전 파일은 정상 캐시로 노출되지 않는다.
9. 패키징 후 검증 명령은 배포 manifest, 번들 exe·sidecar 산출물·lock 해시 및 타깃별 구성 일치를 검사한다. ZIP에는 URL 임포트 도구를 포함하고 APPX에는 yt-dlp를 포함하지 않는다.
10. 실패 UI는 다운로드·검증·환경 구성·모델 준비 단계를 구분하고 재시도를 제공한다. 런타임 오류로 기존 완료 곡 재생을 차단하지 않으며, 필요한 의존성이 준비되지 않은 작업만 명확히 실패/비활성화한다.
11. 명시적 lock 갱신 명령은 검토할 후보만 생성한다. 일반 검증은 실제 lock을 사용하며, 기존 값 불일치를 내려받은 값으로 자동 수용하지 않는다. 출처·라이선스·버전·용량·hash 변경과 최소 실행 결과를 검토할 수 있다.

## 3. 전제 조건

| 전제                                   | source of truth / 확인 방법                                                                               |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| 바이너리 버전 고정·hash 검증 없음      | `scripts/prepare-resources.mjs`; 파일 존재 시 skip하고 이후 `--version` 실행                              |
| Python은 3.12 계열만 선택              | `sidecar/.python-version`; `pyproject.toml`은 `>=3.11,<3.13`                                              |
| 패키지 배포 hash는 이미 존재           | `sidecar/uv.lock`; 개발 dependency와 build-system은 별도 확인 필요                                        |
| 프로젝트 hash는 `.python-version` 제외 | `SidecarBootstrap.ts`의 `computeProjectHash`; ready는 marker와 venv 존재로 판단                           |
| 준비 전에는 라이브러리 화면도 막힘     | `src/renderer/src/App.tsx`, `components/BootstrapScreen.tsx`; 기준 10을 위해 변경 필요                    |
| 모델 선택·실제 로더                    | `src/shared/types.ts`의 `DEMUCS_MODELS`; sidecar `separate.py`, `transcribe.py`, `align.py`, `analyze.py` |
| 데이터 안전 선행 조건                  | 007 DB 준비 성공 이후 런타임 초기화·라이브러리 복구를 시작한다                                            |

`uv.lock`을 Python 패키지 해석의 원본으로 유지한다. frozen은 lock 최신성 검사까지 보장하지 않으므로 별도 일치 검사가 필요하다. Hugging Face 다운로드는 전체 commit revision을 지정할 수 있다. [uv locking 문서](https://docs.astral.sh/uv/concepts/projects/sync/), [Hugging Face 다운로드 문서](https://huggingface.co/docs/huggingface_hub/guides/download)

## 4. 기능 범위

### 4.1 lock과 배포 manifest

신규 파일의 책임을 다음으로 고정한다. 아래 파일은 구현 산출물이며 현재 존재한다고 가정하지 않는다.

| 파일                                   | 책임                                                                                              |
| -------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `build/locks/tools.lock.json`          | uv·yt-dlp·Deno의 정확한 릴리즈 자산과 추출 결과                                                   |
| `build/locks/python.lock.json`         | CPython 패치·배포 빌드·플랫폼·아카이브 및 실행에 필요한 파일 목록                                 |
| `build/locks/models.lock.json`         | 모델 ID → 고정 revision·필요 파일·의존 모델·loader 연결                                           |
| `build/locks/wheels.lock.json`         | Windows x64 선택 wheel 및 통제된 사전 빌드 산출물의 hash, 원본 lock과 빌드 입력 연결              |
| `sidecar/uv.lock`                      | Python dependency resolution 원본; wheel lock과의 불일치는 실패                                   |
| 생성 `resources/runtime-manifest.json` | lock digest, sidecar source/최종 wheel digest, 타깃 capability, 번들 최종 바이트 hash, runtime ID |

공통 schema는 `schemaVersion`, 논리 ID, 버전/revision, 플랫폼, 고정 HTTPS URL, 바이트 크기, 소문자 64자리 SHA-256, 상대 목적 경로, 출처·라이선스를 포함한다. archive에는 외부 archive hash와 허용된 추출 파일별 hash를 모두 둔다. URL의 고정 이름만 신뢰하지 않는다. HF는 전체 commit SHA를 사용하고 `main`·`latest`·이동 가능한 태그를 lock 값으로 받지 않는다.

manifest digest는 정해진 UTF-8 canonical serialization(키·상대 경로 정렬, `/` 구분자)에 SHA-256을 적용한다. 파일 내용은 실제 배포 바이트 그대로 해싱한다. 플랫폼·인터프리터·wheel 목록·uv·sidecar 코드 등 실행 입력으로 runtime ID를 만들며 앱의 표시 버전만으로 환경을 구분하지 않는다. 모델은 독립 digest로 재사용한다. tar/zip 순서·mtime을 입력으로 삼지 않는다.

lock은 코드 검토 대상이다. 초기 hash는 유지보수자가 공식 자산·가능한 upstream checksum/signature와 대조해 채택하고, 제공되지 않는 경우 직접 검증한 다운로드라는 provenance를 남긴다. 로컬 생성 manifest는 그 자체로 서명된 신뢰 증명이 아니다. 후속 서명 배포가 최종 바이트와 manifest를 함께 신뢰 가능한 배포 체계로 전달해야 한다. 원격 manifest를 독립 갱신하려면 별도 서명·키 교체 정책 스펙이 선행되어야 한다.

### 4.2 다운로드·캐시·검증

- 공통 다운로드 계약: lock 조회 → digest별 임시 위치로 stream 다운로드/크기 제한 → 전체 SHA-256 → 검증 후 압축 해제 → 결과 파일 검증 → 완료 상태 게시.
- 완료 캐시는 `<userData>/runtime-cache/sha256/<digest>/` 등 내용 주소로 관리한다. 모델 전체 구성은 별도 inventory digest로 묶는다. 다운로드 URL의 query·인증정보는 로그에 남기지 않는다.
- 기존 파일도 hash를 검사한다. `--force`는 다시 받기만 하며 hash 불일치를 무시하거나 lock을 갱신하지 않는다. 잘못된 archive는 해제하지 않고 잘못된 exe는 실행하지 않는다.
- 절대 경로, `..`, drive/UNC, symlink/reparse 경유, Windows 대소문자 충돌·중복 파일, 예상 외 실행 파일을 거부한다. 최종 resolved path가 대상 디렉터리 안인지 확인한다.
- Windows에서 파일 잠김·rename 실패 시 기존 완료 파일을 유지하고 오류를 반환한다. incomplete marker나 임시 파일을 완료로 승격하지 않는다.
- digest별 single-flight와 프로세스 간 잠금을 둔다. 취소는 대기자 단위, 다운로드 취소는 대기자가 없을 때 수행한다. 재시작 시 죽은 owner의 잠금만 회수하고 살아 있는 owner의 잠금을 시간만 보고 삭제하지 않는다.
- digest 불일치 시 자동 재다운로드는 최대 1회, 이후 재시도 UI를 제공한다. 다른 모델·다른 버전으로 fallback하지 않는다.

### 4.3 Python·sidecar 실행 환경

CPython은 정확한 patch/build 아카이브와 내부 파일 목록을 고정하고 검증 후 설치한다. 배포 실행은 절대 경로 인터프리터를 사용하며 미리 설치된 시스템 Python, 사용자 site-packages, `PYTHONPATH`·`PYTHONHOME` 및 외부 uv index 설정으로 선택 결과가 바뀌지 않게 실행 환경을 통제한다.

개발은 기존 `uv.lock` 기반 흐름을 유지한다. 배포는 해당 lock에서 Windows x64/고정 Python용 wheel 집합을 선택한다. sdist-only 패키지와 sidecar 자체는 통제된 빌드에서 wheel로 만든다. 이때 빌드 backend·build dependency·입력 sdist도 버전/hash로 고정하고 provenance에 기록한다. 사용자 PC에서는 검증된 wheelhouse로 offline 설치하며 dev dependency와 런타임 빌드를 허용하지 않는다. 저장소에 대용량 wheel을 커밋하지 않는다.

wheel lock은 `uv.lock`과 빌드 입력 digest에 종속된다. 일반 빌드는 검토된 외부 wheel 자산을 검증해 사용하고, 이번 checkout의 sidecar wheel은 고정된 backend로 생성해 source digest와 함께 manifest에 기록한다. 이 생성은 외부 lock 자동 갱신이 아니다. 외부 사전 빌드 wheel의 호스팅·라이선스·실제 URL은 첫 lock 채택 시 확정하고, 도달 가능한 자산이 없으면 배포 완료로 판정하지 않는다.

환경은 `<userData>/runtimes/<runtime-id>/`의 **최종 경로에서** 비활성 상태로 구성한다. venv는 절대 경로를 포함할 수 있으므로 임시 경로에서 만든 venv 디렉터리를 rename하여 활성화하지 않는다. runtime별 잠금, 준비 상태, 입력 digest, 설치 inventory, import/worker smoke 결과를 기록하고 성공 후 작은 선택 포인터를 교체한다. 실행 시 현재 앱 manifest의 runtime ID와 반드시 대조한다. 과거 앱용 환경을 현재 앱의 fallback으로 실행하지 않는다.

기존 `<userData>/sidecar`와 `.ready`는 신뢰하지 않으며 보존한 채 새 환경을 준비한다. 이전 정상 환경은 자동 삭제하지 않는다. 다운로드 전 알려진 크기와 여유 공간을 안내하고 부족하면 실패한다. 공용 다운로드 캐시는 재사용한다.

번들 metadata/source와 실제 실행 wheel/설치된 sidecar 파일을 검증한다. `.python-version`도 입력에 포함한다. `.venv` 전체 바이트 hash 대신 입력 wheel·설치 inventory와 smoke를 사용한다. Python 배포의 실행 파일·DLL·표준 라이브러리는 배포 inventory로 검사하고, 설치된 제3자 패키지의 매번 전체 변조 검출까지 보장한다고 주장하지 않는다. 이 제한은 의존성 입력 고정과 로컬 침해 방어의 경계다.

### 4.4 모델 준비와 로더

`sidecar/src/karaoke_worker/models/`에 공통 모델 registry·검증·준비 계층을 둔다. TypeScript 다운로드 계층과 구현 언어는 달라도 schema·해시·잠금·실패 계약은 같다. parity fixture로 두 검증기의 수락/거부 결과를 맞춘다.

기존 `DEMUCS_MODELS`의 모든 항목과 `large-v3-turbo`, MMS_FA, Beat This! `final0`의 실제 자산을 목록화한다. Demucs bag 구성과 구성원 체크포인트, Whisper config/tokenizer/vocabulary, 전이적 VAD·사전 등 실행에 필요한 리소스도 포함한다. 패키지 안의 보조 자산은 wheel hash에 연결하고 별도 다운로드 파일은 모델 lock에 넣는다. 모델 ID·별칭만 lock으로 인정하지 않는다.

공통 준비 완료 후에만 local loader를 호출한다. HF는 revision과 파일 allowlist로 준비하고 local-only로 로드한다. Demucs·MMS_FA·Beat This!는 설치된 버전의 loader를 조사해 local repository/checkpoint 인자를 사용하거나 좁은 adapter로 연결한다. 준비 이후 네트워크 요청이 발생하면 테스트 실패다. 실제 URL/hash는 구현 때 공식 자산을 확보해 기록하며 스펙에 가짜 값을 넣지 않는다.

다운로드 완료 시와 각 worker 프로세스의 최초 모델 로드 전에 전체 hash를 검증한다. 같은 프로세스에 이미 로드된 모델은 재사용한다. size/mtime marker만으로 전체 검증을 생략하지 않는다. packaged의 모델 환경변수 override는 registry에 등록된 ID만 허용하고 임의 URL/경로·미등록 모델로 우회하지 못하게 한다. dev의 실험 모델은 명시적 개발 경로로 구분하며 배포 검증 대상으로 표시하지 않는다.

2026-09-16 보완: 모델 ID와 artifact ID는 별도 이름 공간으로 해석한다. `beat-this-final0`·`htdemucs`·`hdemucs_mmi`처럼 이름이 같아도 `artifactIds`의 파일 준비를 생략하지 않는다. 실제 lock 전체 모델의 파일 수집 회귀 테스트를 둔다. BPM 준비/실행 실패는 성공 결과로 저장하지 않으며, 002의 분석 버전 3 백필로 기존 실패 기록을 복구한다.

### 4.5 사용자 동작·패키지 계약

준비 상태와 오류 기록의 알림 센터 통합은 `010-notification-center.md`에서 다룬다. 010 구현 시 검색창 아래 준비 배너를 알림 버튼·모달로 옮기며, 이 절의 기존 곡 재생·필요 작업 차단·실패 안내 계약은 유지한다.

007 DB 준비 성공 후 라이브러리 화면을 열 수 있다. runtime 준비 실패는 기존 곡 재생·메타 조회를 막지 않고 runtime 필요 작업을 차단/안내한다. 최초 빈 라이브러리는 준비 진행을 표시한다. 모델은 필요한 작업에서만 준비하고 전체 모델을 앱 시작에 내려받지 않는다. 검증 실패를 GPU 실패로 취급해 CPU/다른 모델로 우회하지 않는다.

바이너리는 앱 세션의 최초 실행 전에 전체 검증한다. IPC로 임의 URL·해시·실행 경로를 받지 않고 앱이 소유한 manifest ID만 해석한다. 오류에는 논리 ID·단계·재시도 가능 여부를 포함하고 정상 캐시 삭제나 라이브러리 초기화를 요구하지 않는다.

ZIP·APPX의 capability 분기는 001을 따른다. APPX에서 의도적으로 빠진 yt-dlp는 오류가 아니며, manifest상 필수 파일 누락/변조는 조용히 기능을 숨기는 대신 오류로 처리한다. 로컬 lock 검증 도구는 라이선스 고지와 최종 패키지 inventory도 검사한다. 후속 코드 서명으로 바이트가 바뀌면 최종 artifact hash를 다시 생성하고 검증하는 순서를 지켜야 한다.

### 4.6 구현 슬라이스

| 슬라이스 | 산출물                                                       | 소유(수정 가능) 경로                                                                                                                                                                                                                                                            | 수정 금지 경로            | 선행 조건                                    | 상태 |
| -------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- | -------------------------------------------- | ---- |
| L1       | schema·검증/갱신 후보 CLI·다운로드 검증·외부 lock·wheel 준비 | `build/locks/`, `scripts/runtime-lock/`, `scripts/prepare-resources.mjs`, `scripts/__tests__/runtime-lock/`                                                                                                                                                                     | 앱·sidecar 코드·루트 설정 | 없음; schema 계약 먼저 확정                  | 완료 |
| L2       | Python 환경 준비·manifest 대조·Main runtime 검증             | `src/main/sidecar/`, 신규 `src/main/runtime/`, 신규 `src/main/__tests__/runtime/`                                                                                                                                                                                               | L1·L3·공유 진입점         | L1, 007 D1·D2                                | 완료 |
| L3       | 모델 registry·local loader·offline 검증                      | `sidecar/src/`, `sidecar/tests/`, `sidecar/pyproject.toml`, `sidecar/uv.lock`, `sidecar/.python-version`                                                                                                                                                                        | Main·lock 파일            | L1 schema; lock 자산 갱신은 L1 소유자가 수행 | 완료 |
| L4       | 앱 시작/IPC/UI·타깃 패키징·최종 통합                         | `src/main/index.ts`, `src/main/ipc.ts`, `src/main/library/YtDlpService.ts`와 전용 테스트, `src/preload/`, `src/shared/`, `src/renderer/`, `package.json`, `pnpm-lock.yaml`, `electron-builder.yml`, `electron-builder.zip.mjs`, `electron-builder.msix.mjs`, `vitest.config.ts` | L1–L3 소유 경로           | L1–L3, 007 D2                                | 완료 |
| L5       | 통합 실험·운영 문서·증거                                     | 신규 `scripts/runtime-acceptance/`, 신규 `docs/runtime-lock.md`, `docs/specs/008-runtime-dependency-lock.md`, `docs/specs/001-packaging-distribution.md`, `docs/specs/README.md`                                                                                                | 기능 코드·lock 파일       | L1–L4                                        | 완료 |

판정: L1 = 기준 1–3·11의 lock/빌드 계층, L2 = 기준 3–5·8의 Main 계층, L3 = 기준 6–8 모델 계층, L4 = 기준 9–10, L5 = 기준 1–11 통합 증거. 패키지 변경 후 wheel lock 재계산 등 교차 수정은 소유자에게 순서대로 전달한다. 007과 공유하는 `index.ts`·스펙 인덱스는 007 완료 후 수정한다. 생성 `resources/`는 파일 소유 편집 대신 L4 빌드로 생성한다.

직접 순차 구현을 기본으로 하며, 멀티 에이전트 실행 요청 시 `orchestrate-slices`를 사용한다. 종료 전 §5 명령과 exit code를 보고하고 훅 우회(`--no-verify`, `LEFTHOOK=0`)를 금지한다. git 상태 변경(commit/stage)은 사용자 또는 명시적으로 승인받은 감독자만 수행한다. 완료 슬라이스는 임의 재작업하지 않는다.

## 5. 검증 방법

fixture 시험은 소형 합성 자산·로컬 HTTP 서버를 쓰고 실제 수 GB 모델 시험과 구분한다.

```bash
# 기준 1·3·11: schema·source lock 일치·배포 입력 확인, 파일 변경 없음
node scripts/runtime-lock/cli.mjs verify
# 기준 11: 실제 lock을 바꾸지 않는 명시적 갱신 후보 생성
node scripts/runtime-lock/cli.mjs propose --output dist/lock-candidate
# 기준 1–5·8·10: Main·CLI fixture 및 기존 동작 회귀
pnpm test
pnpm typecheck
# 기준 6–8: 모델 local adapter·hash·네트워크 우회 차단 fixture
uv run --project sidecar --locked pytest sidecar/tests
# 기준 9: 실제 타깃 빌드 후 최종 구성 검증
pnpm build:zip
node scripts/runtime-lock/cli.mjs verify-package --target zip --input dist
pnpm build:msix
node scripts/runtime-lock/cli.mjs verify-package --target appx --input dist
# 기준 3–10: 별도 테스트 데이터 디렉터리, 실제 자산 opt-in 시험
node scripts/runtime-acceptance/run.mjs --real-assets --data-dir dist/runtime-acceptance
```

- 기본 fixture 시험은 잘못된 hash·경로 탈출·일시 파일·동시 요청·대기자별 취소·Windows 파일 잠김·준비 도중 종료·새 앱/구 환경 mismatch를 포함한다. 프로세스 강제 종료는 테스트 전용 디렉터리에서만 한다.
- 실제 자산 시험은 빈 캐시 준비, 기존 캐시 재사용, 선택 가능한 모든 모델 최소 실행, 네트워크 차단 후 재실행, 이전 환경 보존, URL 도구 검증을 기록한다. 모델명별 수행/미수행과 다운로드·검증 시간/디스크 사용량을 남긴다.
- 수동: 패키징 앱에서 의존성 실패 시 기존 완료 곡 재생, 작업 차단·재시도, 진행 단계, ZIP/APPX capability를 확인한다. 패키지 검사만으로 GPU·YouTube·실제 기기 동작을 통과했다고 보고하지 않는다.
- 검증 결과 (2026-09-16):

| 기준 | 상태                    | 근거                                                                                                           |
| ---- | ----------------------- | -------------------------------------------------------------------------------------------------------------- |
| 1    | fixture 통과            | `cli.mjs verify` exit 0, schema/missing-hash/host 테스트. lock 미수정                                          |
| 2    | fixture 통과            | 1바이트 변조·truncated·ZIP 탈출/symlink/대소문자/비허용 exe. `--version` 전 hash                               |
| 3    | lock+코드 통과          | CPython 3.12.14+20260901 inventory, win32 x64 wheels.lock ↔ uv.lock. 실기기 offline 설치는 패키징 앱 확인 대기 |
| 4    | 단위 통과               | sidecar digest에 `.python-version` 포함. `.ready`/`.venv`만으로 ready 아님                                     |
| 5    | 단위 통과               | 실패 시 이전 포인터 유지, 성공 시에만 swap, manifest mismatch 거부                                             |
| 6    | lock+registry 통과      | Demucs 5·whisper turbo·MMS_FA·Beat This! `final0` 목록·hash 채택                                               |
| 7    | fixture 통과            | 가중치/config 변조, 네트워크 차단 후 로컬 로드. 실모델 최소 실행은 `--real-assets` 대기                        |
| 8    | fixture 통과            | digest single-flight, waiter별 취소, incomplete 미게시                                                         |
| 9    | fixture 통과, 실팩 대기 | extraResources zip/appx 분기 + `verify-package` fixture. `pnpm build:zip`/`build:msix` 실바이트는 미실행       |
| 10   | 단위+UI 코드 통과       | 라이브러리는 runtime 준비 전에도 열림. 런타임 필요 작업만 차단. 패키징 앱 수동 확인 대기                       |
| 11   | 통과                    | `propose`는 `--output`만 기록. verify 자동 수용 없음                                                           |

전체 실자산·패키징 바이트 검증 없이 이 스펙을 구현 완료로 표시하지 않는다.
