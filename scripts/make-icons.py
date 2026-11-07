"""生成 PWA 图标：橙红底 + 白色烟花爆点。
用法：python scripts/make-icons.py
输出：public/icon-192.png、public/icon-512.png、public/apple-touch-icon.png
"""

import math
import os

from PIL import Image, ImageDraw, ImageFilter

OUT = os.path.join(os.path.dirname(__file__), "..", "public")
os.makedirs(OUT, exist_ok=True)

EDGE = (194, 65, 12)      # #c2410c
CENTER = (251, 146, 60)   # #fb923c
INK = (255, 248, 240)


def lerp(a, b, t):
    return tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(3))


def render(scale=4):
    size = 512 * scale
    img = Image.new("RGB", (size, size), EDGE)
    d = ImageDraw.Draw(img)

    # 径向渐变（外深内亮）
    steps = 160
    for i in range(steps, 0, -1):
        r = (size / 2) * i / steps
        t = 1 - i / steps
        color = lerp(EDGE, CENTER, t ** 1.15)
        d.ellipse([size / 2 - r, size / 2 - r, size / 2 + r, size / 2 + r], fill=color)

    cx = cy = size / 2
    max_r = size * 0.46

    # 烟花射线
    rays = 16
    for k in range(rays):
        ang = -math.pi / 2 + k * (2 * math.pi / rays)
        r0 = size * 0.10
        r1 = max_r * (0.82 if k % 2 else 1.0)
        x0, y0 = cx + math.cos(ang) * r0, cy + math.sin(ang) * r0
        x1, y1 = cx + math.cos(ang) * r1, cy + math.sin(ang) * r1
        width = int(size * (0.011 if k % 2 else 0.014))
        d.line([x0, y0, x1, y1], fill=INK, width=width)

    # 射线端点点
    for k in range(rays):
        ang = -math.pi / 2 + k * (2 * math.pi / rays)
        r1 = max_r * (0.82 if k % 2 else 1.0)
        x, y = cx + math.cos(ang) * r1, cy + math.sin(ang) * r1
        rad = size * (0.012 if k % 2 else 0.016)
        d.ellipse([x - rad, y - rad, x + rad, y + rad], fill=INK)

    # 中心亮核（带柔光）
    glow = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    gd = ImageDraw.Draw(glow)
    gr = size * 0.075
    gd.ellipse([cx - gr, cy - gr, cx + gr, cy + gr], fill=(255, 255, 255, 235))
    glow = glow.filter(ImageFilter.GaussianBlur(size * 0.012))
    img = Image.alpha_composite(img.convert("RGBA"), glow).convert("RGB")

    return img


def main():
    base = render()
    for name, px in [("icon-512.png", 512), ("icon-192.png", 192), ("apple-touch-icon.png", 180)]:
        out = base.resize((px, px), Image.LANCZOS)
        path = os.path.join(OUT, name)
        out.save(path, "PNG", optimize=True)
        print(f"{name}: {out.size[0]}x{out.size[1]}  {os.path.getsize(path)} bytes")


if __name__ == "__main__":
    main()