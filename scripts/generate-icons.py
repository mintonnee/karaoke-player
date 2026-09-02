"""Karaoke Player 아이콘 세트 생성 스크립트 (스펙 001 P4).

실행법:
    uv run --with pillow python scripts/generate-icons.py

의존성을 레포에 추가하지 않고 uv의 일회성 --with 옵션으로 Pillow만 사용한다.
다시 실행하면 아래 산출물이 모두 재생성된다 (모두 이 스크립트가 프로그램적으로 그린다):

- build/icon.png            1024x1024 (electron-builder 기본 아이콘 소스)
- build/icon.ico            16/24/32/48/64/128/256 멀티 사이즈
- build/icon.icns           1024 마스터에서 생성 (macOS, 비목표지만 유지)
- resources/icon.png        256x256 (Linux 창 아이콘, src/main/index.ts 가 ?asset 로 import)
- build/appx/*.png          MSIX 타일 세트 (electron-builder AppxTarget 규약 파일명)

디자인: src/renderer/src/assets/base.css 의 다크 팔레트(--ev-c-black #1b1b1f 계열)를
배경으로, 앱 포인트 컬러(#4a7dbd/#6b9fd8 계열 블루)를 마이크 실루엣 강조에 사용한다.
작은 크기에서도 식별되도록 마이크 한 형태만 굵은 스트로크로 단순화했다.
"""

from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent

# --- 팔레트 (src/renderer/src/assets/base.css 참조) ---
BG_TOP = (34, 42, 56, 255)  # 진한 남색 (--ev-c-black-mute 톤에 살짝 블루 가미)
BG_BOTTOM = (20, 24, 31, 255)  # --ev-c-black 톤
MIC_FILL = (247, 249, 252, 255)  # 거의 흰색 — 어두운 배경에서 최대 대비
ACCENT = (107, 159, 216, 255)  # --ev-c-text 강조 블루 (#6b9fd8)
ACCENT_DIM = (74, 125, 189, 255)  # #4a7dbd


def _rounded_rect_mask(size: int, radius: int) -> Image.Image:
    mask = Image.new("L", (size, size), 0)
    d = ImageDraw.Draw(mask)
    d.rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=255)
    return mask


def _vertical_gradient(size: int, top: tuple, bottom: tuple) -> Image.Image:
    grad = Image.new("RGBA", (size, size), 0)
    px = grad.load()
    for y in range(size):
        t = y / max(size - 1, 1)
        r = round(top[0] + (bottom[0] - top[0]) * t)
        g = round(top[1] + (bottom[1] - top[1]) * t)
        b = round(top[2] + (bottom[2] - top[2]) * t)
        for x in range(size):
            px[x, y] = (r, g, b, 255)
    return grad


def _draw_mic(draw: ImageDraw.ImageDraw, cx: float, cy: float, scale: float, color: tuple) -> None:
    """중심 (cx, cy) 기준, scale(마이크 머리 폭)에 비례한 마이크 실루엣을 그린다.

    형태: 캡슐형 머리(그릴) + 스템 + 받침대만 쓰는 최소 구성. 홀더 아치 같은
    잔가지는 작은 크기(16px)에서 뭉개져 알아보기 어려워지므로 뺐다 — 굵고
    단순한 형태 하나로 식별성을 확보한다.
    """
    head_w = scale
    head_h = scale * 1.5
    stroke = max(scale * 0.22, 2)

    # 마이크 머리 (캡슐)
    hx0 = cx - head_w / 2
    hx1 = cx + head_w / 2
    hy0 = cy - head_h * 0.95
    hy1 = hy0 + head_h
    draw.rounded_rectangle([hx0, hy0, hx1, hy1], radius=head_w / 2, fill=color)

    # 스템 (머리 바로 아래에서 받침대까지, 캡슐과 겹치게 시작해 이음매 없이 연결)
    stem_top = hy1 - head_w * 0.3
    stem_bottom = cy + head_h * 0.62
    draw.line([cx, stem_top, cx, stem_bottom], fill=color, width=round(stroke), joint="curve")
    draw.ellipse(
        [cx - stroke / 2, stem_bottom - stroke / 2, cx + stroke / 2, stem_bottom + stroke / 2],
        fill=color,
    )

    # 받침대 (가로 바, 둥근 끝)
    base_w = head_w * 0.7
    base_stroke = stroke * 0.85
    draw.line(
        [cx - base_w / 2, stem_bottom, cx + base_w / 2, stem_bottom],
        fill=color,
        width=round(base_stroke),
        joint="curve",
    )
    for end_x in (cx - base_w / 2, cx + base_w / 2):
        draw.ellipse(
            [
                end_x - base_stroke / 2,
                stem_bottom - base_stroke / 2,
                end_x + base_stroke / 2,
                stem_bottom + base_stroke / 2,
            ],
            fill=color,
        )


def render_mark(size: int, with_bg: bool, mono: bool = False, margin: float = 0.16) -> Image.Image:
    """마이크 마크 이미지를 렌더링한다.

    with_bg=True 면 둥근 사각 배경(그라데이션)을 채운다 (앱 아이콘/스토어 타일용).
    mono=True 면 배경 없이 단색(흰색) 실루엣만 투명 배경에 그린다 (BadgeLogo용).
    margin 은 캔버스 대비 안전 여백 비율.
    """
    ss = 4  # 슈퍼샘플링 배수 — 다운스케일로 안티앨리어싱 확보
    canvas = size * ss
    img = Image.new("RGBA", (canvas, canvas), (0, 0, 0, 0))

    if with_bg:
        radius = round(canvas * 0.22)
        bg = _vertical_gradient(canvas, BG_TOP, BG_BOTTOM)
        mask = _rounded_rect_mask(canvas, radius)
        img.paste(bg, (0, 0), mask)

    draw = ImageDraw.Draw(img)
    cx = canvas / 2
    cy = canvas / 2 + canvas * 0.02
    head_w = canvas * (1 - margin * 2) * 0.46
    color = MIC_FILL if not mono else (255, 255, 255, 255)
    _draw_mic(draw, cx, cy, head_w, color)

    # 머리 그릴 라인 (배경/투명색으로 얇게 덧그려 질감) — with_bg 일 때만 배경색 사용,
    # mono 일 때는 그릴 생략(작은 배지에서는 잡음이 되므로).
    if with_bg:
        head_h = head_w * 1.5
        hy0 = cy - head_h * 0.95
        for frac in (0.3, 0.56):
            ly = hy0 + head_h * frac
            lw = max(head_w * 0.9, 1)
            draw.line(
                [cx - lw / 2, ly, cx + lw / 2, ly],
                fill=BG_BOTTOM,
                width=max(round(canvas * 0.012), 1),
            )
        # 포인트 컬러 악센트 — 받침대 아래쪽에 얇은 블루 라인
        accent_y = cy + head_h * 0.68
        draw.line(
            [cx - head_w * 0.34, accent_y, cx + head_w * 0.34, accent_y],
            fill=ACCENT,
            width=max(round(canvas * 0.02), 1),
        )

    img = img.resize((size, size), Image.LANCZOS)
    return img


def save_png(img: Image.Image, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    img.save(path, format="PNG")
    print(f"written: {path} ({img.size[0]}x{img.size[1]})")


def main() -> None:
    build_dir = ROOT / "build"
    resources_dir = ROOT / "resources"
    appx_dir = build_dir / "appx"

    # --- 앱 아이콘 (배경 있음) ---
    master = render_mark(1024, with_bg=True)
    save_png(master, build_dir / "icon.png")
    save_png(render_mark(256, with_bg=True), resources_dir / "icon.png")

    ico_sizes = [16, 24, 32, 48, 64, 128, 256]
    master.save(
        build_dir / "icon.ico",
        format="ICO",
        sizes=[(s, s) for s in ico_sizes],
    )
    print(f"written: {build_dir / 'icon.ico'} (sizes={ico_sizes})")

    # --- macOS icns (비목표지만 가능하면 갱신) ---
    icns_path = build_dir / "icon.icns"
    try:
        # ICNS 는 정사각형 1024가 있어야 최고 해상도 항목이 채워진다.
        master.save(icns_path, format="ICNS")
        print(f"written: {icns_path}")
    except Exception as exc:  # noqa: BLE001 - Pillow ICNS 플러그인 실패 시 기존 파일 유지
        print(f"skip icns (keeping existing file): {exc}")

    # --- MSIX(appx) 타일 세트 ---
    # 파일명·크기는 node_modules/app-builder-lib/out/targets/AppxTarget.js 의
    # vendorAssetsForDefaultAssets / isDefaultAssetIncluded 규약을 따른다.
    # 주의: 310x310 큰 타일은 "Square310x310Logo.png" 가 아니라 "LargeTile.png" 로
    # 인식된다 (defaultAssetName 매칭이 "LargeTile" 부분 문자열을 찾음).
    tiles: list[tuple[str, int, int]] = [
        ("StoreLogo.png", 50, 50),
        ("Square44x44Logo.png", 44, 44),
        ("Square150x150Logo.png", 150, 150),
        ("LargeTile.png", 310, 310),
    ]
    for name, w, h in tiles:
        size = max(w, h)
        mark = render_mark(size, with_bg=True, margin=0.2)
        if w != h:
            mark = mark.resize((w, h), Image.LANCZOS)
        save_png(mark, appx_dir / name)

    # Wide310x150Logo — 가로가 긴 캔버스 중앙에 정사각 마크를 배치
    wide_w, wide_h = 310, 150
    ss = 4
    wide = Image.new("RGBA", (wide_w * ss, wide_h * ss), (0, 0, 0, 0))
    bg = _vertical_gradient(wide_h * ss, BG_TOP, BG_BOTTOM).resize((wide_w * ss, wide_h * ss))
    # 배경은 와이드 전체를 둥근 사각으로
    full_mask = Image.new("L", (wide_w * ss, wide_h * ss), 0)
    ImageDraw.Draw(full_mask).rounded_rectangle(
        [0, 0, wide_w * ss - 1, wide_h * ss - 1], radius=round(wide_h * ss * 0.22), fill=255
    )
    wide.paste(bg, (0, 0), full_mask)
    draw = ImageDraw.Draw(wide)
    cx = wide_w * ss / 2
    cy = wide_h * ss / 2 + wide_h * ss * 0.02
    head_w = wide_h * ss * (1 - 0.28) * 0.46
    _draw_mic(draw, cx, cy, head_w, MIC_FILL)
    accent_y = cy + head_w * 1.5 * 0.68
    draw.line(
        [cx - head_w * 0.34, accent_y, cx + head_w * 0.34, accent_y],
        fill=ACCENT,
        width=max(round(wide_h * ss * 0.02), 1),
    )
    wide = wide.resize((wide_w, wide_h), Image.LANCZOS)
    save_png(wide, appx_dir / "Wide310x150Logo.png")

    # BadgeLogo — 투명 배경 + 흰색 단색 실루엣 (알림 배지용 관례)
    badge = render_mark(24, with_bg=False, mono=True, margin=0.08)
    save_png(badge, appx_dir / "BadgeLogo.png")

    print("done.")


if __name__ == "__main__":
    main()
