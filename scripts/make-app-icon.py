#!/usr/bin/env python3
"""
把一张方形源图做成整套应用图标（超椭圆圆角，苹果那种）。

为什么用超椭圆而不是普通圆角矩形：
普通圆角在直边与圆角交界处曲率突变，缩到 32px 会显得"方角上贴了个圆"；
超椭圆 |x|^n + |y|^n = 1（n≈5）曲率连续过渡，小尺寸下更像苹果图标那种"饱满的方圆"。

用法：
    python scripts/make-app-icon.py assets/brand/strata-icon-v2.png
    python scripts/make-app-icon.py 新图.png --n 5 --pad 0.06

--pad 是四周留白（0.06 = 6%），给内容一点呼吸；纯色满幅的图用 0 更合适。
旧图标会先备份到 .workbuddy/backups/icons-<时间戳>/，出问题可以整体还原。
"""
from __future__ import annotations

import argparse
import math
import shutil
import sys
import time
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
ICON_DIR = ROOT / "src-tauri" / "icons"

# LANCZOS 在新版 Pillow 里挪到了 Image.Resampling
try:
    RESAMPLE = Image.Resampling.LANCZOS
except AttributeError:  # pragma: no cover - 老版本 Pillow
    RESAMPLE = Image.LANCZOS

# Tauri 真正用到的那几个，外加 Windows 商店图所需的一组
PNG_SIZES = {
    "32x32.png": 32,
    "64x64.png": 64,
    "128x128.png": 128,
    "128x128@2x.png": 256,
    "icon.png": 512,
    "StoreLogo.png": 50,
    "Square30x30Logo.png": 30,
    "Square44x44Logo.png": 44,
    "Square71x71Logo.png": 71,
    "Square89x89Logo.png": 89,
    "Square107x107Logo.png": 107,
    "Square142x142Logo.png": 142,
    "Square150x150Logo.png": 150,
    "Square284x284Logo.png": 284,
    "Square310x310Logo.png": 310,
}

ICO_SIZES = [16, 24, 32, 48, 64, 128, 256]


def squircle_mask(size: int, n: float, pad: float) -> Image.Image:
    """生成一张超椭圆遮罩。先 4 倍超采样再缩，边缘才不会有锯齿。"""
    ss = 4
    big = size * ss
    img = Image.new("L", (big, big), 0)
    draw = ImageDraw.Draw(img)
    c = big / 2
    r = c * (1 - pad)
    exp = 2.0 / n
    pts = []
    # 720 段已经足够平滑（每段 0.5°）
    for i in range(720):
        t = 2 * math.pi * i / 720
        ca, sa = math.cos(t), math.sin(t)
        x = c + r * math.copysign(abs(ca) ** exp, ca)
        y = c + r * math.copysign(abs(sa) ** exp, sa)
        pts.append((x, y))
    draw.polygon(pts, fill=255)
    return img.resize((size, size), RESAMPLE)


def center_square(im: Image.Image) -> Image.Image:
    """裁成正方形（取中心），避免非 1:1 的源图被拉扁。"""
    w, h = im.size
    if w == h:
        return im
    side = min(w, h)
    left = (w - side) // 2
    top = (h - side) // 2
    return im.crop((left, top, left + side, top + side))


def rounded(im: Image.Image, size: int, n: float, pad: float) -> Image.Image:
    src = im.resize((size, size), RESAMPLE)
    mask = squircle_mask(size, n, pad)
    out = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    out.paste(src, (0, 0), mask)
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("source", help="源图路径（方形最好，非方形会按中心裁方）")
    ap.add_argument("--n", type=float, default=5.0, help="超椭圆指数，苹果约 5（默认 5）")
    ap.add_argument("--pad", type=float, default=0.0, help="四周留白比例，0–0.2（默认 0）")
    ap.add_argument("--no-backup", action="store_true", help="不备份旧图标（不推荐）")
    args = ap.parse_args()

    src_path = Path(args.source)
    if not src_path.is_absolute():
        src_path = (Path.cwd() / src_path).resolve()
    if not src_path.exists():
        print(f"找不到源图：{src_path}")
        return 1
    if not (0.0 <= args.pad < 0.3):
        print("--pad 必须在 0–0.3 之间")
        return 1

    im = Image.open(src_path).convert("RGBA")
    im = center_square(im)
    print(f"源图：{src_path}  {im.size[0]}×{im.size[1]}  超椭圆 n={args.n}  留白={args.pad:.0%}")

    # 备份：整套图标目录先复制一份，出问题能整体还原
    if not args.no_backup and ICON_DIR.exists():
        stamp = time.strftime("%Y%m%d-%H%M%S")
        bak = ROOT / ".workbuddy" / "backups" / f"icons-{stamp}"
        bak.parent.mkdir(parents=True, exist_ok=True)
        shutil.copytree(ICON_DIR, bak)
        print(f"旧图标已备份 → {bak}")

    ICON_DIR.mkdir(parents=True, exist_ok=True)

    for name, size in PNG_SIZES.items():
        rounded(im, size, args.n, args.pad).save(ICON_DIR / name, "PNG")
    print(f"PNG：{len(PNG_SIZES)} 个尺寸")

    # ICO：把几个常用尺寸一次塞进同一个文件，Windows 按场景自己挑
    ico_frames = [rounded(im, s, args.n, args.pad) for s in ICO_SIZES]
    ico_frames[-1].save(
        ICON_DIR / "icon.ico",
        format="ICO",
        sizes=[(s, s) for s in ICO_SIZES],
        append_images=ico_frames[:-1],
    )
    print(f"ICO：{len(ICO_SIZES)} 个尺寸")

    print("完成。接着跑 npm run tauri:build 让 exe 带上新图标。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
