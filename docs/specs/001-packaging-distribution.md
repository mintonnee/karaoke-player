# Karaoke Player 패키징·배포 스펙

- 작성일: 2026-09-02
- 연관 스펙: `000-karaoke-app-spec-draft.md`
- 대상: 000 §5 S7(패키징) 전체, 그리고 000 §2·§7의 "URL 다운로드 하지 않음" 결정 변경

이 문서는 000에서 미뤄 둔 S7(패키징)을 zip/MSIX 이중 타깃으로 구체화하고, 비목표였던 YouTube URL 임포트를 zip 배포 채널 한정 기능으로 되돌린 결정을 다룬다. macOS/Linux 패키징, 자동 업데이트, v2 기능(마이크/채점)은 다루지 않는다.

후속 설계 [`008-runtime-dependency-lock.md`](008-runtime-dependency-lock.md)는 §4.1–4.3의 Python·모델·외부 실행 파일 다운로드를 hash lock과 검증 후 활성화 방식으로 강화한다. 구현 완료 후 파일 존재 기반 캐시 재사용·기존 venv 직접 sync·라이브러리 임의 모델 다운로드·준비 실패 시 전체 화면 차단 계약을 대체한다. 현재 아래 구현 기록은 001 당시 동작이며 008은 구현 미착수다. CI·릴리즈·자동 업데이트는 계속 별도 범위로 둔다.

## 1. 목표와 비목표

```text
클린 Windows 머신에서 zip을 풀거나 MSIX를 설치해 앱을 실행하면 첫 실행 부트스트랩을 거쳐
곡 하나를 임포트 → 분리 → 재생까지 완료할 수 있고, zip판에서는 YouTube URL 입력으로도
같은 파이프라인이 시작된다.
```

**목표**

| 영역                | 내용                                                                                                                  |
| ------------------- | --------------------------------------------------------------------------------------------------------------------- |
| 사이드카 부트스트랩 | `uv.exe`와 sidecar 프로젝트 파일만 동봉하고, 첫 실행 시 사용자 쓰기 가능 경로에 `uv sync`로 환경 구성. 진행 UI 제공   |
| 이중 타깃 빌드      | electron-builder로 `zip`(포터블, 무서명)과 `appx`(MSIX, Store 제출용) 두 타깃. 공통 설정 + 리소스 분기                |
| yt-dlp 분기         | zip에만 `yt-dlp.exe`와 `deno.exe`(JS 챌린지 런타임) 동봉. 앱은 실행 시 리소스 존재 여부로 URL 임포트 기능을 켜고 끈다 |
| URL 임포트          | YouTube URL 입력 → yt-dlp로 오디오 다운로드 → 기존 임포트 파이프라인(`importFiles`)에 연결                            |
| 제품 정체성         | 창 제목/제품명/아이콘을 "Karaoke Player"로 정리 (Store 제출 요건)                                                     |

**비목표**

| 항목                           | 제외 이유                                                                                           |
| ------------------------------ | --------------------------------------------------------------------------------------------------- |
| macOS/Linux 패키징             | 000 §2 "Windows 우선" 결정, §8 미정 항목 유지                                                       |
| 자동 업데이트                  | v1 범위 밖. 수동 재설치로 충분, 도입 시 별도 스펙                                                   |
| MSIX에 yt-dlp 포함             | Microsoft Store 정책상 YouTube 다운로드 도구는 거부 사유. 채널 분리가 이 스펙의 전제                |
| 모델(Demucs/whisper) 사전 번들 | 각 라이브러리의 자체 다운로드 캐시(torch hub/HF)를 첫 실행 시 사용. 번들 시 배포물이 GB 단위로 커짐 |
| zip 코드 서명                  | 포터블 zip은 무서명으로 배포하고 SmartScreen 경고를 감수한다. 서명은 Store(MSIX) 쪽에서 해결        |
| yt-dlp 포맷/화질 선택 UI       | 오디오만 필요. `bestaudio[ext=m4a]` 고정 (§4.3), 영상 다운로드는 핵심 가치와 무관                   |
| ffmpeg 동봉                    | m4a 직접 다운로드로 회피 (§4.3). m4a 미제공 영상 대응이 필요해지면 결정 변경으로 추가               |

**결정 변경 기록**: 000 §2·§7은 "URL 다운로드 → 하지 않음(법적 리스크)"이었다. 2026-09-02 사용자 결정으로 뒤집는다 — 개인 사용 목적이고, 리스크는 배포 채널 분리(zip 한정, Store판 제외)로 관리한다. 000 §7에도 이 변경을 기록한다.

## 2. 성공 기준

1. `pnpm build:zip`이 `dist/`에 zip을 생성하고, 압축 안에 `resources/bin/uv.exe`, `resources/bin/yt-dlp.exe`, `resources/bin/deno.exe`, `resources/sidecar/`(pyproject.toml, uv.lock, src/)가 있으며 `.venv`/`__pycache__`는 없다.
2. `pnpm build:msix`가 `dist/`에 appx 패키지를 생성하고, 패키지 안에 `yt-dlp.exe`가 없다 (그 외 리소스 구성은 기준 1과 동일).
3. venv가 없는 상태(첫 실행 또는 `<userData>/sidecar` 삭제 후)에서 패키징된 앱을 실행하면 부트스트랩 UI가 단계/진행 상태를 표시하고, 완료 후 로컬 파일 임포트 → 분리 → 재생이 동작한다.
4. 부트스트랩 완료 후 앱을 재시작하면 부트스트랩 UI 없이 즉시 라이브러리 화면이 뜬다 (venv 재사용, 준비 판정은 프로젝트 해시 마커).
5. zip판에서 YouTube URL을 입력하면 다운로드 진행률이 표시되고, 완료 시 트랙이 라이브러리에 추가되며 기존 파이프라인(분리 → 가사)이 자동 시작된다. 트랙 커버로 YouTube 썸네일이 표시된다.
6. yt-dlp 리소스가 없는 실행(MSIX판 또는 dev에서 리소스 미배치)에서는 URL 임포트 UI가 렌더링되지 않는다.
7. 부트스트랩 실패(네트워크 차단으로 재현) 시 오류 메시지와 재시도 버튼이 표시되고 앱이 크래시하지 않는다. 재시도로 이어서 진행할 수 있다.
8. `pnpm dev`는 기존과 동일하게 동작한다 — 레포의 `sidecar/`를 `uv run`으로 실행하고 부트스트랩을 건너뛴다.

## 3. 전제 조건

| 전제                                        | source of truth / 확인 방법                                                                                                              |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| electron-builder ^26 (zip·appx 타깃 지원)   | `package.json` devDependencies                                                                                                           |
| uv 단일 바이너리 재배포 가능 (MIT/Apache-2) | astral-sh/uv releases의 `uv-x86_64-pc-windows-msvc.zip`                                                                                  |
| yt-dlp 단일 exe 재배포 가능 (Unlicense)     | yt-dlp/yt-dlp releases의 `yt-dlp.exe`. EJS 챌린지 솔버 스크립트는 이 바이너리에 번들됨 (yt-dlp wiki/EJS)                                 |
| YouTube 다운로드에 외부 JS 런타임 필수      | yt-dlp 공지 #15012 (2025-11). Deno ≥2.3.0 단일 exe(MIT) 동봉, `--js-runtimes deno:<경로>`로 지정. 샌드박스 실행(파일/네트워크 권한 없음) |
| sidecar Python >=3.11,<3.13                 | `sidecar/pyproject.toml`. uv가 관리형 Python을 자동 설치하므로 시스템 Python 불요                                                        |
| torch cu128 인덱스 접근                     | `sidecar/pyproject.toml` `[tool.uv.sources]`. 부트스트랩은 네트워크 필수                                                                 |
| SidecarManager가 command/baseArgs 주입 구조 | `src/main/sidecar/SidecarManager.ts` `SidecarManagerOptions`                                                                             |
| MSIX 설치 디렉토리는 읽기 전용              | venv·복사본·캐시는 `<userData>`/`LOCALAPPDATA` 아래에만 쓴다                                                                             |
| Store 계정과 identity 값                    | Partner Center에서 발급 (사용자 준비). 발급 전에는 placeholder로 빌드만 통과                                                             |
| mutagen이 m4a probe 가능                    | 기존 임포트가 m4a를 지원 (`src/main/ipc.ts` AUDIO_FILE_FILTERS)                                                                          |

## 4. 기능 범위

### 4.1 사이드카 부트스트랩

- 번들 리소스: `resources/sidecar/`(pyproject.toml, uv.lock, `src/karaoke_worker/`), `resources/bin/uv.exe`. 리소스 준비는 빌드 전 스크립트가 레포 `sidecar/`에서 `.venv` 등을 제외하고 복사한다.
- 첫 실행 시 sidecar 프로젝트를 `<userData>/sidecar`로 복사하고 `uv sync --project <userData>/sidecar`를 실행한다. `UV_CACHE_DIR`·`UV_PYTHON_INSTALL_DIR`도 사용자 쓰기 가능 경로로 고정한다 (MSIX 읽기 전용 제약).
- 준비 판정: sync 성공 시 `<userData>/sidecar/.ready`에 `src/`·`pyproject.toml`·`uv.lock`의 경로와 내용으로 계산한 해시를 기록한다. 소스 추가·변경·삭제 또는 설정·lock 변경 시 재복사·재sync하며 `.venv`와 다운로드 캐시는 보존한다. 기존 lock 전용 마커도 한 번 갱신한다. 캐시·pyc 등 복사 제외 항목은 해시에 포함하지 않는다.
- `SidecarManager` 생성 분기: `app.isPackaged`이면 번들 `uv.exe` + `<userData>/sidecar`, dev이면 기존 `createUvSidecarManager(레포 sidecar)`.
- 진행 UI: 부트스트랩 중에는 라이브러리 대신 전용 화면을 표시한다. uv 출력의 정밀 파싱은 요구하지 않는다 — 단계 텍스트 + 불확정 진행 표시로 충분하다. **성공 기준(3·4·7)이 우선이고 구현 방식은 자유다.**
- 모델 다운로드(Demucs/whisper)는 부트스트랩 범위 밖 — 기존처럼 첫 separate/transcribe 실행 시 각 라이브러리가 내려받는다.

### 4.2 electron-builder 이중 타깃

- `package.json`에 `build:zip`/`build:msix` 스크립트를 추가한다. 설정은 공통 베이스 + 타깃별 오버레이(`electron-builder --config` 분기 또는 env 조건) — 방식은 자유.
- zip 타깃: `win.target=zip`, extraResources = `bin/uv.exe`, `bin/yt-dlp.exe`, `bin/deno.exe`, `sidecar/`.
- msix 타깃: `win.target=appx`, extraResources에서 `yt-dlp.exe` 제외. appx identity(applicationId, publisher, publisherDisplayName)는 Partner Center 발급값 주입 지점을 만들고 발급 전에는 placeholder를 쓴다.
- 제품 정체성: productName "Karaoke Player", 창 제목, 아이콘 세트(ico + appx 타일)를 정리한다.
- `uv.exe`/`yt-dlp.exe` 바이너리는 레포에 커밋하지 않는다 — 빌드 전 스크립트가 릴리즈 URL에서 받아 `resources/bin/`에 배치하고, 해당 경로는 `.gitignore`에 추가한다.
- 서드파티 고지: `pnpm gen:notices` 산출물을 배포물 루트에 `THIRD-PARTY-NOTICES.txt`로 복사하고, zip 동봉 바이너리(uv/deno/yt-dlp)의 라이선스 전문을 P4에서 보충한다. 앱 내 설정 화면(크레딧·이슈 트래커·라이선스 뷰어)은 2026-09-02 선구현됨 — P4는 배포물 측 완성만 담당한다.

### 4.3 URL 임포트 (zip 전용)

- 활성화 조건: 메인 프로세스가 시작 시 `resources/bin/yt-dlp.exe`와 `resources/bin/deno.exe` **둘 다** 존재하는지 확인해 preload 플래그로 렌더러에 노출한다. dev에서는 `resources/bin`에 두 파일을 두면 켜진다 (기준 6의 dev 검증 경로).
- UI: 기존 구현은 라이브러리 패널 헤더의 `+ 가져오기` 옆에 URL 입력 진입점을 둔다. `004-import-dialog.md` 구현 시 가져오기 팝업의 YouTube 방식으로 통합한다 (현재 구현 미착수). 다운로드 중에는 진행률(yt-dlp stdout의 `%` 파싱)을 표시하며 capability에 따른 미노출 계약은 유지한다.
- 다운로드: `yt-dlp -f "bestaudio[ext=m4a]" --no-playlist --write-thumbnail --js-runtimes deno:<resources>/bin/deno.exe -o <scratch>/%(title)s [%(id)s].%(ext)s <url>`. m4a 고정으로 ffmpeg 동봉을 회피하고, JS 런타임은 동봉 `deno.exe`를 경로로 지정해 PATH에 의존하지 않는다. m4a 미제공 영상은 오류로 안내한다 (비목표 표 참조).
- 커버: YouTube m4a에는 내장 앨범 아트가 없으므로 `--write-thumbnail`로 받은 썸네일 파일(보통 webp)을 임포트 성공 후 `tracks/<id>/cover.jpg`로 복사한다. 파일명은 확장자와 무관하게 고정한다 — 렌더러 `<img>`가 매직 바이트로 포맷을 판별하는 기존 관례(사이드카 `cover` 명령과 동일). 썸네일 변환(`--convert-thumbnails`)과 태그 내장(`--embed-thumbnail`)은 ffmpeg가 필요해 쓰지 않는다. 기존 `CoverService`는 내장 아트 부재 시 `cover.none` 마커만 남기고 `cover.jpg`를 쓰지 않으므로 충돌이 없다.
- 완료된 파일 경로를 기존 `importService.importFiles([path])`에 전달한다 — probe/분리/가사 파이프라인은 수정하지 않는다. 임포트 성공 후 스크래치 파일은 삭제한다 (원본은 §4.3 데이터 레이아웃대로 트랙 디렉토리에 복사돼 있음).
- 실패(잘못된 URL, 지역 제한, m4a 없음)는 기존 임포트 거부(`rejections`) UI로 표면화한다.

### 4.4 구현 슬라이스

| 슬라이스 | 산출물                                                          | 소유(수정 가능) 경로                                                                                                                                                                                                                                                                                                                           | 수정 금지 경로                                                                         | 선행 조건                                          | 상태 |
| -------- | --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | -------------------------------------------------- | ---- |
| P1       | 부트스트랩 서비스 + UI + 경로 분기                              | `src/main/sidecar/SidecarBootstrap.ts`(신규), `src/main/paths.ts`(신규, 번들 리소스 경로 헬퍼), `src/main/sidecar/SidecarManager.ts`(env 주입), `src/main/index.ts`, `src/preload/index.ts`, `src/shared/types.ts`, `src/renderer/src/components/Bootstrap*.tsx`(신규), `src/renderer/src/App.tsx`, `src/renderer/src/assets/main.css`(추가만) | `sidecar/**`, `electron-builder*`                                                      | 없음                                               | 완료 |
| P2       | 빌드 설정 + 리소스 준비 스크립트                                | `electron-builder.yml`(공통 베이스), `electron-builder.{zip,msix}.mjs`(신규), `package.json`, `scripts/prepare-resources.mjs`(신규), `.gitignore`, `resources/bin/**`·`resources/sidecar/**`(스테이징 산출물)                                                                                                                                  | `src/**`                                                                               | P1과 병렬 가능 (리소스 경로 규약 §4.1·§4.2 합의됨) | 완료 |
| P3       | URL 임포트 서비스 + UI                                          | `src/main/library/YtDlpService.ts`(신규), `src/main/ipc.ts`, `src/renderer/src/components/UrlImport*.tsx`(신규), `src/renderer/src/stores/libraryStore.ts`, P1 완료 후 `src/main/index.ts`(배선만)·`src/preload/index.ts`·`src/shared/types.ts`·`src/renderer/src/App.tsx`(헤더 진입점만)·`main.css`(추가만)                                   | `src/main/sidecar/**`, `src/main/library/{ImportService,CoverService,LibraryStore}.ts` | P1 완료 (preload/types 공유 파일 충돌 회피)        | 완료 |
| P4       | Store 메타·아이콘·창 제목, THIRD-PARTY-NOTICES 완성·배포물 포함 | `build/**`(아이콘·appx 타일), `resources/icon.png`, `scripts/generate-icons.py`(신규), `scripts/generate-notices.mjs`, `scripts/licenses/**`, `src/renderer/src/generated/third-party-notices.txt`, `src/renderer/index.html`(제목만), `electron-builder.yml`·`electron-builder.msix.mjs`(P2 완료 후 표시·에셋 관련만)                         | 그 외 전부 (창 제목 `BrowserWindow.title`은 P1이 처리)                                 | P1·P2 완료                                         | 완료 |

- 슬라이스 완료 판정: P1 = 기준 3·4·7·8, P2 = 기준 1·2, P3 = 기준 5·6, P4 = 기준 2 보조(identity)와 제품 정체성.
- 공유 파일 소유: `package.json`은 P2, `src/main/index.ts`·`src/preload/index.ts`·`src/shared/types.ts`는 P1, `src/main/ipc.ts`는 P3. 다른 슬라이스가 이 파일들을 수정해야 하면 감독자가 순서를 정한다.
- 감독 규칙: 각 에이전트는 종료 전 §5의 자동 검증 명령을 실행하고 exit code를 보고한다. 훅 우회(`--no-verify`, `LEFTHOOK=0`) 금지. git 상태 변경(commit/stage)은 감독자 또는 사용자만 수행한다. 완료된 슬라이스는 재작업하지 않는다.
- 이 표를 실행할 때는 `orchestrate-slices` 스킬을 사용한다.

### 4.5 구현 기록 (2026-09-02, 멀티 에이전트 실행 결과)

- **부트스트랩 (P1)**: 준비 판정은 `<userData>/sidecar/.ready`의 번들 프로젝트 해시 일치 **AND** `.venv` 존재. sync는 `uv sync --project <dir> --frozen`(번들 lock 그대로 설치), 워커 실행은 `uv run --project <dir> --no-sync karaoke_worker`(매 실행 네트워크·lock 검사 없음). env는 `UV_CACHE_DIR`·`UV_PYTHON_INSTALL_DIR`에 더해 `UV_MANAGED_PYTHON=1`(시스템 Python 무시)·`UV_NO_PROGRESS=1`. 재복사 시 `.venv`는 남겨 이어받기. 마커는 sync 성공 경로에서만 기록. 상태 IPC: `bootstrap:get`/`bootstrap:retry`/`bootstrap:state`, 렌더러는 ready 전까지 `BootstrapScreen`만 렌더.
- **빌드 (P2)**: 공통 `electron-builder.yml` + `extends: 'file:...'`로 상속하는 `electron-builder.{zip,msix}.mjs`. appx identity는 `APPX_IDENTITY_NAME`/`APPX_PUBLISHER`/`APPX_PUBLISHER_DISPLAY_NAME`/`APPX_APPLICATION_ID` env로 주입, 미설정 시 placeholder. `files`에서 `sidecar/**`(레포 .venv 수 GB)·`resources/bin/**`·`resources/sidecar/**` 제외. 고정 바이너리: uv 0.12.9, yt-dlp 2026.08.19, deno 2.9.6 (`scripts/prepare-resources.mjs` 상수). deno는 MSIX에도 포함(제외 대상은 yt-dlp뿐, 활성화 조건이 "둘 다"라 URL UI는 켜지지 않음). `sidecar/.python-version`도 스테이징. `publish`·nsis 섹션 제거.
- **URL 임포트 (P3)**: yt-dlp 인자 `--encoding utf-8 -f bestaudio[ext=m4a] --no-playlist --write-thumbnail --no-mtime --newline --progress --print after_move:filepath --print "after_move:__artist__=%(artist,channel,uploader|)s" --print "after_move:__title__=%(title|)s" --js-runtimes deno:<binDir>deno.exe -o <scratch>%(title)s [%(id)s].%(ext)s <url>`. `--js-runtimes`는 백슬래시 절대 경로여야 인식됨(라이브 확인). 진행률은 `[download]  NN.N%` 파싱 → `library:url-import-progress`. 기능 플래그는 `app:capabilities` IPC. 커버 복사 후 `updatedAt`을 굴려(`store.updateMeta` 재호출) 렌더러 `CoverArt` 캐시 키를 바꾼다. URL은 `^https?://`만 허용(argv 주입 차단).
- **정체성·고지 (P4)**: 아이콘은 `uv run --with pillow python scripts/generate-icons.py`로 재생성(ico 7사이즈, appx 타일 6종 — 310×310은 electron-builder 규약상 `LargeTile.png`). `asarUnpack: resources/**` 제거(`?asset` import는 asar 내부 경로를 그대로 참조하고 Linux 분기에서만 쓰임). `scripts/licenses/`에 uv(MIT+Apache-2.0)·deno(MIT)·yt-dlp(Unlicense) 전문 추가.

## 5. 검증 방법

```bash
pnpm typecheck && pnpm lint && pnpm test   # 회귀 — 모든 기준의 공통 전제
pnpm build:zip                              # 기준 1 — dist/*.zip 생성 후 압축 내용 검사
pnpm build:msix                             # 기준 2 — dist/*.appx 생성 후 패키지 내용 검사
pnpm dev                                    # 기준 8 — 기존 dev 흐름 회귀
```

- 기준 1·2의 내용 검사: 생성물 압축을 풀어 `resources/bin/`, `resources/sidecar/` 구성과 yt-dlp 포함 여부를 육안/스크립트로 확인한다.
- 기준 3·4·7 (수동): `<userData>/sidecar`를 삭제한 뒤 zip판 실행 → 부트스트랩 관찰 → 로컬 파일 임포트·재생 → 재시작해 즉시 진입 확인 → 네트워크를 끊고 다시 삭제·실행해 오류/재시도 확인.
- 기준 5 (수동): zip판에서 YouTube URL 임포트 → 진행률 → 분리·가사 자동 진행 확인.
- 기준 6 (수동): `resources/bin/yt-dlp.exe`를 제거한 실행에서 URL UI가 없는지 확인.
- 최종 DoD(000 S7): 클린 Windows 머신(또는 새 사용자 계정)에서 zip 설치 → 첫 곡 처리까지 완료.

**검증 현황 (2026-09-02)**

| 기준 | 상태           | 근거                                                                                                                                            |
| ---- | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | 자동 검증 완료 | `pnpm build:zip` exit 0, `tar -tf`로 bin 3종·sidecar 구성·`.venv`/`__pycache__` 부재·`THIRD-PARTY-NOTICES.txt` 확인                             |
| 2    | 자동 검증 완료 | `pnpm build:msix` exit 0, appx에 yt-dlp 0건, AppxManifest identity placeholder·타일 에셋 확인                                                   |
| 3    | 수동 확인 완료 | 2026-09-02 zip판을 `%USERPROFILE%\.local\share`에 풀어 실행, 첫 실행 부트스트랩(복사 → uv sync → 라이브러리 진입) 확인                          |
| 4·7  | 수동 검증 대기 | 단위 테스트(SidecarBootstrap 14건)로 마커 판정·복사 필터·성공/실패/재시도 전이는 커버. 재시작 즉시 진입·네트워크 차단 재시도는 사용자 확인 대기 |
| 5    | 부분 검증      | yt-dlp 라이브 스모크(다운로드·썸네일·진행률 줄·실패 사유) 통과. 앱 내 전 과정은 수동 확인 대기                                                  |
| 6    | 단위 검증      | 플래그 판정 테스트 + 렌더러가 `urlImportAvailable=false`면 진입점 미렌더. 실행 확인은 수동                                                      |
| 8    | 수동 검증 대기 | dev 분기는 `createReadyBootstrap()` + 기존 `createUvSidecarManager` 유지. `pnpm dev` 실행 확인은 사용자                                         |
