# Karaoke Player YouTube URL 사전 확인·메타데이터 미리보기 스펙

- 작성일: 2026-09-15
- 연관 스펙: `004-import-dialog.md`, `001-packaging-distribution.md`, `008-runtime-dependency-lock.md`
- 대상: 004 §4.1 YouTube 입력·곡 정보·커버, §4.2 URL 처리 경로
- 상태: 구현 완료 (기준 1–10 자동 검증 통과, 11·12 UI·실서비스·Windows 프로세스 수동 확인 대기)
- 코드 확인 기준: `fcc08b1e33c7df8bdf82feaaf588f5fd4a9c01c3`

이 문서는 004의 YouTube 가져오기에서 URL 입력 직후 가져오기 가능 여부를 확인하고 곡 정보와 커버를 미리 채우는 범위를 다룬다. 실제 다운로드·등록·스템 분리는 사용자가 가져오기를 제출한 뒤 기존 경로로 수행한다.

## 1. 목표와 비목표

```text
사용자가 YouTube 동영상 URL을 입력하면 입력창 오른쪽에서 확인 중·가져오기 가능·불가·확인 실패를 구분하고, 조회된 제목·아티스트와 썸네일을 아래 폼에서 확인·수정한 뒤 가져올 수 있다.
```

| 영역       | 목표                                                                                     |
| ---------- | ---------------------------------------------------------------------------------------- |
| 사전 확인  | URL 형식, 콘텐츠 접근 가능 여부, DRM, 현재 다운로드 형식 지원 여부를 제출 전에 확인한다. |
| 피드백     | 입력창 우측 상태 아이콘과 짧은 설명을 함께 표시한다.                                     |
| 메타데이터 | 기존 제목·아티스트 입력과 커버 미리보기를 채우되 사용자 편집을 보존한다.                 |
| 일관성     | 이전 URL의 응답·썸네일·확인 결과가 현재 입력에 적용되지 않는다.                          |
| 제출       | 현재 입력의 확인 성공과 기존 제출 조건을 모두 만족할 때만 제출한다. Main에서도 검증한다. |

| 비목표                                                     | 제외 이유                                                                                  |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| DRM 해제, 로그인·브라우저 쿠키 추출, 유료 콘텐츠 접근 우회 | 접근 가능한 비보호 오디오의 기존 가져오기 경로를 유지하는 기능이다.                        |
| YouTube 외 사이트·재생목록·여러 곡 가져오기                | 004의 단일 YouTube 동영상 계약을 유지한다.                                                 |
| 다운로드 형식 확대, yt-dlp 교체·자동 업데이트              | 현재 M4A 선택 정책과 008의 바이너리 lock을 기준으로 판단한다.                              |
| BPM·키·가사·앨범 자동 입력 추가                            | 현재 가져오기 폼의 제목·아티스트·커버만 채우며 오디오 분석은 등록 후 기존 기능이 담당한다. |
| 실제 다운로드 성공의 사전 보장                             | 네트워크·권한·포맷 가용성은 조회 이후에도 바뀔 수 있다. 가능 상태는 조회 시점의 결과다.    |
| DB 스키마 변경·미리보기 영구 보관                          | 미리보기는 팝업 세션에만 필요하며 트랙 등록이 아니다.                                      |

## 2. 성공 기준

1. 빈 입력에는 중립 상태를 표시하고 제출을 막는다. 형식이 잘못된 URL·비지원 호스트·재생목록 전용 URL은 원격 조회 없이 입력 옆에 이유를 표시한다.
2. 유효한 URL 입력이 500 ms 동안 바뀌지 않으면 자동 조회한다. 우측에 회전 아이콘과 확인 중 설명이 나타나고, 조회 중 제출은 비활성이다.
3. 접근 가능한 비보호 M4A 오디오를 확인하면 체크 아이콘과 가져오기 가능 설명이 표시된다. URL 형식이나 제목 조회 성공만으로 체크를 표시하지 않는다.
4. DRM 확인, 접근 제한, 지원 오디오 부재, 진행 중·예정 라이브를 구분해 가져오기를 막는다. 네트워크·타임아웃·추출기 실패는 확인 실패와 재시도로 표시하고 DRM으로 단정하지 않는다.
5. 현재 URL의 조회 메타데이터로 제목·아티스트와 커버 미리보기가 채워진다. 일부 필드·이미지가 없거나 이미지 로딩이 실패해도 유효한 오디오의 가져오기는 허용한다.
6. 조회 중·후 사용자가 바꾼 제목·아티스트·커버를 늦은 응답이나 재시도가 덮지 않는다. URL 변경 시 이전 URL에서 자동으로 채운 값만 제거한다.
7. A 입력 후 B 입력, A → B → A, 재시도, 방식 전환, 닫기·재열기에서 이전 요청 결과가 상태·폼·커버를 갱신하지 않는다. 취소·타임아웃·앱 종료 후 조회 프로세스가 남지 않는다.
8. 명시적 제출 전 오디오 다운로드·DB 등록·트랙 디렉토리 생성·분리 큐 등록은 모두 0회다. 메타데이터 조회와 제한된 썸네일 네트워크 요청만 발생한다.
9. 제출 시 현재 URL에 대응하는 Main 소유 확인 결과를 검사하고, 없거나 만료되면 다시 조회한다. 실패하면 다운로드를 시작하지 않는다. 성공하면 한 번만 기존 다운로드·등록·분리 경로로 진입하고 사용자 수정값과 커버 우선순위를 지킨다.
10. capability 미지원 빌드는 URL UI를 숨기고 조회·취소·가져오기 직접 IPC도 안전하게 처리한다. 기존 로컬 파일·MR 가져오기와 runtime 준비·중복 제출 차단이 유지된다.
11. 상태는 색상 외 아이콘·문구로 구분된다. 키보드·스크린리더로 이유와 재시도를 확인할 수 있고 조회 중 입력·방식 전환·닫기를 사용할 수 있다.
12. 자동 fixture 검증과 실제 지원 배포판의 YouTube 확인·가져오기 수동 검증을 별도 기록한다. 문서 작성이나 mock 통과를 구현 완료로 기록하지 않는다.

## 3. 전제 조건

| 현재 사실·전제                                                                                   | Source of truth / 확인 방법                                                                    |
| ------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| URL 파서는 허용 호스트와 watch/shorts/live·youtu.be 경로를 검사하지만 콘텐츠 조회는 하지 않는다. | `src/shared/youtubeUrl.ts`, `src/shared/__tests__/youtubeUrl.test.ts`                          |
| 제출 가능 여부는 현재 URL 구문 검사에 의존한다.                                                  | `src/renderer/src/import/form.ts`의 `canSubmitUrl`·`canSubmit`                                 |
| 제목·아티스트에는 값의 출처가 있고 커버는 로컬 경로로 관리한다.                                  | 같은 파일의 `SongMetaOrigin`, `ImportFormState`, `songMetaFromForm`                            |
| URL 다운로드 형식은 `bestaudio[ext=m4a]`다. 제목과 아티스트 힌트, 썸네일은 다운로드 후 처리한다. | `src/main/library/YtDlpService.ts`의 `buildYtDlpArgs`·`normalizeArtist`·`applyThumbnail`       |
| Main이 runtime·capability·ImportRequestGate를 검사한다.                                          | `src/main/ipc.ts`, `src/main/library/importUrlPrecheck.ts`                                     |
| IPC·타입·preload는 명시적으로 연결한다.                                                          | `src/shared/types.ts`, `src/preload/index.ts`, `src/preload/index.d.ts`                        |
| 조회에도 앱이 선택·검증한 yt-dlp·Deno를 사용한다.                                                | `YtDlpService.verifyBinaries`, `008-runtime-dependency-lock.md`, `build/locks/tools.lock.json` |
| 폼에 제목·아티스트·이미지 영역이 이미 있다.                                                      | `src/renderer/src/components/ImportDialog.tsx`, `src/renderer/src/assets/import-dialog.css`    |

yt-dlp의 JSON 출력·simulation 옵션은 [공식 문서](https://github.com/yt-dlp/yt-dlp#verbosity-and-simulation-options)를 참조한다. 실제 JSON 필드와 오류 분류는 구현 시 **lock에 고정된 바이너리**의 fixture 및 실행 결과로 검증한다. 최신 upstream만 보고 번들 동작을 단정하지 않는다.

## 4. 기능 범위

### 4.1 입력과 상태 UI

기존 YouTube URL 입력의 오른쪽 내부에 폭이 고정된 상태 영역을 둔다. 텍스트가 아이콘과 겹치지 않게 오른쪽 여백을 확보한다. 상태 설명은 라벨과 같은 줄에서 오른쪽 정렬하고 기존 곡 정보·커버 카드는 입력 아래 유지한다.

| 상태       | 우측 아이콘  | 설명 예시                                     | URL 제출                    |
| ---------- | ------------ | --------------------------------------------- | --------------------------- |
| idle       | 중립 링크    | YouTube 동영상 URL을 입력하세요               | 불가                        |
| invalid    | 오류         | 올바른 YouTube 동영상 URL을 입력하세요        | 불가                        |
| debouncing | 중립 링크    | 확인 대기 중                                  | 불가                        |
| checking   | 회전 진행    | 가져올 수 있는지 확인 중                      | 불가                        |
| ready      | 초록 체크 원 | 가져오기 가능                                 | 기존 공통 조건 충족 시 가능 |
| blocked    | 빨간 차단 원 | DRM으로 보호된 콘텐츠는 가져올 수 없습니다 등 | 불가                        |
| error      | 주황 경고    | 확인하지 못했습니다. 다시 시도해 주세요       | 불가                        |

- URL 변경 즉시 ready를 해제한다. 같은 문자열로 돌아와도 이전 요청의 성공을 재사용하지 않는다.
- 500 ms debounce는 입력·붙여넣기에 동일하게 적용한다. IME 조합 중에는 조회하지 않고 조합 종료 후 예약한다.
- Enter는 checking·error에서 가져오기를 우회하지 않는다. error 옆 별도 `다시 확인` 버튼은 debounce 없이 새 요청을 시작한다.
- 입력 형식 오류는 로컬 안내만 표시한다. 타이핑·자동 조회 실패를 전역 오류 센터에 매번 쌓지 않는다. 명시적 제출 실패의 기존 오류 보고는 유지한다.
- 상태 설명을 `aria-describedby`로 입력에 연결하고 변경 결과는 `role="status"`·`aria-live="polite"`로 알린다. 장식 아이콘은 숨기고 색상만으로 뜻을 전달하지 않는다. tooltip이 유일한 설명이 되어서는 안 된다.
- 사전 조회는 기존 submitting 상태와 분리한다. 조회 중에는 닫기·Escape·방식 변경·입력을 허용하고, 실제 제출 후 잠금은 004를 따른다.

### 4.2 URL 검증과 원격 판정

1. Renderer와 Main에서 공통 파서로 trim·HTTP(S)·정확한 호스트·동영상 경로를 검증한다. 비문자열 IPC 값도 예외 없이 거부한다.
2. 기존 지원 형태를 유지하되 사용자정보 포함 URL, 비표준 포트, 잘못된 동영상 ID, 중복 v 파라미터, watch 뒤 불필요 경로를 거부한다. ID는 11자리 영문 대소문자·숫자·밑줄·대시로 검사한다.
3. 동영상 ID로 `https://www.youtube.com/watch?v=<id>`를 구성한다. list·시간·공유 추적 파라미터는 제거하고 이 canonical URL을 조회·다운로드에 공통 사용한다. 입력창의 원문을 강제로 바꾸지는 않는다.
4. capability와 바이너리 검증 후 Main에서 단일 동영상 메타데이터와 format 정보를 읽는다.
5. 아래 판정 후 최소 표시용 데이터만 Renderer에 보낸다.

| 조건                                                      | 결과 코드                                          | 처리                                  |
| --------------------------------------------------------- | -------------------------------------------------- | ------------------------------------- |
| DRM을 명시한 추출기 오류 또는 보호 정보가 확인됨          | DRM_PROTECTED                                      | blocked; 해제·우회 시도 없음          |
| 삭제·존재하지 않음·비공개·지역 제한이 확인됨              | UNAVAILABLE                                        | blocked; 확인 가능한 범위의 이유 표시 |
| 로그인·연령 확인·멤버십·구매가 필요함                     | AUTH_REQUIRED                                      | blocked; 현재 앱에서 접근 불가        |
| 진행 중 또는 예정 라이브                                  | LIVE_UNSUPPORTED                                   | blocked; 종료 후 VOD는 일반 검사      |
| 추출 성공이나 현재 정책의 비보호 오디오가 없음            | NO_SUPPORTED_AUDIO                                 | blocked; DRM이라고 추정하지 않음      |
| 네트워크·요청 제한·타임아웃·추출기 오류·JSON 이상         | NETWORK / RATE_LIMITED / TIMEOUT / EXTRACTOR_ERROR | error; 수동 재시도                    |
| 필수 판정 정보 부족·DRM 상태 불명·서로 모순되는 보호 정보 | UNKNOWN                                            | error; 성공으로 추정하지 않음         |
| 접근·비보호·지원 오디오 확인                              | READY                                              | ready                                 |

- DRM 여부는 제목·설명 키워드, 저작권 표시, HTTP 403만으로 판정하지 않는다.
- 후보 오디오는 기존 selector와 같은 M4A audio-only 정책을 적용한다. DRM 없는 선택 가능 후보가 있어야 한다. format-level DRM과 콘텐츠 수준 정보를 함께 보고, 보호된 후보는 선택에서 제외한다.
- `has_drm`의 누락·false·true·불명 값을 무조건 boolean으로 변환하지 않는다. 누락이 정상 비보호 의미인지 여부는 번들 yt-dlp의 정규화 계약과 fixture로 증명해야 한다. 증명되지 않으면 UNKNOWN이다.
- metadata JSON이 존재하거나 프로세스가 exit 0이라는 사실만으로 ready로 만들지 않는다. 특히 no-formats 오류를 완화해 메타데이터를 수집한 경우에도 독립 판정은 필수다.
- blocked에서 신뢰할 수 있는 메타데이터가 있으면 미리 채울 수 있지만 차단 사유와 제출 비활성은 유지한다. 조회 전체가 실패하면 현재 요청의 자동 채움은 적용하지 않는다.
- UI의 가져오기 가능은 “현재 조회 결과 기준”이다. 다운로드 때 바뀐 상태는 기존 실패 흐름으로 처리한다.

### 4.3 조회 실행·IPC 계약·수명

새 계약은 `src/shared/types.ts`에서 정의하고 preload API로만 노출한다. 아래는 구현할 계약이며 현재 존재하는 API가 아니다.

```ts
type YoutubePreviewRequest = {
  requestId: string
  url: string
}

type YoutubePreviewMetadata = {
  title: string | null
  artist: string | null
  thumbnailDataUrl: string | null
}

type YoutubePreviewResult = {
  requestId: string
  canonicalUrl: string | null
  status: 'ready' | 'blocked' | 'error' | 'cancelled'
  code: string // §4.2 코드 + INVALID_URL, DISABLED, CANCELLED
  message: string
  checkedAt: number | null // Main 생성 epoch ms
  metadata: YoutubePreviewMetadata | null
  thumbnailWarning: string | null
}
// library:preview-youtube → Promise<YoutubePreviewResult>
// library:cancel-youtube-preview({ requestId }) → Promise<void>
```

- code는 실제 구현에서 위 표의 literal union으로 좁힌다. ready는 READY·유효한 canonicalUrl·checkedAt을 반드시 갖도록 discriminated union과 runtime 검증을 적용한다.
- 요청 ID는 팝업 인스턴스마다 새 세션 식별자와 증가 generation을 조합한다. 응답 적용에는 현재 세션·generation·URL·method 일치를 모두 요구한다.
- Main은 IPC sender별 활성 요청 하나를 소유한다. 새 요청은 이전 프로세스를 종료하며 취소는 같은 sender의 일치 ID에만 적용한다. 취소 뒤 도착한 응답은 무시한다.
- 조회는 ImportRequestGate·Demucs JobQueue·실제 다운로드 직렬 체인에 넣지 않는다. 실제 제출 시 남은 사전 조회를 정리하고 기존 import gate를 사용한다.
- 조회 명령은 배열 인자로 spawn하며 shell을 사용하지 않는다. 제안 기본 인자는 `--ignore-config --encoding utf-8 --simulate --dump-single-json --no-playlist --no-cache-dir --js-runtimes deno:<검증된 경로>`다. `--write-thumbnail`·미디어 다운로드·후처리·출력 파일 옵션은 넣지 않는다.
- 실제 다운로드도 사용자 전역 yt-dlp 설정에 의해 형식·쿠키·후처리가 바뀌지 않도록 동일한 config 격리·canonical URL 정책을 적용한다. 인증·format 선택 조건이 조회와 다운로드에서 달라져서는 안 된다.
- 조회 deadline은 20초, stdout JSON 누적 상한은 8 MiB, stderr는 마지막 40줄 및 총 64 KiB 중 먼저 도달하는 한도로 둔다. 초과 시 종료하고 오류를 반환한다. 썸네일은 별도 5초 이내이며 총 응답 지연 상한은 25초다.
- 취소·타임아웃·sender 종료·앱 종료 때 자식과 하위 프로세스를 정리한다. Windows에서도 강제 종료 escalation 후 close·타이머·리스너 정리가 끝나야 완료다.
- 자동 반복 재시도는 하지 않는다. 연속 입력은 debounce와 기존 요청 취소로 제한한다.
- 원본 JSON·서명된 미디어 URL·쿠키·전체 stderr를 Renderer·DB·일반 로그에 전달하지 않는다. 사용자 메시지는 code에서 만들고 진단 로그는 민감 파라미터를 제거한다.
- 미리보기는 runtime sidecar 모델을 준비하거나 다운로드하지 않는다. capability·도구 검증은 Main에서 수행하고, 실제 제출의 기존 runtime ready 조건은 유지한다.

### 4.4 폼 자동 채움과 이미지

| 대상     | 원본·우선순위                                         | 동작                                              |
| -------- | ----------------------------------------------------- | ------------------------------------------------- |
| 제목     | trim한 yt-dlp title                                   | 현재 폼 제목에 자동 입력; 임의 곡명 파싱 없음     |
| 아티스트 | artist → channel → uploader 중 첫 비어 있지 않은 값   | 기존 normalizeArtist를 재사용해 Topic 접미사 처리 |
| 커버     | 사용자가 고른 로컬 이미지 → 조회 썸네일 → 기본 이미지 | 기존 커버 영역에서 미리보기                       |
| 없는 값  | null                                                  | 자동 입력 안 함; 사용자 값 유지                   |

- 제목·아티스트 출처에 youtube를 추가하고 자동 값에는 해당 URL generation을 연결한다. URL이 바뀌거나 비워지면 그 URL이 채운 값만 즉시 지운다.
- 수동 편집은 비운 값까지 dirty로 기록한다. 진행 중인 응답이 사용자가 지운 입력을 즉시 다시 채우지 않는다. 단, 빈 값을 제출하면 004의 기존 자동 추출 fallback을 사용하는 의미는 유지한다.
- 같은 URL 재조회는 user dirty가 아닌 필드만 갱신한다. 사용자 값이 남아 있으면 새 동영상의 조회 결과도 덮지 않는다.
- 방식 전환 시 사용자 제목·아티스트·로컬 커버를 유지한다. youtube 자동값·썸네일은 제거한다. 이는 004의 “방식 변경 시 곡 정보 유지” 중 새로 도입하는 YouTube 자동값에만 적용하는 예외다. 로컬 태그 정책은 바꾸지 않는다.
- 커버 미리보기의 remote data와 `coverPath`를 분리한다. 썸네일 data URL이나 원격 URL을 로컬 파일 경로로 보내지 않는다.
- 사용자 커버 선택·드롭이 조회보다 우선한다. 사용자 커버 해제는 현재 URL의 자동 썸네일로 돌아가는 의미다. 영구 “커버 없음” 옵션은 추가하지 않는다.
- 썸네일은 Main이 가져와 실제 이미지 형식을 검사·디코딩한 뒤 긴 변 512 px 이하 JPEG/PNG data URL로 전달한다. 원본 응답 최대 5 MiB, 디코딩 최대 16 MP, 최종 data URL 최대 1 MiB로 제한한다.
- HTTPS `i.ytimg.com`·`img.youtube.com`의 기본 포트만 허용하고 redirect마다 같은 검사를 적용한다. URL 자격증명·임의 호스트·로컬 주소는 거부한다. Renderer CSP를 범용 원격 이미지 허용으로 넓히지 않는다.
- 이미지 실패는 기본 이미지와 “썸네일을 불러오지 못했습니다” 보조 안내로 처리한다. ready 판정에는 영향이 없다.
- 이미지 응답에도 generation 검사를 적용한다. 팝업 종료 시 메모리와 임시 자원을 해제한다. 실제 가져오기에서는 기존 yt-dlp 썸네일 저장 경로를 사용하며 미리보기 이미지를 영구 커버로 복사하지 않는다.

### 4.5 제출 연결·오류 복구

- Renderer의 제출 조건은 현재 URL에 대응하는 ready + 기존 모델 설정 조회·저장 상태 + runtime ready + submitting 아님이다.
- Main은 canonical URL과 sender에 연결된 마지막 성공 확인 결과를 메모리에 보관한다. 유효기간은 확인 완료 후 60초다. 결과에는 형식 정책·바이너리 식별도 연결하며 다르면 무효다.
- 기존 `importUrl(url, userMeta?)` 호출 형태를 유지할 수 있다. Renderer가 보낸 ready boolean·checkedAt을 신뢰하지 않고 Main 소유 결과만 재사용한다.
- 직접 IPC 호출, 캐시 부재, 만료 시 Main에서 동일 검사를 새로 실행하고 성공해야 다운로드한다. URL 변경·방식 변경·닫기에 의한 취소는 해당 세션 결과도 폐기한다. 살아 있는 결과도 실제 다운로드 성공을 보장하지 않는다.
- URL 자동 채움값과 사용자 override를 구분한다. URL 제출에서 `ImportUserMeta`에는 비어 있지 않은 수동 제목·아티스트와 사용자 로컬 coverPath만 보낸다. 자동값은 기존 다운로드 메타데이터 경로로 확정한다. 로컬 파일 제출의 현재 직렬화는 유지한다.
- 제출 시 재확인 실패는 현재 폼을 유지하고 해당 사유를 표시한다. URL 편집 후 다른 입력에 과거 오류를 붙이지 않는다.
- 다운로드가 시작된 뒤의 실패는 ready 표시를 해제하고 다시 확인할 수 있게 한다. 실패 시 등록·임시 파일 정리는 기존 서비스 계약을 따른다.
- 로컬 파일·MR 흐름에는 원격 조회를 추가하지 않는다. DB·Track 구조도 변경하지 않는다.

### 4.6 구현 슬라이스

성공 기준과 외부 계약이 우선이며 내부 클래스·함수 분할은 자유다. 아래 표는 구현 작업의 경계다.

| 슬라이스 | 산출물                                         | 소유(수정 가능) 경로                                                                                                                                                                                                                                                                                                                                                                           | 수정 금지 경로                | 선행 조건                         | 상태 |
| -------- | ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- | --------------------------------- | ---- |
| Y1       | 공통 URL·상태·IPC 타입, preload 계약           | `src/shared/types.ts`, `src/shared/youtubeUrl.ts`, `src/shared/__tests__/youtubeUrl.test.ts`, 신규 `src/shared/__tests__/youtubePreview.test.ts`, `src/preload/**`                                                                                                                                                                                                                             | Y2·Y3·Y4 소유 경로 및 sidecar | 없음; Y2·Y3 시작 전 계약 확정     | 완료 |
| Y2       | Main 조회·취소·분류·썸네일·제출 검증과 fixture | `src/main/library/YtDlpService.ts`, 신규 `src/main/library/YoutubePreviewService.ts`, `src/main/library/importUrlPrecheck.ts`, `src/main/library/__tests__/YtDlpService.test.ts`, `src/main/library/__tests__/fake_ytdlp.mjs`, `src/main/library/__tests__/importUrlPrecheck.test.ts`, 신규 `src/main/library/__tests__/YoutubePreviewService.test.ts`, `src/main/ipc.ts`, `src/main/index.ts` | Y1·Y3·Y4 소유 경로 및 sidecar | Y1 계약 확정                      | 완료 |
| Y3       | 입력 아이콘·자동 조회·폼 보존·이미지·접근성    | `src/renderer/src/components/ImportDialog.tsx`, `src/renderer/src/import/**`, `src/renderer/src/assets/import-dialog.css`                                                                                                                                                                                                                                                                      | Y1·Y2·Y4 소유 경로 및 sidecar | Y1 계약 확정; Y2와 병렬 구현 가능 | 완료 |
| Y4       | 통합 검증·문서·필요한 설정 조정                | `docs/**`, `package.json`, `pnpm-lock.yaml`, `vitest.config.ts`, 신규 `tests/youtube-preview/**`                                                                                                                                                                                                                                                                                               | Y1·Y2·Y3 소유 경로 및 sidecar | Y1-Y3 결과 통합                   | 완료 |

- 완료 판정: Y1 = 기준 1·10의 계약, Y2 = 기준 3·4·7-10의 Main 증거, Y3 = 기준 1-7·11의 상태·UI 증거, Y4 = 기준 1-12 통합 증거다. 교차 기준은 관련 증거가 모두 있어야 완료다.
- 공유 루트 설정은 Y4만 변경한다. 경계 밖 수정이 필요하면 감독자가 소유 경로를 먼저 갱신한다.
- 에이전트는 종료 전 §5 해당 명령의 exit code와 수동 미검증 항목을 보고한다. 훅 우회(`--no-verify`, `LEFTHOOK=0`)는 금지하며 commit/stage는 감독자 또는 사용자만 수행한다.
- 완료된 슬라이스는 감독자의 재개 지정 없이 재작업하지 않는다. 이 표로 구현을 실행할 때는 저장소 `orchestrate-slices` 스킬을 사용한다.

## 5. 검증 방법

자동 회귀는 구현 시 `pnpm typecheck` · `pnpm lint` · `pnpm test`로 확인한다. UI 위치·스크린리더·실제 YouTube·Windows 프로세스 정리는 `tests/youtube-preview/MANUAL.md`에 별도 기록한다.

```bash
# 문서 형식·참조 변경 확인
pnpm exec prettier --check docs/specs/009-youtube-url-preview.md docs/specs/README.md docs/specs/004-import-dialog.md

# 구현 후 기준 1-10의 계약·자동 회귀
pnpm typecheck
pnpm lint
pnpm test

# 구현 후 기준 1-11의 앱 통합 확인을 위한 빌드·실행
pnpm build
pnpm dev
```

| 검증 묶음     | 필수 사례·관찰 결과                                                                                                                                                  | 기준   |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| URL 파서      | 지원 URL별 canonical 동일성, 공백·list·시간 파라미터, 위조 호스트·자격증명·포트·비문자열·잘못된 ID·playlist 거부; invalid에서 spawn 0회                              | 1·10   |
| debounce·경합 | fake timer로 499 ms 조회 0회·500 ms 1회; A → B·A → B → A 역순 응답; 재시도·닫기·방식 전환 뒤 상태 갱신 0회                                                           | 2·7    |
| 판정 fixture  | 정상 M4A, DRM true/false/누락/unknown·혼합 format, 비공개·삭제·지역·인증·live·upcoming·완료 VOD, WebM만 존재, 포맷 없음, JSON 손상, exit 비정상, rate limit·timeout  | 3·4    |
| 폼·이미지     | title·artist fallback·Topic 정규화, 일부 메타 누락, 사용자 입력·지우기·커버 우선, URL 변경 시 자동값만 제거, 썸네일 404·oversize·금지 redirect·디코딩 실패·늦은 응답 | 5-7    |
| 부작용·정리   | 사전 조회의 importFiles·DB·분리 호출 0회, 미디어/트랙 파일 0개; stdout 상한·timeout·cancel·앱 종료 뒤 프로세스·타이머 정리                                           | 7·8    |
| 제출·회귀     | 60초 이내 Main 결과 재사용·만료 재검사, 직접 IPC 검증, 정책 변경 무효화, submit 연타 한 번, 다운로드 실패 후 복구, 로컬 파일·MR·capability off 회귀                  | 9·10   |
| UI 수동       | 아이콘 우측 정렬, 좁은 창·긴 URL, 상태 문구·키보드·포커스·스크린리더, 조회 중 닫기·편집, 실제 제출 잠금                                                              | 2·5·11 |
| 실제 배포판   | lock 버전 기록, 접근 가능한 영상의 조회 → 폼 확인 → 수동 수정 → 다운로드 → 저장값·커버 → 분리·재생, 네트워크 끊기·복구 재시도                                        | 9·12   |

- Main 판정 테스트는 기존 fake yt-dlp 패턴을 확장한다. 테스트를 네트워크·실제 DRM 구매 콘텐츠에 의존시키지 않는다.
- DRM·인증 제한 등 실제 사례를 확보하지 못하면 fixture 검증과 실서비스 미검증을 구분해 기록한다.
- pnpm test의 Node 테스트만으로 실제 DOM 위치·스크린리더·Windows 하위 프로세스 종료를 확인했다고 주장하지 않는다. Windows 지원 배포판에서 별도 검증한다.

구현 자동 검증(2026-09-16): `pnpm typecheck` · `pnpm lint` · `pnpm test` exit 0 (531 tests, 슬라이스 합성 `tests/youtube-preview/compose.test.ts` 포함). `pnpm build` · `pnpm dev` · 실서비스 YouTube는 수동 확인 대기.
