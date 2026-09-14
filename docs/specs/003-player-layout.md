# Karaoke Player 플레이어 레이아웃 재구성 스펙

곡별 조정키 자동 저장·복원은 `006-track-pitch.md`를 따른다.

- 작성일: 2026-09-02
- 연관 스펙: `000-karaoke-app-spec-draft.md`, `002-bpm-key-analysis.md`
- 대상: 000 §5 S2.2(Transport UI)·S6.2(키 변경 UI)의 화면 배치, 002 §4.3 트랜스포트 키 표시, 000 §4.1 `AudioEngine` 인터페이스(레벨 push 추가)

이 문서는 000에서 트랜스포트 바 한 줄에 몰아 두었던 음량 페이더와 키 컨트롤을 오른쪽 세로 컬럼(믹서 패널 + 키 패널)으로 옮기고, 트랜스포트 바에는 재생 컨트롤·시간·BPM만 남기는 화면 재구성을 다룬다. 믹서 패널에는 재생 레벨 미터를 함께 넣는다(2026-09-02 추가). 오디오 엔진은 레벨 탭 추가 외에는 바꾸지 않고, 재생 상태 저장소(`playerStore`), 단축키 동작, 라이브러리·가사 패널의 내용은 바꾸지 않는다.

## 1. 목표와 비목표

```text
곡을 재생하면서 오른쪽 믹서 패널의 세로 페이더로 반주 음량을 내리고 키 패널의 + 를 두 번 누르면,
키 패널 상단에 원키 C#m, 가운데 +2, 하단에 D#m이 보이고 트랜스포트 바에는 재생 버튼·시간·"128 BPM"만 남아 있다.
```

**목표**

| 영역        | 내용                                                                                                                                                                      |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 레이아웃    | 앱을 2행 3열 grid로 바꾼다. 1열 노래 리스트, 2열 가사, 3열 사이드 컬럼(고정 폭). 트랜스포트 바는 1–2열 아래에만 깔리고 사이드 컬럼은 두 행에 걸쳐 전체 높이를 쓴다        |
| 사이드 툴바 | 사이드 컬럼 맨 위에 설정(톱니)과 단축키 도움말(`/`) 버튼을 둔다. 라이브러리 헤더의 설정 버튼은 여기로 옮긴다                                                              |
| 믹서 패널   | 메인·반주·보컬 세 개의 세로 페이더(−60–0 dB)와 각 페이더 아래 뮤트 토글. dB 값을 숫자로 함께 표시한다. 기존 가로 페이더·뮤트 버튼의 상태와 아이콘을 그대로 옮긴다         |
| 키 패널     | 상단 상자 = 원키, 가운데 줄 = `−` / 리셋 버튼(현재 반음 수 표시) / `+`, 하단 상자 = 변경 키. 002 §4.3의 `C#m → D#m` 텍스트 표기를 이 두 상자로 대체한다                   |
| 트랜스포트  | 페이더·키 컨트롤을 제거하고 시간 옆에 BPM 칩을 추가한다. 표기는 라이브러리 행과 같은 규칙(`128 BPM`, 저신뢰 `?`)을 공용 헬퍼로 공유한다                                   |
| 창 크기     | 사이드 컬럼이 들어가도 가사 패널이 일본어 후리가나 줄을 접지 않도록 창 최소 폭을 올린다                                                                                   |
| 라벨 통일   | "전체"를 "메인"으로 통일한다(믹서 라벨, 뮤트 툴팁, 단축키 도움말)                                                                                                         |
| 레벨 미터   | 믹서의 각 페이더 옆에 재생 레벨 막대를 그린다. 반주·보컬은 post-fader(트랙 게인 뒤), 메인은 피치 노드 출력(실제 스피커 출력)에서 읽는다. 엔진이 위치와 같은 틱에 push한다 |
| 빈 상태     | 곡이 없거나 로딩 중일 때도 사이드 컬럼·트랜스포트의 구조는 동일하고 컨트롤만 비활성화한다(000 S2 이후 유지해 온 "레이아웃 점프 방지" 원칙)                                |

**비목표**

| 항목                                             | 제외 이유                                                                 |
| ------------------------------------------------ | ------------------------------------------------------------------------- |
| 사이드 컬럼 접기/펼치기                          | 창 최소 폭을 올리는 것으로 충분하다. 좁은 화면 요구가 확인되면 후속       |
| 패널 폭 드래그 조절·비율 저장                    | 고정 비율(3:2 + 고정 폭)로 시작한다. 조절 요구가 확인되면 후속            |
| 음량·뮤트·키 값의 재시작 후 유지                 | `playerStore`는 세션 단위다. 영속화는 000 §6 설정과 함께 별도 결정        |
| BPM 칩 클릭 동작(탭 템포, 템포 변경)             | 000 §2 "템포는 v1 범위 밖". BPM은 표시 전용(002 결정 유지)                |
| 라이브러리 행의 `BPM · 키` 표기 변경             | 002 §4.3 그대로 둔다. 트랜스포트와 중복 표시지만 목록 탐색 시 필요하다    |
| 단축키 추가·변경                                 | 기존 ↑↓·Ctrl·Alt·−·=·M·V·L 그대로. 라벨만 "메인"으로 바뀐다               |
| 게인 법칙·dB 범위 변경                           | 000 S2 결정(−60–0 dB, inst+master 합산) 유지. 페이더 방향만 세로로 바뀐다 |
| 가사 패널 하단 도구 막대·라이브러리 헤더 개편    | 설정 버튼 이동 외에는 손대지 않는다                                       |
| 터치·반응형(1040px 미만) 대응                    | 데스크톱 전용 앱. 최소 폭 아래는 지원하지 않는다                          |
| 피크 홀드·클립 LED, pre-fader 미터 전환          | RMS 막대 하나로 "지금 들리는 양"은 충분하다. 요구가 확인되면 후속         |
| 스펙트럼·파형 표시                               | 노래방 핵심 가치와 무관. 채점(000 S9) 설계 때 함께 검토                   |
| 렌더러의 `AudioContext`·`AnalyserNode` 직접 접근 | 000 §4.1 제약(렌더러는 엔진 인터페이스만 본다). 탭은 엔진 내부에 둔다     |

**결정 기록**

- 사이드 컬럼은 고정 폭 160px, 창 최소 폭은 960에서 1040으로 올린다 (2026-09-02, 사용자 승인). 1040에서 gap·padding을 빼면 1–2열에 약 830px가 남아 현재 비율(3:2) 기준 가사 패널 약 330px를 확보한다.
- 사이드 컬럼은 전체 높이를 쓰고 트랜스포트 바는 1–2열 아래에만 깔린다 (와이어프레임대로). 세로 페이더에 높이가 필요하고, 트랜스포트 바가 전폭일 이유가 없다.
- 키 패널 구조는 사용자 결정: 상단 상자 원키, 가운데 줄 `−` / 리셋 버튼 / `+`, 하단 상자 변경 키. 리셋 버튼이 현재 반음 수(`0`, `+2`, `−3`)를 표시하고 누르면 0으로 돌아간다. 기존 "원키" 버튼은 없앤다.
- 상자 색: 원키 상자는 항상 파란 계열, 변경 키 상자는 `pitch === 0`이면 중립색(원키와 같은 값), 이동 중이면 붉은 계열로 강조한다. 원키를 모르는 곡(`musicKey === null`)은 두 상자 모두 `—`를 표시해 구조를 유지한다. 반음 수와 `−`/`+`는 원키 유무와 무관하게 동작한다.
- 세로 페이더는 라이브러리 없이 `<input type="range">`에 `writing-mode: vertical-lr; direction: rtl`을 적용한다(위가 0 dB). Electron 39의 Chromium이 지원한다. 페이더 상단에 라벨, 하단에 dB 숫자와 뮤트 버튼을 둔다.
- BPM 칩은 시간 표시 왼쪽에 둔다. 값이 없으면 `—`를 넣어 칩 자리를 유지한다. 저신뢰는 `128 BPM?`(002 `BPM_LOW_CONF`).
- 설정과 도움말은 사이드 컬럼 상단 툴바로 옮긴다. 톱니 하나만 떠 있으면 고아처럼 보이므로 `/` 도움말 버튼과 함께 둔다. 라이브러리 헤더에는 `+ 가져오기`와 URL 버튼만 남는다.
- 스타일은 컴포넌트별 CSS 파일(`mixer.css`, `key-panel.css`)로 나누고 `main.css`가 `@import`한다. 슬라이스 간 `main.css` 경합을 피하기 위한 분할이다.
- 레벨 미터는 `AnalyserNode` 탭으로 구현한다 (2026-09-02, 사용자 요청). 각 트랙 게인 뒤와 피치 노드 뒤에 옆가지로 `connect`만 추가하므로 재생 경로·위치 추적에 영향이 없다. `fftSize` 256, `getFloatTimeDomainData`의 RMS를 dB로 바꾼다(무음은 −60 dB로 클램프). 계산은 `audioMath.ts` 순수 함수로 두어 단위 테스트한다.
- 반주·보컬 미터는 post-fader다. 뮤트하면 0, 페이더를 내리면 같이 내려가 "지금 들리는 양"을 보여 준다. 메인 미터는 피치 노드 출력에서 읽어 메인 볼륨·메인 뮤트(트랙 게인에 합산됨)가 자연히 반영된다. 반주·보컬 미터는 피치 워클릿 앞이라 소리보다 워클릿 지연만큼 앞서지만 눈으로 구분되지 않는다.
- 레벨은 엔진이 push한다. `AudioEngine`에 `onLevels(cb)`를 추가하고 기존 위치 push 타이머(30 Hz)와 같은 틱에서 `{inst, vocal, master}` dB를 보낸다. 000 §4.1 "렌더러가 폴링하지 않는다" 제약을 지키고, 네이티브 엔진(000 S8)이 IPC로 push하는 형태와도 맞는다. 일시정지·정지·언로드 시 마지막으로 −60을 한 번 push해 막대를 내린다.
- 미터 눈금은 페이더와 같은 −60–0 dB 선형 매핑이다. 막대 높이는 CSS `height: %`로 그리고 33 ms transition으로 틱 사이를 잇는다. 캔버스는 쓰지 않는다.
- 성공 기준이 우선이고 grid 정의·컴포넌트 분할 방식은 자유다. 단, `playerStore`의 상태·액션 시그니처는 바꾸지 않는다. 레벨은 스토어 상태를 거치지 않는다(30 Hz 갱신으로 전체 리렌더를 일으키지 않기 위함). 스토어는 엔진의 `onLevels`를 감싼 구독 함수 하나만 노출한다.

## 2. 성공 기준

1. 창을 1040×600으로 줄여도 노래 리스트·가사·사이드 컬럼(160px)이 한 화면에 보이고, 트랜스포트 바 안의 요소가 줄바꿈하지 않으며, 가로 스크롤이 생기지 않는다. `src/main/index.ts`의 `minWidth`가 1040이라 그보다 작게 줄어들지 않는다.
2. 사이드 컬럼 상단 툴바의 톱니를 누르면 설정 모달이 열리고, `/` 버튼을 누르면 단축키 도움말이 열린다(키보드 `/`와 같은 토글). 라이브러리 헤더에는 설정 버튼이 없다.
3. 믹서 패널에 메인·반주·보컬 세 개의 세로 페이더가 라벨·dB 숫자와 함께 보인다. 반주 페이더를 아래로 끌면 숫자가 내려가고 재생 중 반주 음량이 실제로 줄어든다. 각 페이더 아래 뮤트 버튼을 누르면 붉은 강조가 켜지고 페이더가 비활성화되며, 키보드 ↑↓(메인)·Ctrl+↑↓(반주)·Alt+↑↓(보컬)를 누르면 해당 페이더와 숫자가 함께 움직인다.
4. 원키 `C#m`인 곡을 로드하면 키 패널 상단 상자에 `C#m`, 가운데 리셋 버튼에 `0`, 하단 상자에 중립색 `C#m`이 보인다. `+`를 두 번 누르면 리셋 버튼이 `+2`, 하단 상자가 붉은 강조의 `D#m`이 되고, 리셋 버튼을 누르면 처음 상태로 돌아간다. 원키가 없는 곡(메타 편집에서 키를 비움)은 두 상자에 `—`가 보이지만 `+`/`−`와 반음 수는 그대로 동작한다.
5. 트랜스포트 바에는 커버·제목·아티스트, 재생/정지/루프 버튼, BPM 칩, 시간만 있고 페이더와 키 컨트롤이 없다. BPM 칩은 라이브러리 행과 같은 값(`128 BPM`, 저신뢰 `128 BPM?`)을 보이고, 값이 없는 곡은 `—`를 보인다.
6. 곡을 선택하지 않은 상태에서 믹서·키 패널의 모든 컨트롤이 비활성화돼 있고, 곡을 로드해도 사이드 컬럼과 트랜스포트 바의 높이·위치가 바뀌지 않는다(창 크기 고정 후 스크린샷 비교).
7. 단축키 도움말과 믹서 라벨·툴팁 어디에도 "전체"가 남아 있지 않고 "메인"으로 통일돼 있다. `grep -rn "전체 " src/renderer`에서 음량·뮤트 관련 결과가 0건이다.
8. `pnpm typecheck && pnpm lint && pnpm test`가 exit 0이다. 기존 테스트(`musicKey.test.ts`, `AnalysisService.test.ts` 등)는 수정 없이 통과하고, BPM 표기 헬퍼의 단위 테스트(정상·저신뢰·null)와 레벨 계산 순수 함수의 단위 테스트(정현파 RMS, 무음 클램프, 0 dBFS 상한)가 추가돼 통과한다.
9. 곡을 재생하면 믹서의 세 페이더 옆 미터가 소리에 맞춰 움직인다. 반주를 뮤트하면 반주 미터만 0으로 내려가고 메인 미터는 보컬만큼만 남는다. 메인 페이더를 −60까지 내리면 메인 미터가 0이 된다. 일시정지하면 모든 미터가 0으로 내려가고 재개하면 다시 움직인다. 미터가 움직이는 동안 재생 위치·가사 하이라이트가 끊기지 않는다.

## 3. 전제 조건

| 전제                                                                 | source of truth / 확인 방법                                                                                                                               |
| -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 앱 셸은 `.app`(flex column) > `.main-area`(flex row) + 트랜스포트    | `src/renderer/src/App.tsx` 386행 부근, `src/renderer/src/assets/main.css` `.app`·`.main-area`·`.panel`. 라이브러리 `flex: 3`, 가사 `flex: 2`              |
| 페이더·키 컨트롤은 `Transport.tsx` `.player-controls` 안에 있음      | `src/renderer/src/components/Transport.tsx`, CSS `.fader`·`.fader-row`·`.pitch-control`·`.pitch-key`                                                      |
| 재생 상태와 액션은 `playerStore`가 제공                              | `src/renderer/src/stores/playerStore.ts`: `instDb`·`vocalDb`·`masterDb`·`*Muted`·`pitch`, `setInstDb`·`setVocalDb`·`setMasterDb`·`toggle*Mute`·`setPitch` |
| 변조 키·표기 헬퍼                                                    | `src/shared/musicKey.ts` `formatKeyDisplay`, `transposeKey`, `lowConfSuffix`. BPM 표기 `formatBpmDisplay`는 현재 `App.tsx` 안의 지역 함수                 |
| 설정 모달·도움말은 `App.tsx` 상태(`showSettings`, `showHelp`)로 열림 | `App.tsx` 260행 부근, `SettingsModal.tsx`, `ShortcutHelp.tsx`. 키보드 `/`가 `showHelp` 토글                                                               |
| 단축키 라벨은 `ShortcutList.tsx` 한 곳                               | 설정 모달과 `/` 오버레이가 공유한다                                                                                                                       |
| 창 최소 크기                                                         | `src/main/index.ts` `BrowserWindow({ minWidth: 960, minHeight: 600 })`                                                                                    |
| 세로 range 입력 네이티브 지원                                        | Electron 39.8(`node_modules/electron/dist/version`) = Chromium 14x. `writing-mode: vertical-lr`이 range 입력에 적용된다(Chromium 124+)                    |
| 렌더러 테스트는 vitest, 순수 함수 대상                               | `src/shared/__tests__/musicKey.test.ts` 패턴. 컴포넌트 렌더링 테스트 도구(testing-library)는 없다                                                         |
| 포맷·린트                                                            | `pnpm format`(prettier), `pnpm lint`(eslint). lefthook 없음                                                                                               |
| 엔진 그래프 `source → trackGain → mixBus → pitchNode → destination`  | `src/renderer/src/audio/WebAudioEngine.ts` `ensurePitchGraph`·`createGain`. `load`가 피치 그래프를 await하므로 트랙 게인은 항상 `mixBus`에 연결된다       |
| 위치 push 타이머 30 Hz                                               | `WebAudioEngine.ts` `POSITION_PUSH_INTERVAL_MS = 33`. 레벨 push를 같은 틱에 붙인다                                                                        |
| 엔진 단위 테스트는 `audioMath.test.ts`뿐                             | `src/renderer/src/audio/__tests__/`. `WebAudioEngine` 자체는 테스트가 없어 mock 갱신이 필요 없다                                                          |
| 렌더러는 엔진 인스턴스를 `playerStore`를 통해서만 만진다             | `src/renderer/src/stores/playerStore.ts`가 `WebAudioEngine`을 생성해 보유한다. 컴포넌트는 엔진을 import하지 않는다                                        |

## 4. 기능 범위

### 4.1 레이아웃 grid

- `.app`을 `display: grid; grid-template-columns: 3fr 2fr 160px; grid-template-rows: minmax(0, 1fr) auto; gap: 12px`로 바꾼다. `.main-area` 래퍼는 없애거나 `display: contents`로 둔다.
- 노래 리스트 패널 = 1행 1열, 가사 패널 = 1행 2열, 트랜스포트 바 = 2행 1–2열, 사이드 컬럼 = 1–2행 3열.
- 사이드 컬럼(`.side-column`)은 flex column: 툴바(설정·도움말) → 믹서 패널(`.panel`, `flex: 1`) → 키 패널(`.panel`). 두 패널은 기존 `.panel` 스타일(테두리, 12px 라운드)을 재사용한다.
- `src/main/index.ts` `minWidth: 1040`.

### 4.2 믹서 패널 (`MixerPanel.tsx`)

- 세로 페이더 3개: 순서 메인·반주·보컬. 각각 `<input type="range" min=-60 max=0 step=1>`에 `writing-mode: vertical-lr; direction: rtl`. 라벨은 위, dB 숫자(`0 dB`, 뮤트 시 취소선)와 뮤트 버튼은 아래.
- 뮤트 아이콘과 상태 클래스는 기존 것을 옮긴다: 메인 `MdVolumeUp/Off`, 반주 `MdMusicNote/Off`, 보컬 `MdMic/Off`, 켜짐은 `.muted-on`(붉은 테두리). 툴팁에 단축키(M, V)를 유지한다.
- 비활성 규칙은 현재와 동일: `active`가 아니면 전부 disabled, 뮤트 중이면 해당 페이더 disabled.
- 레벨 미터: 각 페이더 오른쪽에 같은 높이의 `.meter` 트랙과 `.meter-fill` 막대. 컴포넌트가 마운트 시 `playerStore`의 `subscribeLevels`(§4.5)로 구독하고 언마운트 시 해제한다. 높이 = `(db + 60) / 60 * 100%`, −60 이하는 0. 막대 색은 −12 dB 위에서 노란색으로 바뀐다(클립 경고 대용, LED는 비목표). 값은 ref로 받아 DOM 스타일만 갱신하고 React 상태로 올리지 않는다.
- `ShortcutList.tsx`의 "전체 음량"·"전체 뮤트"를 "메인 음량"·"메인 뮤트"로 바꾼다.

### 4.3 키 패널 (`KeyPanel.tsx`)과 BPM 칩

- 키 패널: 상단 `.key-box.key-original`(파란 계열) → 가운데 `.key-row`(`−`, `.key-reset` 버튼, `+`) → 하단 `.key-box.key-current`(pitch 0이면 중립, 아니면 `.shifted` 붉은 계열). 값은 `formatKeyDisplay(track?.musicKey)`와 `transposeKey(track?.musicKey, pitch)`, null이면 `—`.
- 리셋 버튼 텍스트는 `pitch > 0 ? '+n' : 'n'`. `pitch === 0`이면 disabled. `−`/`+`의 ±6 경계 disabled는 기존 로직 유지.
- BPM 표기 헬퍼 `formatBpmDisplay(bpm, conf)`를 `App.tsx`에서 `src/shared/analysisFormat.ts`로 옮기고 단위 테스트를 추가한다. 라이브러리 행과 트랜스포트 칩이 같은 함수를 쓴다.
- `Transport.tsx`: `.player-controls` 블록(페이더 3개, `.pitch-control`)과 관련 import를 제거하고, `.player-transport`의 시간 앞에 `.transport-bpm` 칩을 넣는다. `.player-main`의 `flex-wrap`은 없앤다(줄바꿈할 요소가 없다).
- 002 §4.3의 트랜스포트 항목은 이 절로 대체된다. 002 성공 기준 5의 표시 문구는 "키 패널 상단 상자 `C#m`, 하단 상자 `D#m`"으로 읽는다(002에 개정 메모).

### 4.4 사이드 툴바와 설정 버튼 이동

- `.side-toolbar`: 오른쪽 정렬 `icon-btn` 두 개. 톱니(`MdSettings`) → `setShowSettings(true)`, 도움말(`MdHelpOutline`) → `setShowHelp(v => !v)`.
- 라이브러리 `.panel-header-actions`에서 설정 버튼을 제거한다. `+ 가져오기`와 URL 버튼은 그대로.

### 4.5 엔진 레벨 탭

- `AudioEngine`(000 §4.1)에 추가한다:

```ts
export interface AudioLevels {
  inst: number // dBFS RMS, −60–0. 트랙 게인 뒤(post-fader)
  vocal: number
  master: number // 피치 노드 출력(실제 출력)
}
/** 위치 push와 같은 틱(≤60 Hz)에 push. 정지·일시정지·언로드 시 −60을 한 번 push한다. */
onLevels(cb: (levels: AudioLevels) => void): () => void
```

- `WebAudioEngine`: `createGain`에서 게인 뒤에 `AnalyserNode`(fftSize 256)를 옆가지로 연결하고, `ensurePitchGraph`에서 `pitchNode` 뒤에 하나 더 붙인다. 위치 타이머 틱에서 세 analyser의 `getFloatTimeDomainData`를 읽어 `rmsDb`로 바꿔 push한다. 버퍼는 재사용한다(틱마다 할당하지 않는다). 구독자가 없으면 analyser를 읽지 않는다.
- `audioMath.ts`: `rmsDb(samples: Float32Array, floorDb = -60): number` 순수 함수. 무음·NaN은 `floorDb`, 0 dBFS 초과는 0으로 클램프.
- `dispose`·`stopSources`·`pause`에서 마지막 push(−60)와 analyser 해제를 잊지 않는다.
- `playerStore`: `subscribeLevels(cb): () => void`를 추가해 엔진의 `onLevels`를 그대로 넘긴다. 상태 필드는 추가하지 않는다.
- 000 §4.1 코드 블록에 `onLevels`를 추가하고 §7 결정 기록에 한 줄 남긴다(감독자, L3에서).

### 4.6 구현 슬라이스 (멀티 에이전트 감독용 경계)

| 슬라이스 | 산출물                                                                                                                                          | 소유(수정 가능) 경로                                                                                                                                                                                                                    | 수정 금지 경로                                                                                       | 선행 조건  | 상태 |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ---------- | ---- |
| L0       | 엔진 레벨 탭: `onLevels`, `AnalyserNode` 탭, `rmsDb` + 테스트, 스토어 `subscribeLevels` (§4.5)                                                  | `src/renderer/src/audio/AudioEngine.ts`, `src/renderer/src/audio/WebAudioEngine.ts`, `src/renderer/src/audio/audioMath.ts`, `src/renderer/src/audio/__tests__/audioMath.test.ts`, `src/renderer/src/stores/playerStore.ts`              | `components/**`, `App.tsx`, `main.css`, `src/main/**`, `src/shared/**`, `docs/**`                    | 없음       | 완료 |
| L1       | 믹서 패널 컴포넌트·스타일, 레벨 미터, 단축키 라벨 "메인" (§4.2)                                                                                 | `src/renderer/src/components/MixerPanel.tsx`(신규), `src/renderer/src/assets/mixer.css`(신규), `src/renderer/src/components/ShortcutList.tsx`                                                                                           | `App.tsx`, `Transport.tsx`, `main.css`, `playerStore.ts`, `audio/**`, `src/main/**`, `src/shared/**` | L0         | 완료 |
| L2       | 키 패널 컴포넌트·스타일, BPM 헬퍼 승격 + 테스트, 트랜스포트에서 컨트롤 제거·BPM 칩 (§4.3)                                                       | `src/renderer/src/components/KeyPanel.tsx`(신규), `src/renderer/src/assets/key-panel.css`(신규), `src/renderer/src/components/Transport.tsx`, `src/shared/analysisFormat.ts`(신규), `src/shared/__tests__/analysisFormat.test.ts`(신규) | `App.tsx`, `main.css`, `MixerPanel.tsx`, `playerStore.ts`, `musicKey.ts`, `src/main/**`              | 없음       | 완료 |
| L3       | grid 레이아웃, 사이드 컬럼·툴바 마운트, 설정 버튼 이동, `App.tsx`의 BPM 헬퍼 import 전환, 창 최소 폭, README, 000 §4.1·§7 갱신 (§4.1·§4.4·§4.5) | `src/renderer/src/App.tsx`, `src/renderer/src/assets/main.css`(`@import` 추가·`.player-controls`·`.fader`·`.pitch-*` 규칙 제거), `src/main/index.ts`, `README.md`, `docs/draft/000-karaoke-app-spec-draft.md`                           | L0–L2 산출물(통합 시 버그가 있으면 해당 슬라이스에 재지시)                                           | L0, L1, L2 | 완료 |

- 완료 판정: L0 = 기준 8의 레벨 테스트, L1 = 기준 3·7·9의 컴포넌트 부분, L2 = 기준 4·5·8의 헬퍼 테스트, L3 = 기준 1·2·6과 나머지 전부(통합 후 수동 확인).
- 웨이브: L0과 L2가 병렬(1차) → L1(2차, L0이 보고한 `AudioLevels`·`subscribeLevels` 시그니처를 계약으로 받고 실제 코드도 읽고 시작) → L3(감독자 직접, 글루 통합·검증). L1과 L2는 `playerStore` 훅만 읽고 서로를 import하지 않는다.
- L0 에이전트는 보고에 `AudioLevels`·`onLevels`·`subscribeLevels` 최종 시그니처를 코드 블록으로 적는다.
- L1·L2가 `main.css`를 못 만지므로 각자 CSS 파일을 새로 만들고, L3가 `main.css`에 `@import`를 추가한다. 그 전까지 스타일이 안 먹는 것은 정상이다.
- 감독 규칙: 에이전트는 종료 전 §5 검증 명령을 실행해 exit code를 보고한다. `--no-verify` 등 훅 우회 금지. git 상태 변경(commit/stage)은 감독자 또는 사용자만 수행한다. 완료된 슬라이스는 재작업하지 않는다.
- 각 에이전트의 보고 형식: 생성·수정 파일 / export된 컴포넌트 props / 소유 밖에서 발견한 문제.

## 5. 검증 방법

```bash
pnpm typecheck && pnpm lint && pnpm test    # 기준 8 (회귀 + analysisFormat·rmsDb 단위 테스트)
grep -rn "전체 " src/renderer                # 기준 7 (음량·뮤트 관련 결과 0건)
pnpm dev                                     # 기준 1–6·9 수동 확인
```

- 기준 1 (수동): 창을 최소 크기까지 줄인다. 1040×600 아래로 줄어들지 않는지, 세 컬럼과 트랜스포트 바가 줄바꿈·가로 스크롤 없이 보이는지 확인한다.
- 기준 2 (수동): 사이드 툴바 톱니 → 설정 모달, `/` 버튼 → 도움말. 라이브러리 헤더에 톱니가 없는지 확인한다.
- 기준 3 (수동): 곡 재생 중 반주 페이더를 끌어 숫자와 소리가 함께 변하는지, 뮤트 버튼 강조와 페이더 비활성, 키보드 ↑↓·Ctrl·Alt 조합이 페이더에 반영되는지 확인한다.
- 기준 4 (수동): 원키가 있는 곡(예: 千鳥 `Cm`)에서 `+` 두 번 → 리셋, 메타 편집에서 키를 비운 곡에서 `—` 표시와 `+`/`−` 동작을 확인한다.
- 기준 5 (수동): 트랜스포트 바 구성과 BPM 칩(정상·저신뢰·없음 세 곡)을 확인한다. 저신뢰 곡이 없으면 메타 편집으로 BPM을 비워 `—`만 확인한다.
- 기준 6 (수동): 곡 미선택 상태와 로드 상태를 같은 창 크기에서 스크린샷으로 비교해 사이드 컬럼·트랜스포트 바 위치가 같은지 확인한다.
- 기준 9 (수동): 재생 중 반주 뮤트 → 반주 미터 0·메인 미터 감소, 메인 페이더 −60 → 메인 미터 0, 일시정지 → 전부 0, 재개 → 복귀를 순서대로 확인한다. 미터가 도는 동안 가사 하이라이트가 끊기지 않는지 함께 본다. DevTools Performance로 렌더러 CPU가 미터 유무에 따라 눈에 띄게 달라지지 않는지 확인한다.

**검증 현황 (2026-09-02, 구현 직후)**

| 기준 | 상태                               | 근거                                                                                                                                    |
| ---- | ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | 사용자 수동 확인 완료 (2026-09-02) | `src/main/index.ts` `minWidth: 1040`, `.app` grid `3fr 2fr 160px`. 창을 줄여 보는 확인은 사용자 수동 대기                               |
| 2    | 사용자 수동 확인 완료 (2026-09-02) | `App.tsx` `.side-toolbar`에 설정·도움말 버튼, 라이브러리 헤더에서 설정 버튼 제거. 클릭 확인은 수동 대기                                 |
| 3    | 사용자 수동 확인 완료 (2026-09-02) | `MixerPanel.tsx` 세로 페이더 3개 + dB + 뮤트, 기존 단축키 핸들러가 같은 스토어 액션을 호출. 소리·키보드 반영 확인은 수동 대기           |
| 4    | 사용자 수동 확인 완료 (2026-09-02) | `KeyPanel.tsx`: 원키 상자·리셋 버튼(반음 수)·변경 키 상자, null이면 `—`. `transposeKey`는 002 테스트 43건이 커버. 화면 확인은 수동 대기 |
| 5    | 사용자 수동 확인 완료 (2026-09-02) | `Transport.tsx`에서 `.player-controls` 제거, `.transport-bpm` 칩 추가. `formatBpmDisplay` 단위 테스트 통과                              |
| 6    | 사용자 수동 확인 완료 (2026-09-02) | 곡 미선택/로드 상태 스크린샷 비교                                                                                                       |
| 7    | 자동 검증 완료                     | `grep -rn "전체 " src/renderer`에서 음량·뮤트 관련 0건(남은 2건은 "전체 화면", "전체 리렌더")                                           |
| 8    | 자동 검증 완료                     | `pnpm typecheck && pnpm lint && pnpm test` exit 0 (12 files, 133 tests. `rmsDb` 5건, `formatBpmDisplay` 5건 추가)                       |
| 9    | 사용자 수동 확인 완료 (2026-09-02) | `WebAudioEngine` analyser 탭 + 30 Hz 틱 push + 정지 시 −60 push, `MixerPanel`이 ref로 DOM만 갱신. 실청·CPU 확인은 수동 대기             |

`pnpm dev`로 앱이 빌드·기동되는 것까지 확인했다(메인 프로세스 로그에 에러 없음). 화면 확인(기준 1–6·9)은 2026-09-02 사용자가 앱에서 직접 수행해 이상 없음을 확인했다.
