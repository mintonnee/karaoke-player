# Karaoke Player

로컬 음원을 반주와 보컬로 분리하고, 싱크 가사와 키 조절을 함께 사용할 수 있는 Windows 데스크톱 노래 연습 앱입니다.

음원 분리·전사·분석은 사용자 PC에서 수행합니다. 실행 환경과 모델 다운로드, 가사 검색, YouTube 가져오기에는 인터넷 연결이 필요합니다.

## 주요 기능

- **음원 가져오기**: MP3·WAV·FLAC·M4A 파일을 선택하거나 드래그 앤 드롭합니다. 일반 음원 분리 외에 MR과 가이드 보컬/AR을 직접 연결하거나 MR만 가져올 수 있습니다.
- **YouTube 가져오기**: NSIS·ZIP 배포판에서 URL로 곡을 가져옵니다. APPX 배포판에서는 제공하지 않습니다.
- **보컬·반주 분리**: Demucs를 사용하며 분리 모델을 선택할 수 있습니다.
- **재생과 믹서**: 메인·반주·보컬 음량, 뮤트, 탐색, A–B 구간 반복을 지원합니다. 곡별 음량·뮤트·키 변경값을 저장합니다.
- **가사**: LRCLIB 싱크 가사 검색, 텍스트 가사의 강제 정렬, 음성 전사를 지원합니다. 줄 선택으로 재생 위치를 이동하고 가사 타이밍을 보정할 수 있습니다. 일본어 가사에는 한글 발음 힌트를 제공합니다.
- **키와 BPM**: 템포를 유지하며 ±6반음으로 키를 조절합니다. BPM·키를 자동 분석하고 메타데이터에서 직접 수정할 수 있습니다.
- **라이브러리**: 곡 검색, 제목·아티스트 등 메타데이터와 커버 편집, 곡 삭제를 지원합니다.

## 설치와 첫 실행

### 실행 환경

- Windows 11 x64를 기준으로 개발·검증합니다.
- 시스템에 Python이나 uv를 별도로 설치할 필요가 없습니다.
- 첫 실행에는 인터넷 연결과 충분한 디스크 여유 공간이 필요합니다. Python과 의존성 다운로드는 수 GB 규모이며, CUDA용 PyTorch wheel 하나가 약 3.22 GiB입니다. 다운로드 캐시·설치 환경·모델·음원은 추가 공간을 사용합니다.
- 음원 분리·전사에는 NVIDIA GPU 사용을 권장합니다. CPU에서도 처리할 수 있으나 작업 시간이 길어질 수 있습니다.

### NSIS 설치 파일

1. `karaoke-player-<version>-win-x64-setup.exe`를 실행합니다.
2. 현재 사용자용으로 설치되고 시작 메뉴에 **Karaoke Player**가 등록됩니다. 설치 완료 후 앱은 자동 실행되지 않습니다.
3. 시작 메뉴에서 앱을 실행하고 실행 환경 준비를 기다립니다. 진행 상태와 오류는 오른쪽 위 **알림**에서 확인합니다.
4. 준비가 끝나면 **+ 가져오기**로 곡을 추가합니다.

설치 자체는 네트워크 없이 완료됩니다. 첫 앱 실행에서 고정된 버전의 uv·Deno·yt-dlp와 Python 실행 환경을 내려받으며, 파일 크기와 SHA-256을 검증한 뒤 사용합니다. 모델은 해당 기능을 처음 사용할 때 준비합니다.

준비 중에는 실행 환경이 필요한 작업이 제한됩니다. 실패하면 알림의 **다시 시도**를 사용하세요. 검증된 캐시는 재사용하므로 문제 해결을 위해 AppData를 먼저 삭제할 필요는 없습니다. Python 환경과 URL 도구의 준비 상태는 별도로 관리합니다.

### 다른 배포 형식

| 형식        | 실행 방법                              | uv·Deno·yt-dlp               | YouTube 가져오기 |
| ----------- | -------------------------------------- | ---------------------------- | ---------------- |
| NSIS `.exe` | 설치 후 시작 메뉴에서 실행             | 첫 실행에 다운로드           | 지원             |
| ZIP         | 압축 해제 후 `karaoke-player.exe` 실행 | 번들 포함                    | 지원             |
| APPX        | Store 제출용 패키지                    | 배포 정책에 맞는 도구만 포함 | 미지원           |

ZIP도 Python 환경과 모델은 별도로 준비하며 사용자 데이터는 AppData에 저장합니다. APPX 빌드 지원은 Microsoft Store 출시를 의미하지 않습니다.

## 데이터와 백업

일반 Windows 실행의 데이터 위치는 `%APPDATA%\karaoke-player`입니다. 개발 실행과 설치 앱이 같은 데이터 경로를 사용할 수 있으므로, 기존 라이브러리로 개발판을 테스트할 때는 먼저 백업하세요.

| 경로                             | 내용                                     |
| -------------------------------- | ---------------------------------------- |
| `library.sqlite`                 | 곡 메타데이터와 재생 설정                |
| `tracks/<id>/`                   | 곡별 음원, 분리 결과, 가사, 커버         |
| `settings.json`                  | 앱 설정                                  |
| `runtimes/<runtimeId>/`          | Python, 의존성, 사이드카 소스, 준비 결과 |
| `runtimes/current.json`          | 현재 선택된 실행 환경                    |
| `runtime-cache/`                 | 해시로 관리하는 다운로드·모델 캐시       |
| `runtime-tools/<tool>/<digest>/` | NSIS에서 내려받아 검증한 도구            |

백업은 **앱을 완전히 종료한 뒤 데이터 폴더 전체를 복사**하는 방식이 가장 간단합니다. NSIS 앱 제거 시에도 라이브러리·설정·런타임 캐시는 보존합니다. 예전 버전에서 만든 `sidecar/` 등의 폴더가 남아 있을 수 있습니다.

## 단축키

| 키                 | 동작                                       |
| ------------------ | ------------------------------------------ |
| `Space`            | 재생 / 일시정지, 타이밍 보정 모드에서는 탭 |
| `←` / `→`          | 5초 뒤로 / 앞으로                          |
| `↑` / `↓`          | 메인 음량                                  |
| `Ctrl` + `↑` / `↓` | 반주 음량                                  |
| `Alt` + `↑` / `↓`  | 보컬·AR 음량                               |
| `−` / `=`          | 키 내림 / 올림                             |
| `M`                | 메인 뮤트                                  |
| `V`                | 보컬 뮤트 또는 AR 곡의 MR·AR 전환          |
| `L`                | A–B 루프: A 설정 → B 설정 → 해제           |
| `R`                | 처음으로 이동                              |
| `/`                | 단축키 도움말                              |

## 개발

Node.js 24, pnpm 11, PATH에서 실행 가능한 [uv](https://docs.astral.sh/uv/)를 사용하는 Windows 개발 환경을 기준으로 합니다.

```powershell
pnpm install
pnpm dev
```

개발 모드는 레포의 `sidecar/`를 `uv run`으로 실행하며 설치 앱의 초기화 과정을 건너뜁니다. 개발 모드에서 YouTube 가져오기를 사용하려면 도구를 준비합니다.

```powershell
pnpm prepare:resources
```

### 검증

```powershell
pnpm typecheck
pnpm lint
pnpm test
pnpm verify:runtime-lock
node --test scripts/__tests__/runtime-lock/*.test.mjs
```

단위 테스트와 패키지 내용 검증 외에, 실제 설치 앱의 초기화·재생·GPU 작업은 별도로 확인해야 합니다. 설치·업그레이드·제거 확인 항목은 [NSIS 인수 절차](scripts/nsis-acceptance/README.md)에 정리되어 있습니다.

### 패키징

```powershell
pnpm build:nsis          # NSIS 설치 EXE
pnpm build:unpack:nsis   # NSIS 정책의 unpacked 앱
pnpm build:zip           # ZIP 배포본
pnpm build:msix          # Store 제출용 APPX
```

NSIS 결과물은 `dist/nsis/karaoke-player-<version>-win-x64-setup.exe`, unpacked 앱은 `dist/nsis/win-unpacked/`에 생성됩니다. ZIP·APPX 결과물은 `dist/`에 생성됩니다.

각 패키징 명령은 타입 검사·앱 빌드·타깃별 리소스 준비·lock 검증을 실행합니다. NSIS는 uv·Deno·yt-dlp 바이너리를 포함하지 않고, 고정 버전·URL·크기·SHA-256을 담은 lock과 manifest를 배치합니다. 빌드 과정에서 설치 EXE 내부의 앱 파일도 검증합니다.

APPX 제출용 identity는 `APPX_IDENTITY_NAME`, `APPX_PUBLISHER`, `APPX_PUBLISHER_DISPLAY_NAME`, `APPX_APPLICATION_ID`로 설정합니다. 미설정 상태의 기본값은 제출용 identity가 아닙니다.

의존성 버전 변경과 checksum 갱신 절차는 [런타임 lock 운영](docs/runtime-lock.md)을 참고하세요. 일반 빌드는 lock을 자동 갱신하지 않습니다. 서드파티 고지는 `pnpm gen:notices`로 재생성합니다.

### GitHub Actions와 릴리즈

[Windows CI and Release](.github/workflows/windows.yml)는 PR·`main` push·수동 실행에서 타입 검사, 린트, 테스트, runtime lock 검증과 NSIS 빌드를 수행합니다. 설치 파일과 `SHA256SUMS`는 Actions의 `windows-nsis` 아티팩트에서 받을 수 있으며, payload 검증 보고서는 별도 아티팩트로 보관합니다. 보관 기간은 14일입니다.

릴리즈 절차:

1. `package.json`의 버전을 정하고 변경사항을 커밋합니다.
2. 해당 커밋에 버전과 정확히 일치하는 태그를 만듭니다. 예: 버전 `0.1.0` → `v0.1.0`.
3. 준비한 커밋과 태그를 GitHub에 push합니다.
4. Windows 검증·빌드 성공 후 EXE와 `SHA256SUMS`가 첨부된 **Release 초안**이 생성됩니다. `v0.1.0-beta.1`처럼 접미사가 있는 버전은 prerelease로 표시됩니다.
5. 초안의 설치 파일로 동작을 확인하고 릴리즈 노트를 검토한 뒤 GitHub에서 공개합니다.

브랜치·PR·수동 실행은 릴리즈를 생성하지 않습니다. 태그와 앱 버전이 다르면 빌드 전에 실패합니다. 기존 릴리즈를 덮어쓰지 않으므로, 업로드 도중 실패해 초안이 남았다면 해당 초안을 확인·정리한 뒤 실패한 release job을 재실행하세요.

빌드 job은 읽기 권한만 사용하며 릴리즈 job에만 `contents: write`를 부여합니다. 기본 `GITHUB_TOKEN`을 사용하므로 별도 PAT는 필요하지 않습니다. 저장소 정책에서 Actions 실행과 릴리즈 생성을 허용해야 합니다. 현재 워크플로는 코드 서명과 Store 업로드를 구성하지 않습니다.

### 환경 변수

| 변수                       | 기본값 | 용도                                 |
| -------------------------- | ------ | ------------------------------------ |
| `KARAOKE_DEVICE`           | `auto` | 연산 장치 선택: `cpu`, `cuda`, `mps` |
| `KARAOKE_DEMUCS_SHIFTS`    | `2`    | Demucs 시프트 평균화 횟수            |
| `KARAOKE_MAX_DURATION_SEC` | `900`  | 가져오기 가능한 최대 길이(초)        |
| `KARAOKE_GUIDE_VOCAL_DB`   | `-20`  | 가이드 보컬 기본 음량(dB)            |

## 프로젝트 구조

```text
src/main/       Electron 메인: 라이브러리, IPC, 초기화, Python 실행 제어
  runtime/      lock 검증, 다운로드, Node.js Worker의 해시·압축 해제·복사
src/preload/    contextBridge 기반 window.api
src/renderer/  React·Zustand UI, Web Audio 재생, AudioWorklet
src/shared/    공용 타입과 상태 계약
sidecar/       Python: 음원 분리·분석·가사 정렬·전사
build/locks/   도구·Python·wheel·모델 의존성 잠금 파일
scripts/       리소스 준비, 패키지 검증, 고지 생성
docs/          설계 스펙과 운영 문서
```

초기화의 무거운 파일 작업은 Node.js Worker에서 수행하며, Python 사이드카와는 별개입니다. 메인 프로세스는 다운로드·취소·진행 상태를 관리하고 Python과 JSONL 메시지로 통신합니다. Python 실행 시에는 검증된 사이드카 소스 경로만 모듈 검색 경로에 추가합니다.

- [기능 스펙 목록](docs/specs/README.md)
- [NSIS 설치·초기화 설계](docs/specs/012-nsis-installer.md)
- [런타임 lock 운영](docs/runtime-lock.md)
- [버그 제보](https://github.com/mintonnee/karaoke-player/issues)

## 라이선스

자체 소프트웨어 코드는 [Apache License 2.0](LICENSE)을 따릅니다. 문서·이미지·아이콘·음원·가사·모델 가중치 등 비코드 자료는 이 허가 범위에 포함되지 않습니다. 정확한 적용 범위는 [LICENSE_SCOPE.md](LICENSE_SCOPE.md)를 확인하세요.

`src/renderer/public/worklets/soundtouch-worklet.js` 전체는 수정 부분을 포함해 **LGPL-2.1-or-later**를 유지합니다. 배포물에는 [라이선스 전문](scripts/licenses/LGPL-2.1.txt)과 수정 가능한 worklet 소스를 함께 제공합니다.

다른 서드파티 구성요소는 각자의 라이선스를 따릅니다. 고지는 앱 설정과 배포물의 `THIRD-PARTY-NOTICES.txt`에서 확인할 수 있습니다. 내려받거나 사용하는 음원·가사는 해당 콘텐츠의 이용 조건을 확인하세요.
