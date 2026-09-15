# 라이브러리 DB 백업 복구

Karaoke Player가 스키마를 바꾸기 직전에 남기는 DB 스냅샷을, 원본을 덮어쓰지 않고 확인한 뒤 사용자가 결정했을 때만 되돌리는 절차다. 앱은 자동 복원·초기화·백업 덮어쓰기를 제공하지 않는다. 계약은 `docs/specs/007-db-schema-safety.md`다.

## 이 백업이 포함하는 것 / 포함하지 않는 것

| 포함                                            | 포함하지 않음                           |
| ----------------------------------------------- | --------------------------------------- |
| `library.sqlite`의 마이그레이션 직전 스키마·행  | `tracks/` 곡 파일 (원본·스템·가사·커버) |
| 당시 WAL에만 있던 커밋                          | 백업 이후 추가·수정·삭제한 곡과 설정    |
| sidecar JSON (시작/목표 버전, 앱 버전, UTC, id) | 전체 라이브러리(파일+DB) 일치 보장      |

백업만으로 곡 파일을 되돌릴 수 없다. 백업 이후 `tracks/`가 바뀌었다면 DB 행과 파일이 어긋날 수 있다.

## 위치

Windows에서 `userData`는 보통 `%APPDATA%\Karaoke Player`다. 정확한 경로는 오류 대화상자의 데이터 폴더와 같다.

```text
<userData>/
├─ library.sqlite
├─ library.sqlite-wal    # 있을 수 있음. 원본과 함께 보존한다
├─ library.sqlite-shm
├─ backups/db/
│  ├─ library-v{시작}-to-v8-{UTC}-{id}.sqlite
│  └─ library-v{시작}-to-v8-{UTC}-{id}.json
└─ tracks/
```

JSON 예:

```json
{
  "id": "…",
  "startVersion": 4,
  "targetVersion": 8,
  "appVersion": "0.1.0",
  "createdAt": "2026-09-15T12:00:00.000Z",
  "sourceDbPath": "C:\\Users\\…\\library.sqlite"
}
```

`startVersion`이 그 스냅샷을 연 앱의 스키마 버전이다. 현재 앱은 v8이다. 구버전 백업을 현재 앱으로 열면 다시 v8로 업그레이드된다.

## 복구 절차

자동 삭제·원본 교체 버튼은 없다. 아래를 수동으로 한다.

1. **모든 Karaoke Player를 종료한다.** 작업 관리자에서 `karaoke-player.exe`가 없는지 확인한다. 다른 도구가 `library.sqlite`를 열고 있어도 안 된다.
2. **원본과 WAL/SHM을 그대로 둔다.** `library.sqlite`, `library.sqlite-wal`, `library.sqlite-shm`을 지우거나 백업 파일로 바로 덮어쓰지 않는다. 필요하면 원본 세 파일을 같은 시각 접미사로 옆에 복사해 둔다.
3. **선택한 백업을 별도 경로에 복사한다.** 예: `<userData>/restore-check/library.sqlite`. 원본의 `-wal`/`-shm`을 이 복사본 옆에 두지 않는다. 이전에 그 경로에 남아 있던 `-wal`/`-shm`도 제거한다.
4. **복사본만 검사한다.** sidecar JSON의 `startVersion`·`appVersion`·시각을 읽고, 가능하면 `PRAGMA quick_check`가 `ok`인지, `PRAGMA user_version`이 JSON의 `startVersion`과 같은지 확인한다.
5. **백업 버전에 맞는 앱으로 복사본을 연다.** 현재 앱(v8)으로 구버전 복사본을 열면 업그레이드가 다시 일어난다. 확인이 끝나면 그 복사본 폴더의 앱 데이터를 버린다. 이 단계에서 원본 `library.sqlite`를 가리키게 하지 않는다.
6. **원본을 바꿀지는 사용자가 결정한다.** 바꾸기로 했다면: 앱을 모두 종료한 뒤 원본 `library.sqlite`와 `-wal`/`-shm`을 보관 이름으로 옮기고, 검증된 백업 `.sqlite`만 `library.sqlite`로 복사한다. 복원한 파일 옆에 예전 WAL/SHM을 붙이지 않는다.

구현 헬퍼 `restoreLibraryBackup(backupPath, destPath)`는 3번의 별도 경로 복사와 dest `-wal`/`-shm` 제거만 한다. 원본 교체는 호출하지 않는다. 테스트는 `src/main/library/__tests__/db/backup.test.ts`다.

## 하지 말 것

- 실행 중인 앱이 열어 둔 `library.sqlite`를 파일 복사로 백업·복원하기
- 원본 WAL/SHM을 복원된 sqlite에 붙이기
- 빈 DB로 원본을 대체해 “복구”하기
- 버전을 추측해 부분 마이그레이션을 수동으로 완성하기
- 미래 버전(`user_version > 8`) DB를 현재 앱으로 다운그레이드하기 — 더 최신 앱이 필요하다
