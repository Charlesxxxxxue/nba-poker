#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
球星卡面合成 v2：AI 底图 → 裁 3:4 → 暖调分级 → 叠中文文字层 → 输出两档

变更（相对 v1）：
  - 底图目录改为 v0.6_raw/<key>/（一位一目录，避免顺序错位）
  - 卡面元数据直接从 rules.js 解析，杜绝手工录入错误
  - 描述文案超长时自动降字号 / 截断，保证不溢出底栏
  - 统一去水印（P0：老 v0.4 卡面带 WORKBUDDY 水印，本版不叠加任何水印）

输出：
  star_cards/v0.6/A_<key>_hearthstone.png   768x1024  存档母版
  _deploy/star_cards/A_<key>_hearthstone.jpg  384x512  线上压缩版

设计依据（项目铁律）：
  T-01 三锚 有球必应 × 炉石 × NIKE
  T-04 单卡色相 ≤ 5
  T-10 暖木地板 + 冷蓝聚光
  T-11 主字体运动风无衬线
"""
from PIL import Image, ImageDraw, ImageFont, ImageEnhance
import os, re, io, glob

ROOT = "/Users/charlescxue/WorkBuddy/20260524094804/nba-poker"
BASE = os.path.join(ROOT, "04_stage_ux/art")
RAW  = os.path.join(BASE, "star_cards/v0.6_raw")
OUT  = os.path.join(BASE, "star_cards/v0.6")
DEPLOY = os.path.join(ROOT, "03_playable_proto/_deploy/star_cards")
RULES = os.path.join(ROOT, "03_playable_proto/rules.js")

FONT_BOLD = "/System/Library/Fonts/STHeiti Medium.ttc"
FONT_FALLBACK = "/Library/Fonts/Arial Unicode.ttf"

# 主色（T-04 五色上限：暖木 / 琥珀橙 / 深炭 / 冷蓝 / 米白）
GOLD   = (255, 200, 61)
CREAM  = (245, 238, 224)
CHAR   = (16, 14, 18)
BLUE   = (120, 160, 220)

TYPE_COLOR = {
    "passive":  (120, 200, 140),
    "active":   (255, 170, 80),
    "reactive": (150, 180, 255),
}
TYPE_LABEL = {"passive": "被动", "active": "主动", "reactive": "反应"}


def load_stars():
    """从 rules.js 解析 25 星元数据，返回 {key: {...}}"""
    s = io.open(RULES, encoding="utf-8").read()
    m = re.search(r"const STARS\s*=\s*\{(.*?)\n  \};", s, re.S)
    assert m, "rules.js 中未找到 STARS 定义"
    block = m.group(1)
    # 乔丹条目用了 JS 字符串拼接：cd: "每局指定" + JORDAN_WILDS + "张"
    # JORDAN_WILDS === 1，先折叠为字面量，否则正则会提前截断
    block = re.sub(r'"\s*\+\s*JORDAN_WILDS\s*\+\s*"', "1", block)
    out = {}
    pattern = re.compile(
        r'(\w+):\s*\{\s*key:\s*"([^"]+)",\s*name:\s*"([^"]+)",\s*skill:\s*"([^"]+)",\s*'
        r'type:\s*"([^"]+)",\s*cd:\s*"([^"]+)",\s*desc:\s*"([^"]+)"'
    )
    for key, k, name, skill, typ, cd, desc in pattern.findall(block):
        out[key] = {"name": name, "skill": skill, "type": typ, "cd": cd, "desc": desc}
    return out


def font(size):
    for p in (FONT_BOLD, FONT_FALLBACK):
        if os.path.exists(p):
            try:
                return ImageFont.truetype(p, size)
            except Exception:
                pass
    return ImageFont.load_default()


def crop_3x4(im):
    """中心裁切成 3:4"""
    w, h = im.size
    target_h = int(round(w / 0.75))
    if h <= target_h:
        return im
    top = (h - target_h) // 2
    return im.crop((0, top, w, top + target_h))


def warm_grade(im):
    """暖调分级：把偏冷的 AI 底图拉回 T-10 暖木 + 冷蓝"""
    r, g, b = im.split()
    r = r.point(lambda v: min(255, int(v * 1.06 + 4)))
    g = g.point(lambda v: min(255, int(v * 1.01)))
    b = b.point(lambda v: int(v * 0.94))
    im = Image.merge("RGB", (r, g, b))
    im = ImageEnhance.Color(im).enhance(1.15)
    im = ImageEnhance.Contrast(im).enhance(1.06)
    return im


def stroke_text(draw, xy, text, f, fill, stroke=CHAR, width=3, anchor=None):
    """带描边的文本，保证在任意底图上可读"""
    x, y = xy
    for dx in range(-width, width + 1):
        for dy in range(-width, width + 1):
            if dx * dx + dy * dy <= width * width:
                draw.text((x + dx, y + dy), text, font=f, fill=stroke, anchor=anchor)
    draw.text((x, y), text, font=f, fill=fill, anchor=anchor)


def wrap(draw, text, f, max_w, max_lines=3):
    """中文按字换行；超出行数返回 None，由调用方降字号重试"""
    lines, cur = [], ""
    for ch in text:
        t = cur + ch
        if draw.textlength(t, font=f) > max_w and cur:
            lines.append(cur)
            cur = ch
            if len(lines) >= max_lines:
                break
        else:
            cur = t
    if cur and len(lines) < max_lines:
        lines.append(cur)
    return lines if lines else None


def fit_desc(d, desc, W, sizes=(27, 24, 21)):
    """自适应字号：优先大字号，行数超限则降档，仍超限则末行加省略号"""
    max_w = W - int(W * 0.18)
    for size in sizes:
        f = font(size)
        lines = wrap(d, desc, f, max_w, max_lines=3)
        if lines is None:
            continue
        # 判断是否被截断
        shown = "".join(lines)
        if len(shown) < len(desc):
            lines[-1] = lines[-1][:-1] + "…"
        return lines, f, size
    # 兜底：最小字号硬截
    f = font(sizes[-1])
    lines = wrap(d, desc, f, max_w, max_lines=2)
    lines[-1] = lines[-1][:-1] + "…"
    return lines, f, sizes[-1]


def compose(bg_path, meta, out_png, out_jpg):
    im = crop_3x4(Image.open(bg_path).convert("RGB"))
    im = im.resize((768, 1024), Image.LANCZOS)
    im = warm_grade(im)
    W, H = im.size

    # ---- 底部信息条：渐变遮罩，保证文字可读 ----
    bar = Image.new("L", (W, H), 0)
    bd = ImageDraw.Draw(bar)
    y0 = int(H * 0.66)
    for i in range(H - y0):
        bd.line([(0, y0 + i), (W, y0 + i)], fill=int(215 * (i / (H - y0)) ** 1.6))
    shade = Image.new("RGB", (W, H), CHAR)
    im = Image.composite(shade, im, bar)

    d = ImageDraw.Draw(im)

    # ---- 顶部：球员名 ----
    f_name = font(64)
    stroke_text(d, (W // 2, int(H * 0.135)), meta["name"], f_name, CREAM, width=4, anchor="mm")

    # ---- 技能名 + 类型标签 ----
    f_skill = font(46)
    stroke_text(d, (W // 2, int(H * 0.745)), meta["skill"], f_skill, GOLD, width=3, anchor="mm")

    base_type = meta["type"].split("+")[0]
    tcol = TYPE_COLOR.get(base_type, BLUE)
    tag = "%s · %s" % (TYPE_LABEL.get(base_type, base_type), meta["cd"])
    f_tag = font(26)
    tw = d.textlength(tag, font=f_tag)
    tx = W - int(W * 0.07)
    ty = int(H * 0.745)
    d.rounded_rectangle([tx - tw - 22, ty - 22, tx + 10, ty + 22], radius=16,
                        fill=(20, 18, 24), outline=tcol, width=2)
    d.text((tx - tw / 2 - 6, ty), tag, font=f_tag, fill=tcol, anchor="mm")

    # ---- 描述（自适应字号）----
    lines, f_desc, size = fit_desc(d, meta["desc"], W)
    y = int(H * 0.815)
    step = {27: 38, 24: 34, 21: 30}[size]
    for ln in lines:
        d.text((W // 2, y), ln, font=f_desc, fill=CREAM, anchor="mm")
        y += step

    os.makedirs(os.path.dirname(out_png), exist_ok=True)
    im.save(out_png, "PNG")
    small = im.resize((384, 512), Image.LANCZOS)
    os.makedirs(os.path.dirname(out_jpg), exist_ok=True)
    small.save(out_jpg, "JPEG", quality=88, optimize=True)
    return out_png, out_jpg


def main():
    stars = load_stars()
    print("从 rules.js 解析到 %d 位球星" % len(stars))

    done, missing = [], []
    for key, meta in stars.items():
        cands = glob.glob(os.path.join(RAW, key, "*.png"))
        if not cands:
            missing.append(key)
            continue
        bg = sorted(cands)[0]
        png = os.path.join(OUT, "A_%s_hearthstone.png" % key)
        jpg = os.path.join(DEPLOY, "A_%s_hearthstone.jpg" % key)
        compose(bg, meta, png, jpg)
        done.append(key)
        print("  OK %-12s %-8s %-10s jpg %3d KB" % (
            key, meta["name"], meta["skill"], os.path.getsize(jpg) // 1024))

    print("\n合成完成 %d / %d" % (len(done), len(stars)))
    if missing:
        print("缺失底图：", missing)
        raise SystemExit(1)


if __name__ == "__main__":
    main()
