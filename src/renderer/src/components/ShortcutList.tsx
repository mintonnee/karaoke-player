/** 단축키 목록 — 설정 모달과 `/` 도움말 오버레이에서 공용 */
function ShortcutList(): React.JSX.Element {
  return (
    <ul className="shortcut-list">
      <li>
        <kbd>Space</kbd> 재생 / 일시정지 (타이밍 보정 모드에서는 탭)
      </li>
      <li>
        <kbd>←</kbd> <kbd>→</kbd> 5초 뒤로 / 앞으로
      </li>
      <li>
        <kbd>↑</kbd> <kbd>↓</kbd> 메인 음량 · <kbd>Ctrl</kbd>+<kbd>↑</kbd>
        <kbd>↓</kbd> 반주 음량 · <kbd>Alt</kbd>+<kbd>↑</kbd>
        <kbd>↓</kbd> 보컬 음량
      </li>
      <li>
        <kbd>−</kbd> <kbd>=</kbd> 키 내림 / 올림
      </li>
      <li>
        <kbd>M</kbd> 메인 뮤트 <kbd>V</kbd> 보컬 뮤트 <kbd>L</kbd> A-B 루프(A → B → 해제){' '}
        <kbd>R</kbd> 처음으로
      </li>
      <li>
        <kbd>/</kbd> 이 도움말 표시 / 닫기
      </li>
    </ul>
  )
}

export default ShortcutList
