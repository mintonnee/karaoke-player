# Karaoke Player NSIS 설치 파일·런타임 도구 다운로드 스펙

- 작성일: 2026-09-18
- 연관 스펙: `001-packaging-distribution.md`, `008-runtime-dependency-lock.md`, `010-notification-center.md`, `007-db-schema-safety.md`
- 대상: 001 S7 패키징의 NSIS 채널 추가와 008 uv·Deno·yt-dlp 배포 방식 확장
- 상태: 코드 구현·자동 검증·NSIS 빌드 완료, Windows VM·실제 설치 앱 인수 시험 대기

이 문서는 001의 패키징 범위에서 Windows x64 NSIS `.exe` 설치 파일과, 008의 lock을 이용한 첫 앱 실행 시 도구 다운로드를 다룬다. 기존 ZIP/APPX의 번들 구성, Python·wheel·모델 준비 계약과 자동 업데이트는 변경하지 않는다.

## 1. 목표와 비목표

```text
사용자는 uv·Deno·yt-dlp가 포함되지 않은 NSIS 설치 파일로 앱을 설치하고, 첫 실행에서 고정 버전의 도구를 검증 다운로드한 뒤 로컬 곡과 YouTube 곡을 가져올 수 있으며 준비 실패 중에도 기존 완료 곡을 재생할 수 있다.
```

| 영역      | 목표                                                                                     |
| --------- | ---------------------------------------------------------------------------------------- |
| 설치      | 일반 사용자 권한으로 설치·수동 업그레이드·제거 가능한 Windows x64 NSIS 산출물을 제공한다 |
| 경량 배포 | NSIS에는 도구 바이너리나 이를 담은 ZIP을 넣지 않고 lock·manifest·sidecar 입력을 담는다   |
| 초기화    | 첫 앱 실행에서 정확한 GitHub Release 자산을 받고 검증된 사용자 경로만 실행한다           |
| 복구      | 다운로드 실패·변조·앱 종료에 안전하게 재시도하고 정상 캐시를 재사용한다                  |
| 기능 상태 | 배포 채널의 지원 여부와 현재 도구 준비 상태를 분리한다                                   |

| 비목표                                             | 제외 이유                                                                             |
| -------------------------------------------------- | ------------------------------------------------------------------------------------- |
| ZIP/APPX의 다운로드 전용 전환                      | 기존 채널 배포 계약을 유지하며 새 설치 채널에 한정해 도입한다                         |
| `nsis-web` 설치 파일                               | Electron 앱 자체는 설치 파일에 포함하고 외부 도구만 앱 초기화에서 받는다              |
| 앱 자동 업데이트·원격 lock 갱신·도구 자체 업데이트 | 앱과 의존성의 검증 조합을 유지한다. 이번 업데이트 수단은 새 설치 파일의 수동 실행이다 |
| CI·Release 게시·코드 서명 인증서 도입              | 이 문서는 로컬 패키징과 검증 계약까지 정한다. 서명·게시 인프라는 준비되지 않았다      |
| 최초 완전 오프라인 환경 구성                       | 세 도구와 Python·wheel·모델의 최초 취득에는 네트워크가 필요하다                       |
| Windows ARM64·전체 사용자 설치·임의 설치 경로 UI   | 현재 Windows x64와 사용자별 데이터 경로를 유지해 설치 동작을 한정한다                 |

## 2. 성공 기준

1. `pnpm build:nsis`가 `dist/nsis/`에 `karaoke-player-<version>-win-x64-setup.exe`를 생성한다. 별도 `build:unpack:nsis`가 동일한 입력으로 설치 전 앱 디렉터리를 만든다. 두 명령 모두 검증된 lock을 변경하거나 uv·Deno·yt-dlp 자산을 내려받지 않는다.
2. 빈 `resources/bin`과 기존 도구가 남아 있는 `resources/bin` 양쪽에서 NSIS를 빌드해도 최종 앱·설치 payload·asar/unpacked에 세 도구, uv의 부속 exe, 해당 도구 ZIP 또는 빌드 캐시가 포함되지 않는다. lock·manifest·sidecar·라이선스 고지는 포함된다.
3. uv·Deno·yt-dlp·Python을 설치하지 않은 Windows 11 x64 일반 사용자 계정에서 앱 설치가 완료된다. 설치 중 네트워크를 차단해도 설치는 끝나며 도구 다운로드는 앱 실행 이후에만 발생한다.
4. 빈 앱 캐시로 첫 실행하면 lock에 기록된 세 도구의 버전 고정 URL만 요청한다. checksum API·`latest`·원격 설치 스크립트·시스템 PATH의 도구를 사용하지 않고, archive와 실행 파일의 크기·SHA-256 검증 후에만 실행한다.
5. 초기화 완료 후 같은 manifest로 재시작하면 도구 자산 다운로드 요청은 0건이다. 캐시와 활성 파일을 재검증하며 1바이트 변조·잘린 다운로드·압축 경로 탈출·예상 외 exe를 거부한다. 검증 실패 파일은 `--version`으로도 실행하지 않는다.
6. 다운로드 중 종료, 네트워크 차단, GitHub 404/403/429/5xx, 디스크 부족, 파일 잠김에서 준비 완료를 표시하지 않는다. 재시도는 고정 버전만 사용하며 기존 정상 도구·Python 환경·곡 데이터는 보존된다. 동시 요청과 취소는 008의 single-flight 계약을 만족한다.
7. 도구가 아직 없는 NSIS에서도 YouTube 지원 UI가 보이고 준비 상태를 안내한다. 준비 완료·재시도 성공 직후 앱 재시작 없이 미리보기와 URL 가져오기를 사용할 수 있다. APPX는 사용자 캐시에 yt-dlp가 있어도 지원하지 않으며 이를 다운로드하거나 실행하지 않는다.
8. Deno·yt-dlp 준비 실패만으로 Python 준비 성공 상태를 실패로 덮어쓰지 않는다. 로컬 가져오기 등 Python만 필요한 작업은 계속 가능하고, 모든 준비 실패 중에도 기존 완료 곡 재생은 유지된다. 알림 센터는 실패 도구·단계·실행 가능한 재시도를 표시한다.
9. 같은 사용자에게 다음 앱 버전을 설치해도 설치 항목이 중복되지 않고 DB·곡·설정·검증 캐시가 남는다. 도구 lock이 바뀌면 새 digest 경로를 준비하며 이전 정상 파일을 덮어쓰지 않는다. 제거 후에도 사용자 데이터가 남고 재설치 후 사용할 수 있다.
10. 최종 패키지 검증은 NSIS 정책·lock digest·sidecar digest·manifest와 실제 payload를 대조한다. 누락/불일치/금지 바이너리를 주입한 fixture는 exit 1, 정상 fixture는 exit 0이다. 기존 ZIP/APPX 구성·capability 회귀 검증도 통과한다.
11. 실제 설치된 앱에서 로컬 파일 가져오기 → 분리 → 재생, YouTube 미리보기 → 가져오기가 성공한다. 설치/도구 검증, Python/모델 검증, 실제 YouTube·GPU 동작의 결과를 각각 기록한다.

## 3. 설계 당시 전제 조건

| 현재 상태 / 전제                                            | source of truth / 확인 방법                                                                     |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| electron-builder는 lockfile 기준 26.15.3                    | `pnpm-lock.yaml`; `package.json` 선언은 `^26.0.12`                                              |
| 현재 `build:zip`, `build:msix`, ZIP용 `build:unpack`만 존재 | `package.json`, `electron-builder.zip.mjs`, `electron-builder.msix.mjs`                         |
| 공통 리소스 함수가 uv·Deno를 항상, yt-dlp를 ZIP에 배치      | `electron-builder.manifest.mjs`의 `extraResourcesFor`                                           |
| 리소스 준비는 모든 tool artifact를 다운로드·검증            | `scripts/prepare-resources.mjs`, `scripts/runtime-lock/prepare.mjs`                             |
| 도구의 고정 URL·크기·archive/내부 exe hash가 이미 존재      | `build/locks/tools.lock.json`, `build/locks/tools.provenance.json`                              |
| 현재 lock 버전은 uv 0.12.9, Deno 2.9.6, yt-dlp 2026.08.19   | 위 lock의 스냅샷이다. 이 스펙 작성으로 버전을 갱신하지 않는다                                   |
| 검증 다운로드·archive 추출·프로세스 잠금 구현이 존재        | `src/main/runtime/{download,zip,lockfile,paths,hosts}.ts`                                       |
| uv 경로를 번들에서 고정하고 URL 서비스를 시작 시 한 번 구성 | `src/main/index.ts`, `src/main/sidecar/SidecarBootstrap.ts`, `src/main/library/YtDlpService.ts` |
| manifest v1에 채널·tool delivery·capability 필드가 없음     | `src/main/runtime/manifest.ts`, `electron-builder.manifest.mjs`                                 |
| 기존 패키지 CLI는 ZIP/APPX 디렉터리 구성만 검사             | `scripts/runtime-lock/{cli,package}.mjs`; NSIS·최종 바이트 검증은 추가 필요                     |
| DB 준비 완료가 부트스트랩의 선행 조건                       | 007과 `src/main/index.ts`; 실패 시 도구 다운로드도 시작하지 않는다                              |
| 준비 상태 표시는 알림 센터를 사용                           | 010, `src/shared/bootstrap.ts`, renderer `bootstrapStore.ts`                                    |

Context7 도구와 설치된 `ctx7` CLI는 이 세션에서 확인되지 않아 공식 웹 문서와 설치된 26.15.3의 `nsisOptions.d.ts`로 설정을 확인했다. NSIS 웹 문서는 본문 추출이 되지 않아 옵션의 적용 조건은 로컬 타입 선언을 우선했다. [electron-builder NSIS 문서](https://www.electron.build/nsis/)

공식 릴리즈에는 uv Windows ZIP과 `.sha256`, Deno Windows ZIP과 `.sha256sum`, yt-dlp의 `yt-dlp.exe`와 `SHA2-256SUMS`가 있다. GitHub Release asset API도 `digest`와 `size`를 제공한다. 이는 lock 채택 시 대조 자료이며 앱 시작 때 원격 checksum을 신뢰 기준으로 새로 가져오는 설계가 아니다. [uv 고정 릴리즈 자산](https://github.com/astral-sh/uv/releases/expanded_assets/0.12.9), [Deno 고정 릴리즈 자산](https://github.com/denoland/deno/releases/expanded_assets/v2.9.6), [yt-dlp Release Files](https://github.com/yt-dlp/yt-dlp#release-files), [GitHub Release assets API](https://docs.github.com/en/rest/releases/assets)

## 4. 기능 범위

### 4.1 설치 파일과 배포 채널

`electron-builder.nsis.mjs`를 추가하고 공통 `electron-builder.yml`을 상속한다. `win.target`은 `nsis`, 아키텍처는 `x64`, 출력은 `dist/nsis/`, artifact 이름은 `${name}-${version}-win-${arch}-setup.${ext}`로 고정한다. 다른 타깃과 출력 및 manifest staging 경로를 분리해 빌드 순서에 따라 채널 값이 섞이지 않게 한다.

- `nsis.oneClick: true`, `nsis.perMachine: false`, `nsis.deleteAppDataOnUninstall: false`로 사용자별 기본 경로에 설치한다. assisted installer용 `allowElevation`·`allowToChangeInstallationDirectory`는 사용하지 않는다.
- 기존 `appId: com.mintonnee.karaoke-player`, 제품명, 실행 파일명과 앱의 `userData` 결정 방식을 유지한다. 임의의 새 GUID를 매 빌드 생성하지 않는다.
- 시작 메뉴 바로가기를 생성하고 바탕 화면 바로가기는 기본 생성하지 않는다. 완료 후 실행은 자동으로 시작하지 않도록 `runAfterFinish: false`로 정한다. 사용자가 앱을 열면 초기화를 시작한다.
- 설치 프로그램은 앱 파일·바로가기·제거 항목만 다룬다. NSIS custom action에서 다운로드나 Python 환경 구성을 실행하지 않는다.
- 실행 중 재설치는 앱 및 자식 프로세스 종료를 요구한다. 종료하지 못하면 파일 교체를 실패 처리하며 실행 중인 런타임 파일을 강제 삭제하지 않는다.
- 초기 로컬 산출물은 무서명이다. 서명·SmartScreen 신뢰도 검증을 완료했다고 표시하지 않으며, 게시 절차는 이 스펙 구현과 별도로 다룬다.

| 채널                | uv              | Deno            | yt-dlp             | URL 지원             |
| ------------------- | --------------- | --------------- | ------------------ | -------------------- |
| NSIS                | 초기화 다운로드 | 초기화 다운로드 | 초기화 다운로드    | 지원, 준비 상태 별도 |
| ZIP                 | 기존 번들 유지  | 기존 번들 유지  | 기존 번들 유지     | 기존 지원 유지       |
| APPX (`build:msix`) | 기존 번들 유지  | 기존 번들 유지  | 제외·다운로드 금지 | 미지원               |

APPX 정책을 Store 승인 가능성의 보장으로 해석하지 않는다. 이번 변경은 기존 채널 정책 보존이다.

### 4.2 저장할 메타데이터와 신뢰 기준

**바이너리 대신 checksum만 저장한다는 요구는 고정 lock 메타데이터만 배포한다는 의미로 적용한다.** SHA-256 문자열만으로는 버전과 다운로드 대상을 결정할 수 없으므로 기존 `tools.lock.json`의 `id`, `version`, `platform`, 고정 `url`, `size`, `sha256`, `archive.files`, 출처·라이선스를 유지한다. 중복 checksum 전용 파일을 새로 만들지 않는다.

| 도구   | 다운로드 대상의 hash                           | 실행 전 확인                                               |
| ------ | ---------------------------------------------- | ---------------------------------------------------------- |
| uv     | `uv-x86_64-pc-windows-msvc.zip` 전체 SHA-256   | `uv.exe` 및 허용된 `uvw.exe`·`uvx.exe`의 개별 크기·SHA-256 |
| Deno   | `deno-x86_64-pc-windows-msvc.zip` 전체 SHA-256 | `deno.exe` 크기·SHA-256                                    |
| yt-dlp | `yt-dlp.exe` 전체 SHA-256                      | 같은 파일 크기·SHA-256                                     |

upstream checksum 파일 자체의 digest와 그 파일 안에 기록된 대상 자산 digest를 혼동하지 않는다. ZIP hash를 exe hash 대신 사용하지 않는다. GitHub API의 `digest`도 ZIP asset이면 ZIP의 hash다.

lock 갱신은 008의 명시적 후보 생성·검토 절차를 따른다. 그때 유지보수자가 공식 archive를 받아 내부 exe hash와 최소 실행을 확인할 수 있다. **이는 일반 NSIS 빌드에서 도구를 받거나 번들한다는 뜻이 아니다.** upstream checksum/API digest가 없거나 충돌하면 기존 값을 덮어쓰지 않고 후보 채택을 중단한다. 앱은 배포된 lock을 기준으로만 검증하며 `latest`, 도구 self-update, 시스템 도구 fallback을 허용하지 않는다.

앱 설치 파일과 함께 전달된 lock이 신뢰 기준이다. hash만으로 설치 파일 자체의 진위를 보장하지 않으며 신뢰 경계는 008 §4.1을 따른다. 도구를 번들에서 제외해도 출처·라이선스 고지를 제거하지 않는다. 특히 현재 `yt-dlp` lock의 `Unlicense`는 소스 프로젝트 표기이므로 실제 Windows 실행 파일에 포함된 구성 요소의 라이선스·고지와 대조하는 작업을 구현 완료 조건에 포함한다. [yt-dlp 릴리즈 바이너리 라이선스 안내](https://github.com/yt-dlp/yt-dlp#licensing)

### 4.3 manifest·빌드 입력 계약

배포 manifest를 schema v2로 명시적으로 확장한다. 기존 runtime ID 입력 계산은 유지하고 아래 배포 정책을 검증 필드로 추가한다. 도구 delivery 변경만으로 Python 환경을 불필요하게 다시 만들지 않는다.

- `distribution: 'nsis' | 'zip' | 'appx'`
- `capabilities.urlImport: boolean`: NSIS/ZIP은 true, APPX는 false
- `toolDelivery`: `uv`, `deno`, `yt-dlp` 각각 `bundled | download | disabled`; §4.1 표와 정확히 일치해야 한다

세 타깃 생성기·메인 프로세스 검증기·패키지 검증기를 함께 갱신한다. schema/채널/도구 정책 누락이나 불일치는 명시적으로 실패한다. 신규 빌드는 v2만 생성하고 v1을 파일 존재로 추정해 NSIS 정책으로 보정하지 않는다. 기존 설치된 이전 앱은 자체 v1 처리를 계속 사용한다. schema가 달라도 같은 실행 입력의 cache/runtime ID는 기존 검증을 거쳐 재사용할 수 있다.

`tools.lock`의 기존 `capability: 'zip-url-import'`는 이 호환 단계에서 남길 수 있으나 NSIS의 지원 여부를 판단하는 기준으로 사용하지 않는다. 타깃별 실제 배치·다운로드·비활성화 정책은 검증된 manifest가 결정한다. APPX 런타임 판별이 true이면 URL 기능은 manifest와 무관하게 금지하고, manifest가 허용한다고 주장하면 구성 오류로 처리한다.

신규 명령 계약:

| 명령                                                                                     | 동작                                                                                        |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `pnpm build:nsis`                                                                        | 앱 build → NSIS metadata/sidecar staging → lock 검증 → NSIS 패키징 → 최종 payload 검증      |
| `pnpm build:unpack:nsis`                                                                 | 동일 단계에서 설치 파일 생성 대신 NSIS용 `--dir`, unpacked 검증                             |
| `node scripts/prepare-resources.mjs --target nsis`                                       | 도구 다운로드/실행 없이 sidecar와 lock·manifest 입력만 준비                                 |
| `node scripts/runtime-lock/cli.mjs verify-package --target nsis --input <app-directory>` | 실제 앱 디렉터리를 읽고 정책·최종 바이트 검증; 단순 `dist/`를 앱 디렉터리로 간주하지 않는다 |

기존 옵션 없는 `prepare:resources`와 ZIP/APPX 명령의 동작은 유지한다. NSIS 리소스는 allowlist로 포함하고 stale `resources/bin`, cache, 도구 ZIP이 `files`·`extraResources`·asar 경유로 들어가지 못하게 한다. 검증 실패는 빌드 exit 1이다. 생성 metadata와 `build/locks` 원본을 분리하고 일반 빌드에서 lock을 수정하지 않는다.

### 4.4 초기화 순서와 파일 활성화

초기화는 Electron 메인 프로세스의 기존 다운로드·해시·ZIP 처리 코드로 수행한다. uv를 받기 위해 uv·Python·Deno·PowerShell 다운로드 스크립트가 먼저 필요해지는 순환 의존성을 만들지 않는다.

1. 007 DB 준비 성공 후 라이브러리를 열고 manifest·lock·sidecar 입력을 검증한다.
2. NSIS에서 uv 준비를 시작하고 Deno·yt-dlp 준비도 시작한다. 다운로드 동시 실행은 최대 2개로 제한한다. uv 검증 완료 후에는 URL 도구의 결과를 기다리지 않고 기존 Python 준비를 진행한다.
3. `<userData>/runtime-cache/sha256/<artifact-sha256>/`를 검증 다운로드 캐시로 사용한다. 실행 파일은 `<userData>/runtime-tools/<id>/<artifact-sha256>/` 아래에 둔다. 기존 lock의 `resources/bin/...`는 번들 배치 정보이며 NSIS 설치 디렉터리 쓰기 경로로 사용하지 않는다.
4. downloader 입력에서 목적 경로만 안전한 사용자 경로로 매핑한다. 원본 lock과 digest는 변경하지 않는다. archive 허용 목록과 내부 hash를 모두 검사한 staging을 같은 볼륨의 최종 digest 경로로 게시하고 검증된 절대 경로를 반환한다.
5. uv 경로를 `SidecarBootstrap`/Python 환경 준비에 주입한다. Deno·yt-dlp가 모두 검증되면 URL 서비스에 두 절대 경로를 제공한다. 실행 직전 검증을 유지하며 `--version`도 예외로 두지 않는다.
6. 이후 시작에서는 캐시와 실행 파일을 검증해 재사용한다. 새 앱 lock의 digest만 선택하며 이전 버전 파일은 보존한다. 현재 digest가 실패했다고 이전 버전을 대신 실행하지 않는다.

내용 주소 캐시·single-flight·프로세스 간 잠금·대기자별 취소·검증 실패 최대 1회 자동 재다운로드·안전한 압축 해제는 008 §4.2를 따른다. 재시도는 완성된 검증 캐시 단위로 재사용하고 미완성 파일은 처음부터 다시 받는다. 이번 범위에서 HTTP Range 이어받기를 추가하지 않는다.

GitHub 고정 HTTPS URL과 기존 허용된 release CDN redirect만 사용하고 모든 redirect에서 출처를 검사한다. 403/429는 재시도 가능 오류로 표시하되 무제한 반복하지 않는다. TLS 검증을 끄거나 사용자 토큰을 요구하지 않는다. URL query·서명 정보는 로그에서 제거한다. 타임아웃·취소·디스크 부족은 도구 ID를 포함한 정제된 오류로 보고한다.

### 4.5 capability·준비 상태·재시도

현재 시작 시 `existsSync`로 `urlImport`를 결정하고 서비스를 한 번만 만드는 경로를 바꾼다. capability는 배포판이 기능을 지원하는지, readiness는 지금 실행할 수 있는지를 나타낸다.

| 상태                               | 로컬 작업                 | YouTube 미리보기           | YouTube 가져오기                      |
| ---------------------------------- | ------------------------- | -------------------------- | ------------------------------------- |
| Python 준비 중/실패                | Python이 필요한 작업 차단 | URL 도구 준비 완료 시 가능 | Python과 URL 도구 모두 준비될 때 가능 |
| Python 완료, URL 도구 준비 중/실패 | 가능                      | 준비 안내·차단             | 준비 안내·차단                        |
| 모두 완료                          | 가능                      | 가능                       | 가능                                  |
| APPX                               | 기존 Python 상태에 따름   | UI 숨김·IPC 거부           | UI 숨김·IPC 거부                      |

기존 완료 곡 재생은 위 준비 상태에 영향받지 않는다. 모델 다운로드 필요 여부는 기존 008 계약을 따른다.

Python bootstrap 상태와 URL 도구 준비 상태를 별도로 보관하고, 도구별 `pending/downloading/verifying/ready/error`, 진행 바이트·전체 바이트, 오류·재시도 가능 여부를 IPC 초기 snapshot과 상태 이벤트로 전달한다. 렌더러 진입 시 최신 snapshot을 받아 이벤트를 놓쳐도 복구한다. 화면에는 전체 부트스트랩 완료와 URL 도구 완료를 혼동하지 않는 한국어 상태를 표시한다.

010 알림 센터에 도구 준비 항목과 도구별 재시도를 연결한다. URL 도구만 실패하면 해당 도구 준비만 다시 실행하며 정상 Python 환경을 재구성하지 않는다. 진행 중 중복 재시도는 기존 작업에 합류한다. 메인 IPC가 readiness를 다시 검사하므로 렌더러의 오래된 상태로 spawn할 수 없다.

서비스는 검증된 최신 도구 경로를 준비 후 조회하거나 준비 성공 시 안전하게 교체한다. 실패한 첫 시작에 서비스가 null이었다는 이유로 이후 재시도 성공을 무시하지 않는다. 앱 종료·dispose 이후 늦게 끝난 다운로드는 서비스·상태를 다시 활성화하지 않는다. 재시도 세대가 바뀌면 오래된 결과를 버린다.

### 4.6 설치·업그레이드·제거 검증

설치 경로와 사용자 데이터 경로를 분리한다. 업데이트는 같은 설치 identity의 앱 파일만 교체하며 lock 변경에 따른 새 도구 환경은 다음 앱 실행에서 준비한다. 앱 다운그레이드로 DB가 더 최신이면 007의 보호 동작을 따르고 런타임 준비를 시작하지 않는다.

제거 시 DB·곡·설정·다운로드 캐시·기존 런타임을 보존한다. 전체 데이터 삭제 UI와 캐시 GC는 추가하지 않는다. 설치 경로 변경, 별도 채널 간 데이터 자동 이사, APPX 가상화 경로 병합도 수행하지 않는다.

패키지 검증은 `resources/bin`만 나열하지 않고 실제 payload 목록과 asar/unpacked를 포함한다. lock 자산의 파일명·바이트 hash·archive 포함 여부를 확인한다. 앱 자체와 Electron의 exe는 정상 구성으로 구분한다. 최종 설치 exe에서 추출한 앱 payload의 inventory와 manifest가 사전 검증한 unpacked 앱과 일치해야 한다. 서명 시 달라질 수 있는 앱 exe의 byte 비교는 서명 이후 inventory를 기준으로 한다.

실제 설치 프로그램의 설치/재설치/제거는 별도 VM에서 실행한다. unpacked 디렉터리 검사만으로 설치 동작 검증을 대신하지 않는다. Python·모델을 추가로 받으므로 도구를 제외한 용량 차이만으로 첫 실행 전체 다운로드 용량을 추정하지 않는다.

### 4.7 구현 슬라이스

경로는 구현 소유권이다. N3는 감독자가 main·IPC·sidecar·서비스를, 별도 에이전트가 preload·renderer를 맡아 비중첩으로 진행했다. N1의 notice 생성기와 생성된 고지도 추가 배정했다. 성공 기준이 우선이고 표의 신규 내부 파일명은 구현 시 역할을 유지하며 조정할 수 있다.

| 슬라이스 | 산출물                                           | 소유(수정 가능) 경로                                                                                                                                                                                                                                                                      | 수정 금지 경로                             | 선행 조건                        | 상태                   |
| -------- | ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ | -------------------------------- | ---------------------- |
| N0       | manifest v2·도구 상태·IPC 계약, 양쪽 schema 일치 | `src/shared/**`, `src/main/runtime/manifest.ts`, `src/main/runtime/schema.ts`, `scripts/runtime-lock/schema.mjs`, `src/main/__tests__/runtime/manifest.test.ts`, `scripts/__tests__/runtime-lock/schema.test.mjs`                                                                         | 나머지 N1–N4 소유 경로                     | 없음                             | 완료                   |
| N1       | NSIS 설정·타깃 staging·payload 검증·명령         | `package.json`, `electron-builder*`, `scripts/prepare-resources.mjs`, `scripts/runtime-lock/{prepare,package,cli}.mjs`, `scripts/__tests__/runtime-lock/{prepare,package}.test.mjs`, `src/main/__tests__/packaging/**`, `build/locks/tools.provenance.json`, `NOTICE`, `LICENSE_SCOPE.md` | N0/N2/N3/N4 경로, lock 버전·hash 무단 갱신 | N0                               | 완료                   |
| N2       | 검증 도구 resolver·다운로드·활성화               | `src/main/runtime/` 중 `manifest.ts`·`schema.ts` 제외, `src/main/__tests__/runtime/` 중 `manifest.test.ts` 제외                                                                                                                                                                           | N0/N1/N3/N4 경로                           | N0                               | 완료                   |
| N3       | 앱 초기화·서비스·IPC·알림 UI 연결 및 회귀        | `src/main/index.ts`, `src/main/ipc.ts`, `src/main/sidecar/**`, `src/main/library/{YtDlpService,YoutubePreviewService}.ts`, 대응 library 테스트, `src/preload/**`, `src/renderer/**`, 신규 `src/main/__tests__/toolBootstrap.test.ts`                                                      | N0/N1/N2/N4 경로                           | N0, N2 계약 확정; 완료는 N2 의존 | 완료                   |
| N4       | 실제 패키지·VM 인수 시험과 운영 문서             | `scripts/nsis-acceptance/**`, `docs/runtime-lock.md`, `README.md`, `docs/specs/{README,001-packaging-distribution,008-runtime-dependency-lock,012-nsis-installer}.md`                                                                                                                     | N0–N3 코드 경로                            | N1–N3                            | 자동 검증 완료·VM 대기 |

완료 판정: N0 = 기준 7·10의 정책/schema fixture, N1 = 기준 1·2·10, N2 = 기준 4–6, N3 = 기준 7·8, N4 = 기준 3·9·11 및 최종 설치 payload 검증이다. N1과 N2는 N0 이후 병렬 가능하고, N3는 확정된 N2 계약으로 작업하되 통합 완료는 N2 이후다. 추가 공유 파일은 감독자가 소유권을 한 슬라이스에 배정한 다음 수정한다. 완료된 슬라이스는 감독자의 명시적 재개 없이 재작업하지 않는다.

실제 병렬 구현 시 `orchestrate-slices` 스킬을 사용한다. 에이전트는 종료 전 §5의 담당 검증을 실행하고 명령·exit code·미실행 항목을 보고한다. 훅 우회(`--no-verify`, `LEFTHOOK=0`)는 금지한다. git stage/commit 등 상태 변경은 사용자 명시 요청이 있을 때 감독자 또는 사용자만 수행한다. 이 문서 작성은 에이전트 실행이나 구현 승인을 뜻하지 않는다.

## 5. 검증 방법

아래 NSIS 명령·시험 파일은 구현되었다. 실제 수행 결과와 미실행 범위는 §6에 기록한다. fixture 시험은 격리 경로와 mock 네트워크를 사용하고 실제 GitHub·설치 프로그램·모델은 인수 시험에서 구분한다.

```bash
# 문서 형식·diff 검증
pnpm exec prettier --check docs/specs/012-nsis-installer.md
git diff --check

# 기준 4·10: lock schema와 원본 불변성 (기존 명령)
pnpm verify:runtime-lock

# 기준 1·2·4–8·10: 기존 fixture + 신규 NSIS/도구 준비 회귀
node --test scripts/__tests__/runtime-lock/*.test.mjs
pnpm test
pnpm typecheck

# 기준 1·2·10: 신규 NSIS unpacked/payload 구성과 manifest 검증
pnpm build:unpack:nsis
node scripts/runtime-lock/cli.mjs verify-package --target nsis --input dist/nsis/win-unpacked
pnpm build:nsis

# 기준 10: 기존 배포 채널 회귀; 각 빌드 직후 해당 앱 디렉터리를 검사
pnpm build:zip
node scripts/runtime-lock/cli.mjs verify-package --target zip --input dist/win-unpacked
pnpm build:msix
node scripts/runtime-lock/cli.mjs verify-package --target appx --input dist/win-unpacked
```

- 기준 1–2: 빌드 테스트에서 도구 다운로드 fetch와 `--version` spawn 호출을 가로채 0회임을 확인한다. 빈 도구 디렉터리와 stale 바이너리/ZIP fixture를 각각 넣어 같은 NSIS 리소스 목록을 확인한다. Electron/NSIS 빌드 도구 자체의 다운로드와 앱 런타임 도구 다운로드를 구분한다.
- 기준 4–6: 요청 URL·spawn 횟수를 관찰하고 checksum/API 조회 0회, 변조 시 spawn 0회, 정상 재시작 시 도구 asset 다운로드 0회를 검증한다. 강제 종료·취소·rename 실패·공간 부족·HTTP 오류·서로 다른 앱 manifest의 캐시 공존을 시험한다.
- 기준 7–8: NSIS 빈 캐시 시작 → URL 준비 실패 → 재시도 성공에서 미리보기/가져오기가 재시작 없이 활성화되는지 확인한다. URL 오류 중 Python 로컬 작업, Python 오류 중 준비된 URL 미리보기, APPX 캐시 주입 시 IPC 거부, dispose 후 늦은 완료를 회귀 시험한다.
- 기준 3·9: 격리 Windows VM의 일반 사용자로 네트워크 차단 설치, 첫 실행 실패/복구, 다음 버전 재설치, 실행 중 재설치, 제거/재설치를 수행한다. 전후 DB·곡·설정 파일 inventory를 비교하고 제거 항목·바로가기·사용자 경로 보존을 확인한다.
- 기준 10: 실제 NSIS exe에서 추출한 payload inventory와 manifest를 검사하고, 설치 후 앱 디렉터리도 같은 검증기에 통과시킨다. 패키지에 금지 exe/ZIP·잘못된 manifest·변조 sidecar를 넣은 fixture는 exit 1이어야 한다.
- 기준 11: 실제 설치 앱에서 lock의 세 버전 확인, 로컬 가져오기·분리·재생, YouTube 미리보기·가져오기를 수행한다. 네트워크 차단 재실행은 필요한 Python·wheel·모델까지 준비된 상태에서 로컬 작업과 기존 곡 재생으로 검증한다. YouTube 작업은 네트워크가 필요하다.
- 실자산 체크섬 채택 기록, fixture 결과, 최종 설치 바이트 검사, VM 설치 동작, 실제 GPU·YouTube 결과를 나누어 기록한다. Windows VM의 설치·제거와 실제 GPU·YouTube 작업은 아직 수행하지 않았다.

## 6. 구현 결과 (2026-09-18)

N0–N3 코드는 구현했고, N4의 빌드·최종 바이트·실자산 도구 검증을 수행했다. **VM과 실제 설치 앱의 성공 기준이 남아 있으므로 전체 인수 완료로 판정하지 않는다.**

| 기준 | 결과와 증거                                                                                            | 남은 검증                                          |
| ---- | ------------------------------------------------------------------------------------------------------ | -------------------------------------------------- |
| 1    | NSIS build·타깃별 staging·lock 불변성 검증, 도구 fetch 0회 fixture                                     | 아래 실행 기록 참조                                |
| 2    | stale resources/bin을 둔 실제 NSIS payload 189개 파일 대조, 빈 디렉터리·asar/ZIP/변조 바이트 fixture   | 빈 도구 디렉터리에서 실제 재빌드는 미실행          |
| 3    | oneClick/per-user/runAfterFinish=false 설정                                                            | 깨끗한 일반 사용자 VM의 오프라인 설치              |
| 4    | 실제 resolver로 GitHub lock 자산 다운로드 후 uv 0.12.9·Deno 2.9.6·yt-dlp 2026.08.19 실행 확인          | 설치된 Electron 앱에서 첫 초기화                   |
| 5    | 같은 격리 캐시의 새 controller에서 다운로드 0건, 변조·잘린 응답·안전한 추출 fixture                    | 설치 앱 오프라인 재시작                            |
| 6    | HTTP 403/404/429/500·취소·ENOSPC/EPERM·rollback·잠금 회수 fixture                                      | 실제 프로세스 강제 종료·디스크 부족·실행 파일 잠금 |
| 7    | IPC late service/retry·APPX 거부·renderer snapshot 경합 및 자동 미리보기 fixture                       | 설치 앱 UI 재시도                                  |
| 8    | Python과 URL readiness 독립, 로컬 작업/미리보기 게이트 fixture                                         | 실제 기존 곡 재생·로컬 작업                        |
| 9    | 새 digest와 이전 파일 보존 fixture, 제거 데이터 보존 설정                                              | VM 업그레이드·제거·재설치 inventory                |
| 10   | 실제 NSIS 내장 앱과 unpacked 크기/SHA-256 전수 대조, manifest/lock/sidecar 검사, ZIP/APPX 정책 fixture | 아래 채널별 실행 기록 참조                         |
| 11   | 도구 실제 버전 실행만 완료                                                                             | 설치 앱 GPU 분리·재생·YouTube 미리보기/가져오기    |

검증 명령과 현재 결과:

- 전체 Vitest: 69 files / 703 tests, exit 0.
- Node runtime-lock·inventory: 55 tests, exit 0. null/falsy manifest와 필수 도구 lock 누락 거부 포함.
- Node/Web typecheck, 변경 소스 ESLint, runtime-lock 원본 검증: exit 0.
- 전체 ESLint는 기존 `src/main/__tests__/openTrackFolder.test.ts`의 explicit-any 11건 때문에 exit 1. 이번 변경 파일의 lint는 통과했고 해당 기존 테스트는 수정하지 않았다.
- `pnpm build:nsis`: exit 0. 최종 exe 내장 payload 189개 파일의 byte inventory 대조와 NSIS 정책 검증 통과.
- `pnpm build:unpack:nsis`, `pnpm build:zip`, `pnpm build:msix`: 모두 exit 0. 각 채널의 실제 앱 디렉터리에 `verify-package`를 실행해 통과했고 ZIP의 세 도구 번들·APPX의 uv/Deno 번들 및 yt-dlp 제외를 확인했다.
- `node scripts/nsis-acceptance/runtime-tools-smoke.mjs`: exit 0. 빈 격리 캐시에서 6 HTTP 요청(3개 자산과 redirect), 실제 세 버전 확인, warm offline 요청 0건.
- 실제 설치·제거와 GPU·YouTube 작업은 자동 검증 결과에 포함하지 않았다. 세부 절차와 실행 스크립트는 [NSIS 인수 검증](../../scripts/nsis-acceptance/README.md)을 따른다.

잠금은 완성된 owner 파일을 hard-link로 원자적으로 게시한다. Windows 11 기본 NTFS에서 검증했으며 hard-link를 지원하지 않는 사용자 데이터 파일시스템은 명시적 오류로 중단한다. 기존 내용 없는 비정상 잠금은 임의 삭제하지 않고 timeout 오류로 보고한다.

구현 편성 및 결과:

| 슬라이스           | 난이도    | 모델        | 추론 수준 | 결과                                 |
| ------------------ | --------- | ----------- | --------- | ------------------------------------ |
| N0 계약            | 높음      | gpt-5.6-sol | xhigh     | 완료                                 |
| N1 패키징          | 높음      | gpt-5.6-sol | xhigh     | 완료, 실제 빌드는 감독자 검증        |
| N2 다운로드·동시성 | 매우 높음 | gpt-6-astra | high      | 완료                                 |
| N3 UI·preload      | 높음      | gpt-5.6-sol | xhigh     | 완료, main 통합은 감독자 구현        |
| N4 인수·문서       | 높음      | 감독자      | 해당 없음 | 자동 검증 완료, VM·설치 앱 인수 대기 |
