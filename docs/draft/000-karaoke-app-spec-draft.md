# 로컬 노래방 앱 — 기획서 (v0.1)

> 이 문서는 Claude Code가 프로젝트를 부트스트랩하고 슬라이스 단위로 구현하기 위한 기준 문서다.
> 결정 사항은 "결정"으로, 아직 열린 항목은 "미정"으로 표기한다. 미정 항목은 구현 전에 사용자에게 묻는다.

---

## 1. 한 줄 요약

로컬 음원 파일을 Demucs로 보컬/반주 분리한 뒤, 반주 + 가이드 보컬 + 싱크 가사 + 키 변경으로 노래방처럼 부를 수 있게 하는 데스크탑 앱. 모든 처리는 로컬에서 수행하며 외부 업로드 없음.

## 2. 목표 / 비목표

**목표 (v1)**

- 로컬 오디오 파일(MP3/WAV/FLAC/M4A) 임포트 → 2-stem 분리 (vocals / no_vocals)
- 반주 재생, 가이드 보컬 볼륨 조절(기본 -20 dB, 뮤트 가능), 루프, 시크
- 가사 표시 및 줄 단위 하이라이트 (LRCLIB 동기 가사 → 없으면 텍스트 + forced alignment)
- 키 변경 (±6 반음), 템포는 v1 범위 밖
- 라이브러리: 처리한 곡 목록, 재처리 없이 재생, 삭제
- Windows 우선, macOS 빌드 가능해야 함

**비목표 (v1에서 제외, 확장 포인트만 남김)**

- 마이크 모니터링 / 에코 / 리버브 → v2, 네이티브 오디오 엔진과 함께
- 채점 → v2
- ~~YouTube 등 URL 다운로드 → 하지 않음. 로컬 파일 전용으로 고정~~ → 2026-09-02 결정 변경: zip 배포 채널 한정으로 도입 (상세는 `docs/specs/001-packaging-distribution.md`)
- 6-stem 분리, 멀티트랙 믹서 UI
- 단어 단위 가사 하이라이트 (줄 단위 + 줄 내 진행바로 대체)

## 3. 기술 스택 (결정)

| 영역            | 선택                                | 비고                                                    |
| --------------- | ----------------------------------- | ------------------------------------------------------- |
| 셸              | Electron + TypeScript               | electron-vite 템플릿                                    |
| 렌더러          | React + Vite                        | 상태는 zustand, UI 라이브러리 없음                      |
| 메인 프로세스   | TypeScript                          | 사이드카 프로세스 관리, 파일 시스템, DB                 |
| 오디오 (v1)     | Web Audio API + AudioWorklet        | `AudioEngine` 인터페이스 뒤에 숨김                      |
| 피치 시프트     | soundtouchjs (WASM/Worklet)         | Rubber Band WASM으로 교체 가능하게                      |
| 분리            | Python 사이드카 + Demucs            | 모델 `htdemucs_ft`, `--two-stems=vocals`                |
| 가사 정렬       | Python 사이드카 + torchaudio MMS_FA | 일본어는 pyopenjtalk로 가나 변환 후 정렬 (기본 설치)    |
| 전사 (fallback) | faster-whisper                      | 가사 텍스트가 전혀 없을 때만                            |
| 가사 소스       | LRCLIB API                          | https://lrclib.net/api                                  |
| DB              | SQLite (better-sqlite3)             | 라이브러리 메타데이터                                   |
| Python 관리     | uv                                  | `sidecar/pyproject.toml`                                |
| 패키징          | electron-builder                    | Python 런타임 번들은 v1 후반 슬라이스                   |

**GPU**: 개발 머신은 RTX 5090. torch는 CUDA 빌드 기본, `KARAOKE_DEVICE=cpu|cuda|mps`로 강제 가능.

## 4. 아키텍처

```
┌─────────────────────── Electron ────────────────────────┐
│  Renderer (React)                                        │
│   ├─ LyricsView      ← engine.onPosition               │
│   ├─ Transport       → engine.play/seek/setPitch        │
│   └─ LibraryView     → ipc: library.*                   │
│            │ AudioEngine (interface)                     │
│            └─ WebAudioEngine (v1)   [NativeEngine (v2)]  │
│──────────────────────────────────────────────────────────│
│  Main (TS)                                               │
│   ├─ SidecarManager  — python 프로세스 spawn, JSONL 프로토콜 │
│   ├─ LibraryStore    — SQLite + 파일 레이아웃            │
│   ├─ LyricsService   — LRCLIB fetch, LRC 파싱/저장       │
│   └─ JobQueue        — 분리/정렬 작업 직렬화 (동시 1개)   │
└──────────────────────────────────────────────────────────┘
                 │ stdin/stdout JSONL
┌────────────── Python sidecar (uv) ──────────────┐
│  karaoke_worker separate|align|transcribe|probe │
│   Demucs / ctc-forced-aligner / faster-whisper  │
└─────────────────────────────────────────────────┘
```

### 4.1 AudioEngine 인터페이스 (결정 — 변경 시 반드시 문서 갱신)

렌더러의 어떤 코드도 `AudioContext`를 직접 만지지 않는다. 오직 `WebAudioEngine` 내부에서만 사용한다.

```ts
export interface AudioEngine {
  /** 파일 경로를 받는다. 버퍼를 넘기지 않는다 (네이티브 엔진 호환). */
  load(tracks: { inst: string; vocal: string }): Promise<void>
  play(): void
  pause(): void
  stop(): void // pause + seek(0)
  seek(seconds: number): void
  setLoop(range: { start: number; end: number } | null): void

  setGain(track: 'inst' | 'vocal', db: number): void // -inf 허용 (mute)
  setPitch(semitones: number): void // -6..+6

  /** 엔진이 push하는 유일한 시간 소스. 렌더러는 이 값 + 경과시간으로 보간한다. */
  onPosition(cb: (seconds: number) => void): () => void
  onEnded(cb: () => void): () => void

  readonly duration: number
  readonly state: 'idle' | 'loading' | 'ready' | 'playing' | 'paused'
  dispose(): void
}
```

제약:

- 제어 명령은 control-rate(초당 수십 회)만 가정. 샘플 단위 조작이 필요한 기능은 인터페이스에 넣지 말고 엔진 내부 기능으로 정의한다.
- `onPosition`은 60 Hz 이하로 push. 렌더러가 폴링하지 않는다.
- `load`는 디스크 경로만 받는다. Web 구현체는 내부에서 `fetch(media://)` + `decodeAudioData`. (`file://` fetch는 webSecurity에 막히므로 메인이 `media://` 커스텀 프로토콜로 tracks 디렉토리 밑 파일만 서빙한다)

### 4.2 사이드카 프로토콜 (결정)

메인이 `uv run karaoke_worker <cmd> --json` 을 spawn. stdout은 한 줄에 하나의 JSON.

```jsonc
// 진행
{"type":"progress","stage":"separate","pct":42,"msg":"..."}
// 완료
{"type":"done","result":{...}}
// 오류
{"type":"error","code":"CUDA_OOM","msg":"..."}
```

명령:

- `probe --input <path>` → `{duration, sample_rate, channels, title?, artist?, album?}` (mutagen)
- `separate --input <path> --out <dir> [--model htdemucs_ft] [--device auto] [--shifts 1]` → `{inst: path, vocal: path}` (파일 경계 아티팩트 완화를 위해 앞뒤 1초 무음 패딩 후 분리하고 잘라낸다)
- `align --vocal <path> --lyrics <txt> --lang ja|ko|en --out <lrc>` → `{lrc: path, lines:[{t, text, conf}]}`
- `transcribe --vocal <path> --lang auto --out <txt>` → `{txt: path}`
- `pronounce --lyrics <txt> --out <json>` → `{out: path, lines:[{text, hint}]}` (일본어 줄의 한글 통용 표기 발음. 가사 힌트와 검색 키 생성에 사용)
- `cover --input <audio> --out <img>` → `{cover: path | null}` (mutagen으로 내장 앨범 아트 추출. 없으면 null)

stderr는 로그로만 사용. 취소는 SIGTERM, 워커는 부분 산출물을 삭제한 뒤 종료.

### 4.3 데이터 레이아웃 (결정)

```
<userData>/
├─ library.sqlite
└─ tracks/<track_id>/
   ├─ source.<ext>        # 원본 복사본
   ├─ inst.wav
   ├─ vocal.wav
   ├─ lyrics.txt          # 원문 (사용자 입력 또는 LRCLIB plain)
   ├─ lyrics.lrc          # 최종 싱크 가사 (수동 보정 반영)
   └─ meta.json           # 모델/버전/처리 시각
```

SQLite `tracks`: `id, title, artist, album, duration, source_path, status(imported|separating|ready|failed), lyrics_source(lrclib_synced|lrclib_plain_aligned|user_aligned|none), created_at, updated_at`

### 4.4 가사 파이프라인

```
임포트
 └─ probe로 메타 추출 → LRCLIB /api/get (title, artist, album, duration)
      ├─ syncedLyrics 있음 → lyrics.lrc 저장, 끝
      ├─ plainLyrics만 있음 → lyrics.txt → align → lyrics.lrc
      └─ 없음 → 사용자에게 가사 붙여넣기 요청 (UI) → align
                 └─ 사용자가 거부 → transcribe → 사용자 교정 → align
```

정렬 전처리:

- `×2`, `(x2)`, `[Chorus]` 등 구조 표기 제거/전개
- 빈 줄 제거, 한 줄 = 한 하이라이트 단위
- 일본어: pyopenjtalk로 한자→가나 변환한 텍스트로 정렬하되, 표시는 원문 유지
- 줄별 conf는 토큰 확률의 기하평균(0..1). 가창은 발화보다 값이 낮아 `conf < 0.1`을 UI 경고 임계값으로 쓴다. 경고 줄은 탭으로 시작점 수동 지정 가능

LRC 포맷: `[mm:ss.xx] 가사` 줄 단위. 줄 내 진행바는 (다음 줄 시각 − 현재 줄 시각)에 비례.

## 5. 슬라이스 (구현 순서)

각 슬라이스는 독립 PR 크기. 완료 조건(DoD)을 만족해야 다음으로 넘어간다.

### S0 — 스캐폴드

- S0.1 electron-vite + React + TS + zustand 프로젝트 생성, `pnpm dev`로 빈 창
- S0.2 `sidecar/` uv 프로젝트, `karaoke_worker probe` 구현 (mutagen)
- S0.3 메인의 `SidecarManager`: spawn, JSONL 파싱, 취소, 타임아웃. 단위 테스트 포함
- DoD: 렌더러에서 파일을 고르면 duration/title이 화면에 뜬다

### S1 — 분리

- S1.1 `separate` 명령: Demucs `htdemucs_ft --two-stems=vocals`, 진행률 파싱(stderr의 tqdm)
- S1.2 `JobQueue`: 동시 1개, 상태를 SQLite에 반영, 앱 재시작 시 `separating` 상태를 `failed`로 정리
- S1.3 임포트 UI: 드롭존 → 진행 바 → 완료
- DoD: 3분 곡을 임포트하면 `inst.wav`, `vocal.wav`가 생기고 라이브러리에 `ready`로 표시된다

### S2 — 재생 엔진 (Web Audio)

- S2.1 `AudioEngine` 인터페이스 파일 + `WebAudioEngine` 구현: load/play/pause/seek/setGain/onPosition
- S2.2 Transport UI: 재생/일시정지/정지, 시크바, inst/vocal 페이더(기본 vocal −20 dB), vocal 뮤트 토글
- S2.3 루프 구간 (드래그로 지정)
- DoD: 렌더러 어디에서도 `AudioContext`를 import하지 않는다 (lint rule로 강제). 가이드 보컬 토글이 클릭 없이 즉시 반영된다

### S3 — 라이브러리

- S3.1 목록/검색/삭제, 삭제 시 디렉토리 정리
- S3.2 메타 편집 (title/artist/album) — LRCLIB 조회 정확도에 영향
- DoD: 앱 재시작 후에도 곡이 남아 있고 재처리 없이 재생된다

### S4 — 가사 (동기 가사 있는 경우)

- S4.1 `LyricsService`: LRCLIB `/api/get` → 없으면 `/api/search`, 결과를 `lyrics.lrc`/`lyrics.txt`로 저장
- S4.2 LRC 파서 + `LyricsView`: 현재 줄 하이라이트, 줄 내 진행바, 자동 스크롤. 시간 소스는 `engine.onPosition`만 사용
- DoD: LRCLIB에 syncedLyrics가 있는 곡은 임포트 직후 가사가 싱크되어 표시된다

### S5 — 가사 정렬 (동기 가사 없는 경우)

- S5.1 `align` 명령: ctc-forced-aligner, 언어별 전처리(§4.4), 줄별 conf 출력
- S5.2 가사 입력 UI: 붙여넣기 → 정렬 실행 → 결과 표시
- S5.3 수동 보정: conf 낮은 줄 표시, 재생 중 탭으로 줄 시작점 지정, `lyrics.lrc` 갱신
- S5.4 `transcribe` fallback (faster-whisper) + 교정 후 정렬
- DoD: plain 가사만 있는 일본어 곡에서 줄 시작 오차가 체감상 0.3초 이내, 틀린 줄은 탭 한 번으로 고쳐진다

### S6 — 키 변경

- S6.1 soundtouchjs를 AudioWorklet으로 통합, `setPitch` 구현, inst/vocal 양쪽에 동일 적용
- S6.2 UI: ±6 반음 스텝, 원키 리셋
- DoD: 재생 중 키를 바꿔도 끊김/드리프트 없이 위치가 유지된다

### S7 — 패키징

- S7.1 electron-builder Windows(NVIDIA/CPU) 빌드
- S7.2 Python 런타임 + 모델 첫 실행 시 다운로드 (StemDeck 방식 참고)
- DoD: 클린 Windows 머신에서 설치 → 첫 곡 처리까지 완료
- 상세 스펙: `docs/specs/001-packaging-distribution.md` (zip/MSIX 이중 타깃, uv 부트스트랩, zip 한정 URL 임포트)

### v2 (설계만, 구현 안 함)

- S8 네이티브 오디오 엔진 사이드카 (Rust cpal 또는 C++ miniaudio): `AudioEngine` 구현체를 IPC로 제공, 마이크 모니터링 + 에코. 도입 시 재생도 네이티브로 이관하고 Web 구현체는 fallback으로 강등
- S9 채점: 렌더러에서 getUserMedia(에코캔슬/AGC/노이즈억제 모두 off) → pYIN WASM → `vocal.wav`에서 사전 추출한 피치 곡선과 비교. 사이드카 불필요

## 6. 설정

| 변수                       | 기본          | 설명                                           |
| -------------------------- | ------------- | ---------------------------------------------- |
| `KARAOKE_DEVICE`           | auto          | torch 디바이스 강제                            |
| `KARAOKE_DEMUCS_MODEL`     | `htdemucs_ft` | Demucs 모델명                                  |
| `KARAOKE_DEMUCS_SHIFTS`    | 2             | 랜덤 시프트 평균화 횟수 (품질↑ 처리시간 배수↑) |
| `KARAOKE_PYTHON`           | (번들)        | 개발 시 uv 환경 파이썬 경로                    |
| `KARAOKE_MAX_DURATION_SEC` | 900           | 초과 시 임포트 거부                            |
| `KARAOKE_GUIDE_VOCAL_DB`   | -20           | 가이드 보컬 기본 게인                          |

## 7. 결정 기록

- Electron을 Tauri 대신 선택: 기존 Electron 경험, v1에 네이티브 오디오가 필요 없음. 네이티브가 필요해지면 사이드카로 붙이며 셸은 유지
- 2-stem `htdemucs_ft`를 `htdemucs_6s` 대신 선택: 보컬 품질과 속도 모두 유리, 6-stem은 비목표
- 로컬 파일 전용: URL 다운로드 기능은 법적 리스크만 늘리고 핵심 가치와 무관
- 줄 단위 하이라이트: 일본어 단어 경계 문제와 정렬 정확도를 고려한 현실적 선택. 실제 노래방 기기와 동일한 UX
- 오디오 엔진 인터페이스를 S2에서 먼저 고정: v2 네이티브 전환 비용을 렌더러 0 변경으로 묶기 위함
- 가사 정렬을 ctc-forced-aligner 대신 torchaudio 내장 MMS_FA로 구현 (2026-09-01): 같은 MMS 정렬 모델이지만 ctc-forced-aligner는 PyPI에 없고(git 설치) pybind11 소스 빌드가 필요해 MSVC 없는 환경에서 설치 불가. torchaudio는 이미 의존성에 있어 추가 빌드가 없다. 정렬 결과 conf는 align.json으로 트랙 디렉토리에 저장
- "URL 다운로드 하지 않음" 결정을 뒤집음 (2026-09-02, 사용자 결정): 개인 사용 목적의 YouTube URL 임포트를 zip 배포 채널 한정으로 도입. 리스크는 배포 채널 분리로 관리 — Microsoft Store(MSIX)판에는 yt-dlp를 포함하지 않는다. 상세는 `docs/specs/001-packaging-distribution.md`

## 8. 미정 (구현 전 확인)

- [ ] 렌더러 UI 프레임워크: React로 가정. 다른 선호가 있으면 S0 전에 변경
- [ ] Rubber Band vs SoundTouch: 품질 차이가 체감되면 S6에서 교체. 라이선스(Rubber Band GPL/상용) 확인 필요
- [ ] 한국어 가사 정렬 품질: ctc-forced-aligner(MMS)의 한국어 성능 미검증. S5.1에서 실제 곡으로 확인
- [ ] macOS 빌드 우선순위: v1은 Windows 검증만, macOS는 CI 빌드만 통과시킬지
- [ ] 분리 모델 교체 검토: htdemucs_ft는 곡 초반(인트로 조용한 구간)에 특유의 지터가 남는다 (실청감 확인 2026-08-31, 무음 패딩·shifts=2로도 제거 불가, 완화만 됨). 계속 거슬리면 BS-RoFormer/Mel-RoFormer 계열 검토 — §3 결정 변경이므로 사용자 승인 필요

## 9. Claude Code 작업 규칙

- 슬라이스 순서대로 진행하고, 한 슬라이스 안에서 다음 슬라이스 코드를 미리 쓰지 않는다
- `AudioEngine` 인터페이스 변경은 이 문서 §4.1을 먼저 고친 뒤 코드를 바꾼다
- 렌더러에서 `AudioContext`, `AudioWorklet` 직접 참조 금지 (ESLint `no-restricted-globals`로 강제)
- 사이드카 명령 추가/변경은 §4.2 표를 갱신한다
- 미정 항목에 걸리는 결정은 임의로 하지 말고 질문한다
- 각 슬라이스 완료 시 DoD를 체크리스트로 보고한다
