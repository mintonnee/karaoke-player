# NSIS 인수 검증

스펙: [012-nsis-installer](../../docs/specs/012-nsis-installer.md).

## 설치 파일 바이트 검증

```powershell
node --test scripts/nsis-acceptance/inventory.test.mjs
node scripts/nsis-acceptance/verify-installer.mjs --installer dist/nsis/karaoke-player-0.1.0-win-x64-setup.exe --app-dir dist/nsis/win-unpacked
```

버전이 바뀌면 실제 생성된 설치 파일명을 사용한다. 검증기는 electron-builder의 7zip toolset으로 NSIS 안에 압축 없이 삽입된 `app-64.7z` 스트림을 추출한다. 설치 프로그램을 실행하지 않는다. 모든 payload 파일의 크기·SHA-256을 빌드 디렉터리와 대조하고, 추출된 앱에 NSIS 패키지 정책 검증을 수행한다. NSIS 설정을 `useZip`으로 바꾸면 검증기도 함께 변경해야 한다.

`dist/nsis/acceptance/payload-*/report.json`에 설치 파일 hash·payload inventory·검사 결과를 남긴다. 추출 디렉터리도 검토용으로 보존한다. 보고서의 `installationTested: false`는 이 검사가 Windows 설치·제거 동작을 검증하지 않는다는 뜻이다.

## Windows VM 검증

실제 도구 resolver의 다운로드·버전 실행·오프라인 캐시 재사용만 먼저 검사하려면 아래 명령을 실행한다. 매번 `dist/nsis/acceptance/runtime-smoke-*` 아래 빈 격리 캐시를 만들며 사용자 라이브러리는 건드리지 않는다. 이 명령은 GitHub 도구 자산을 다운로드하고 검증 후 `--version`을 실행한다. Python·모델·YouTube 작업과 설치는 포함하지 않는다.

```powershell
node scripts/nsis-acceptance/runtime-tools-smoke.mjs
```

아래 절차는 사용자 작업 PC 대신 일회용 Windows 11 x64 VM에서 수행한다. 아직 실행하지 않은 항목은 통과로 기록하지 않는다.

| 시험               | 절차                                                                   | 확인 결과                                                                 |
| ------------------ | ---------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| 최초 오프라인 설치 | Python·uv·Deno·yt-dlp가 없는 일반 사용자 계정에서 네트워크를 끄고 설치 | 관리자 권한 없이 설치 완료, 런타임 다운로드 없음, 앱 자동 실행 없음       |
| 최초 초기화 실패   | 오프라인으로 앱 실행                                                   | 라이브러리 접근 가능, 도구별 오류·재시도 표시                             |
| 초기화 복구        | 네트워크 복구 후 재시도                                                | lock 버전의 도구가 사용자 데이터 경로에 생성, Python과 URL 도구 상태 독립 |
| 정상 재시작        | 도구·Python·필요 모델을 준비한 뒤 네트워크 차단 후 앱 실행             | 도구 재다운로드 없음, 기존 곡 재생 및 로컬 작업 가능                      |
| URL 도구 실패      | 별도 테스트 캐시에서 Deno 또는 yt-dlp 다운로드 실패 주입               | Python 준비 완료와 로컬 작업 유지, URL 작업만 차단                        |
| URL 재시도         | 도구 다운로드 복구                                                     | 앱 재시작 없이 URL 미리보기·가져오기 가능                                 |
| 업그레이드         | 테스트 곡·설정의 inventory를 저장한 뒤 다음 버전 설치                  | 설치 항목 중복 없음, DB·곡·설정·캐시 보존                                 |
| 실행 중 업그레이드 | 앱 및 worker 실행 중 설치 시작                                         | 종료 요청, 종료 실패 시 파일 교체 중단                                    |
| 제거·재설치        | Windows 설정에서 앱 제거 후 재설치                                     | 바로가기·설치 항목 제거, 사용자 데이터는 보존·재사용                      |
| DB 다운그레이드    | 더 높은 DB 스키마 fixture로 이전 앱 실행                               | DB 보호 오류, 도구 준비가 시작되지 않음                                   |
| 실제 작업          | 설치 앱에서 로컬 가져오기→분리→재생과 YouTube 미리보기→가져오기        | GPU/모델·YouTube 결과를 각각 기록                                         |

앱/Windows 버전, 설치 exe SHA-256, 도구 버전, 시험 시각과 각 항목의 통과·실패·미실행을 기록한다. 곡 제목·개인 경로·서명 URL·토큰을 공개 보고서에 포함하지 않는다. 실제 GPU·네트워크·설치 동작은 fixture 통과만으로 대체하지 않는다.
