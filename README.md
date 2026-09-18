# Karaoke Player

로컬 음원 파일을 Demucs로 보컬/반주 분리한 뒤, 반주 + 가이드 보컬 + 싱크 가사 + 키 변경으로 노래방처럼 부를 수 있게 하는 Windows 데스크톱 앱. 모든 처리는 로컬에서 수행하며 외부 업로드가 없다.

## 기능

- **임포트**: MP3 / WAV / FLAC / M4A 파일을 드래그 앤 드롭하거나 `+ 가져오기`로 추가. zip 배포판에서는 YouTube URL 입력으로도 가져올 수 있다 (동봉된 yt-dlp 사용, MSIX/Store판에는 없음).
- **분리**: Demucs 2-stem(vocals / no_vocals). 모델은 설정에서 선택 (기본 `htdemucs_ft`).
- **재생**: 반주 + 가이드 보컬(기본 -20 dB, 뮤트 가능), 시크, 구간 루프, 메인/반주/보컬 개별 음량은 오른쪽 믹서 패널의 세로 페이더로 조절하고, 옆의 레벨 미터가 재생 레벨을 보여 준다.
- **가사**: LRCLIB에서 싱크 가사를 받아 줄 단위 하이라이트. 싱크 가사가 없으면 텍스트를 강제 정렬(torchaudio MMS_FA)하고, 텍스트조차 없으면 faster-whisper로 전사. 일본어 가사는 한글 발음 힌트를 붙인다.
- **키 변경**: ±6 반음 (soundtouchjs AudioWorklet). 오른쪽 키 패널이 원키(위)와 변경 키(아래)를 상자로 보여 주고, 가운데 버튼이 반음 수 표시 겸 원키 리셋이다. 트랜스포트 바에는 BPM이 표시된다.
- **라이브러리**: 처리한 곡 목록, 검색(한글 초성·일본어 발음 키 포함), 메타 편집, 앨범 커버, 삭제. 분리가 끝나면 BPM과 키를 자동 분석해(Beat This! + 크로마 템플릿) `128 BPM · C#m`처럼 보여 주고, 추정이 불확실하면 `?`를 붙인다. 값은 메타 편집에서 직접 고쳐 쓸 수 있다(사용자 값은 재분석이 덮어쓰지 않는다).

## 설치 (사용자)

### 요구 사항

- Windows 11 x64. 시스템 Python은 필요 없다 (uv가 관리형 Python을 내려받는다).
- 첫 실행에 인터넷 연결 필수. Python 환경(torch cu128 포함, 수 GB)을 사용자 디렉터리에 내려받는다.
- NVIDIA GPU를 권장한다. CUDA가 없으면 CPU로 동작하지만 분리·정렬이 매우 느리다 (`KARAOKE_DEVICE=cpu`로 강제 가능).

### zip (포터블)

1. 릴리즈 zip을 원하는 폴더에 푼다 (예: `%USERPROFILE%\.local\share\karaoke-player`).
2. `karaoke-player.exe`를 실행한다. 무서명이라 SmartScreen 경고가 뜨면 "추가 정보 → 실행"을 누른다.
3. 첫 실행에서 부트스트랩 화면이 뜨고 Python 환경을 구성한다. 실패하면 오류와 함께 "다시 시도" 버튼이 나온다. 이미 받은 파일은 재사용된다.
4. 완료되면 라이브러리 화면으로 전환된다. 이후 실행에서는 부트스트랩을 건너뛴다.

### MSIX (Microsoft Store)

Store 제출용 패키지다. URL 임포트(yt-dlp)는 포함하지 않는다. 그 외 동작은 zip판과 같다.

### 데이터 위치

모든 데이터는 `%APPDATA%\karaoke-player` 아래에 있다 (dev 실행과 패키징 앱이 같은 경로를 쓴다).

| 경로                      | 내용                                  |
| ------------------------- | ------------------------------------- |
| `library.sqlite`          | 라이브러리 메타데이터                 |
| `tracks/<id>/`            | 원본 복사본, 분리 스템, 가사, 커버    |
| `sidecar/`                | 첫 실행에 구성한 Python 환경(`.venv`) |
| `uv-cache/`, `uv-python/` | uv 캐시와 관리형 Python               |
| `settings.json`           | 앱 설정                               |

Demucs / whisper 모델은 각 라이브러리의 자체 캐시(torch hub, Hugging Face)에 첫 사용 시 내려받는다.

## 단축키

| 키               | 동작                                           |
| ---------------- | ---------------------------------------------- |
| `Space`          | 재생 / 일시정지 (타이밍 보정 모드에서는 탭)    |
| `←` `→`          | 5초 뒤로 / 앞으로                              |
| `↑` `↓`          | 메인 음량                                      |
| `Ctrl` + `↑` `↓` | 반주 음량                                      |
| `Alt` + `↑` `↓`  | 보컬 음량                                      |
| `−` `=`          | 키 내림 / 올림                                 |
| `M` / `V` / `L`  | 전체 뮤트 / 보컬 뮤트 / A-B 루프(A → B → 해제) |
| `R`              | 처음으로 (재생 상태 유지)                      |
| `/`              | 단축키 도움말                                  |

## 환경 변수

| 변수                       | 기본 | 설명                                         |
| -------------------------- | ---- | -------------------------------------------- |
| `KARAOKE_DEVICE`           | auto | torch 디바이스 강제 (`cpu` / `cuda` / `mps`) |
| `KARAOKE_DEMUCS_SHIFTS`    | 2    | Demucs 랜덤 시프트 평균화 횟수 (품질↑ 시간↑) |
| `KARAOKE_MAX_DURATION_SEC` | 900  | 초과 시 임포트 거부                          |
| `KARAOKE_GUIDE_VOCAL_DB`   | -20  | 가이드 보컬 기본 게인                        |

## 개발

### 요구 사항

- Node.js 24, pnpm 11
- [uv](https://docs.astral.sh/uv/) (PATH에 있어야 함). dev 모드는 레포의 `sidecar/`를 `uv run`으로 실행하고 부트스트랩을 건너뛴다.

### 실행

```bash
pnpm install
pnpm dev          # Electron + Vite HMR
```

URL 임포트를 dev에서 켜려면 `pnpm prepare:resources`로 `resources/bin/`에 `yt-dlp.exe`·`deno.exe`를 내려받는다 (gitignore 대상).

### 검증

```bash
pnpm typecheck && pnpm lint && pnpm test
```

### 빌드

```bash
pnpm build:zip    # dist/karaoke-player-<ver>-win-x64.zip (uv + yt-dlp + deno 동봉)
pnpm build:msix   # dist/karaoke-player-<ver>-win-x64.appx (yt-dlp 제외)
pnpm build:nsis   # dist/nsis/karaoke-player-<ver>-win-x64-setup.exe (도구는 첫 실행 다운로드)
pnpm build:unpack:nsis # dist/nsis/win-unpacked (설치 전 앱 검증)
```

ZIP/APPX 빌드는 `prepare:resources`에서 도구를 준비한다. NSIS 빌드는 도구 바이너리를 받거나 포함하지 않고 sidecar·lock·manifest를 배치한다. 버전·고정 URL·크기·SHA-256은 `build/locks/tools.lock.json`으로 관리한다.

NSIS 설치는 네트워크 없이 끝나며 앱은 자동 실행되지 않는다. 첫 앱 실행에서 uv·Deno·yt-dlp를 검증 다운로드하므로 최초 실행 환경 준비에는 네트워크가 필요하다. 도구별 준비 상태와 재시도는 알림에서 확인한다. 제거 시 라이브러리·설정·런타임 캐시는 보존한다. ZIP/NSIS는 URL 가져오기를 지원하고 APPX는 지원하지 않는다.

NSIS 패키지의 도구 제외·manifest·payload 검증은 빌드 과정에 포함한다. Windows 설치·업그레이드·제거 및 실제 GPU·YouTube 검증은 [NSIS 인수 절차](scripts/nsis-acceptance/README.md)를 따른다. 상세 설계는 [012 NSIS 스펙](docs/specs/012-nsis-installer.md), 의존성 관리 방법은 [런타임 lock 운영](docs/runtime-lock.md)을 참고한다.

MSIX identity는 환경 변수로 주입한다. 미설정 시 placeholder로 빌드된다.

| 변수                          | 의미                         |
| ----------------------------- | ---------------------------- |
| `APPX_IDENTITY_NAME`          | Partner Center Identity Name |
| `APPX_PUBLISHER`              | `CN=...` Publisher           |
| `APPX_PUBLISHER_DISPLAY_NAME` | Publisher 표시명             |
| `APPX_APPLICATION_ID`         | Application Id               |

아이콘은 `uv run --with pillow python scripts/generate-icons.py`, 서드파티 고지는 `pnpm gen:notices`로 재생성한다.

### 구조

```
src/main/        Electron 메인: 사이드카 관리, 부트스트랩, 라이브러리(SQLite), 가사, IPC
src/preload/     contextBridge API (window.api)
src/renderer/    React UI (zustand 스토어, Web Audio 엔진, AudioWorklet)
src/shared/      메인·렌더러 공용 타입과 IPC 채널
sidecar/         Python 워커 (uv 프로젝트): probe / separate / align / transcribe / pronounce / cover
scripts/         리소스 준비, 아이콘·고지 생성
docs/            스펙 문서 (docs/specs/README.md 인덱스)
```

메인과 사이드카는 stdout JSONL(`progress` / `done` / `error`)로 통신한다. 자세한 설계는 `docs/draft/000-karaoke-app-spec-draft.md`, 패키징·배포는 `docs/specs/001-packaging-distribution.md`를 본다.

## 라이선스

이 프로젝트의 **자체 코드**(앱 소스, 테스트, 빌드 스크립트 및 소프트웨어 설정)는 [Apache License 2.0](LICENSE)을 따른다. 문서, 이미지·아이콘, 음원·가사, 모델 가중치 등 코드가 아닌 자료에는 이 라이선스를 적용하지 않는다. 정확한 범위는 [LICENSE_SCOPE.md](LICENSE_SCOPE.md)를 참조한다.

**SoundTouch 예외:** `src/renderer/public/worklets/soundtouch-worklet.js` 전체(이 프로젝트의 AudioWorklet 어댑터와 수정 부분 포함)는 기존 **LGPL-2.1-or-later**를 유지하며 Apache-2.0 적용 대상에서 제외한다. 원저작자 고지는 파일 헤더에, 라이선스 전문은 [scripts/licenses/LGPL-2.1.txt](scripts/licenses/LGPL-2.1.txt)에 있다. 배포물에도 해당 라이선스와 수정 가능한 worklet 소스를 동봉한다.

다른 서드파티 코드·런타임·모델·에셋은 각자의 라이선스를 유지한다. 고지는 배포물 루트의 `THIRD-PARTY-NOTICES.txt`와 앱 설정 화면에서 볼 수 있다. YouTube URL 임포트는 개인 사용 목적의 기능이며, 콘텐츠 이용 약관과 저작권 준수는 사용자 책임이다.

이슈: https://github.com/mintonnee/karaoke-player/issues
