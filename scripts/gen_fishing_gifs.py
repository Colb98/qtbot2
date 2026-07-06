#!/usr/bin/env python3
"""One-off: pre-render the 7 !cauca (fishing) result GIFs.

Input : assets/fishing/throw_1..5.png + end_<outcome>.png (1448x1086)
Output: assets/fishing/gif/<outcome>.gif  (gitignored; ship to VPS manually
        or un-ignore when the art is approved)

Timeline (~6 fps → 170 ms/frame):
  throw_1 (340 ms, counts as 2 frame slots) → throw_2..4 (170 ms each)
  → throw_5 held 3 s (same as 18 frames @ ~167 ms, but a single frame keeps
    the file small) → ending frame held 5 s → loop.
  "nothing" has no end art: throw_5 fades to black, then white text
  "Bạn câu cá đến khuya nhưng chẳng câu được gì" holds 5 s.

Run: python3 scripts/gen_fishing_gifs.py   (needs Pillow)
"""
import os
from PIL import Image, ImageDraw, ImageEnhance, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, 'assets', 'fishing')
OUT = os.path.join(ROOT, 'assets', 'fishing', 'gif')
FONT = os.path.join(ROOT, 'assets', 'NotoSans-Regular.ttf')

W, H = 480, 360            # 1448x1086 ÷ ~3 — plenty for a Discord embed
FRAME_MS = 170             # ~6 fps
HOLD_THROW5_MS = 3000
HOLD_END_MS = 5000
COLORS = 256

# outcome key → ending source file (None = "nothing": fade to black + text)
OUTCOMES = {
    'small': 'end_small.png',
    'tuna': 'end_tuna.png',
    'catfish': 'end_catfish.png',
    'puffle': 'end_pufflefish.png',
    'treasure': 'end_treasure.png',
    'kelp': 'end_kelp.png',
    'nothing': None,
}

NOTHING_TEXT = 'Bạn câu cá đến khuya\nnhưng chẳng câu được gì'


def load(name):
    return Image.open(os.path.join(SRC, name)).convert('RGB').resize((W, H), Image.LANCZOS)


def nothing_frames(throw5):
    """throw_5 fading into black, then a black card with the story text."""
    frames = []
    for factor in (0.65, 0.35, 0.12):
        frames.append((ImageEnhance.Brightness(throw5).enhance(factor), FRAME_MS))
    black = Image.new('RGB', (W, H), (0, 0, 0))
    frames.append((black, 500))
    card = black.copy()
    draw = ImageDraw.Draw(card)
    font = ImageFont.truetype(FONT, 30)
    draw.multiline_text((W / 2, H / 2), NOTHING_TEXT, font=font, fill=(235, 235, 235),
                        anchor='mm', align='center', spacing=12)
    frames.append((card, HOLD_END_MS))
    return frames


def build(outcome, end_file, throws):
    frames = [(throws[0], FRAME_MS * 2)] + [(t, FRAME_MS) for t in throws[1:4]]
    frames.append((throws[4], HOLD_THROW5_MS))
    if end_file:
        frames.append((load(end_file), HOLD_END_MS))
    else:
        frames.extend(nothing_frames(throws[4]))

    # The 5 throw frames share one palette (no flicker while the rod moves);
    # every frame after them (ending / fade / text) gets its own palette —
    # Pillow writes local color tables, so e.g. the gold chest isn't dragged
    # toward the sky-blue-heavy throw palette. No dithering — the art is
    # flat-color, and dither noise would triple the file size.
    sheet = Image.new('RGB', (W, H * 5))
    for i in range(5):
        sheet.paste(frames[i][0], (0, i * H))
    throw_pal = sheet.quantize(colors=COLORS, method=Image.MEDIANCUT)
    quantized = []
    for i, (im, _) in enumerate(frames):
        if i < 5:
            quantized.append(im.quantize(palette=throw_pal, dither=Image.Dither.NONE))
        else:
            quantized.append(im.quantize(colors=COLORS, method=Image.MEDIANCUT,
                                         dither=Image.Dither.NONE))

    path = os.path.join(OUT, f'{outcome}.gif')
    quantized[0].save(
        path, save_all=True, append_images=quantized[1:],
        duration=[ms for _, ms in frames], loop=0, optimize=True,
    )
    total_ms = sum(ms for _, ms in frames)
    print(f'{outcome:>9}.gif  {os.path.getsize(path) / 1024:7.0f} KB  '
          f'{len(frames)} frames  {total_ms / 1000:.1f}s/loop')


def main():
    os.makedirs(OUT, exist_ok=True)
    throws = [load(f'throw_{i}.png') for i in range(1, 6)]
    for outcome, end_file in OUTCOMES.items():
        build(outcome, end_file, throws)


if __name__ == '__main__':
    main()
