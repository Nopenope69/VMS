#!/usr/bin/env python3
"""
SYNTHETIC Indian number-plate scenes for pipeline tests (not for accuracy claims).

Renders plates in the formats the ANPR pipeline must handle (private white, commercial yellow,
EV green, Bharat BH series, HSRP with the blue "IND" strip, two-line two-wheeler plates) with
DejaVu fonts (Bitstream Vera licence: free to use, including rendering into images), places them
on a plain synthetic vehicle-like scene with mild rotation, blur and noise, and writes PNGs plus
a manifest with the ground-truth text.

    python3 tools/anpr/synth_plates.py --out DIR [--seed 7]
    python3 tools/anpr/synth_plates.py --out DIR --random N [--seed 7]   # labelled dataset layout

--random writes N random, format-valid plates as a dataset directory (dataset.json kind SYNTHETIC,
labels.csv with image_path,plate_text,split,camera,condition,x,y,w,h). It exists to smoke-test the
evaluation and fine-tuning tools; it says nothing about accuracy on real plates.

Every output file name and the manifest carry SYNTHETIC. Real accuracy needs site data (P4.3).
"""
import argparse
import json
import os
import random

from PIL import Image, ImageDraw, ImageFilter, ImageFont

FONTS = {
    "sans-bold": "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "sans-mono": "/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf",
    "serif": "/usr/share/fonts/truetype/dejavu/DejaVuSerif-Bold.ttf",
}

# (id, lines, background, foreground, hsrp, font)
PLATES = [
    ("private_hsrp", ["MH 12 AB 1234"], (250, 250, 250), (15, 15, 15), True, "sans-bold"),
    ("commercial", ["KA 05 C 7788"], (245, 200, 30), (10, 10, 10), True, "sans-bold"),
    ("ev_green", ["DL 3C AB 4521"], (20, 130, 60), (250, 250, 250), False, "sans-bold"),
    ("bharat_series", ["22 BH 4567 AA"], (250, 250, 250), (15, 15, 15), True, "serif"),
    ("two_line_two_wheeler", ["TN 09", "BK 3301"], (250, 250, 250), (15, 15, 15), False, "sans-bold"),
    ("mono_font", ["GJ 01 KL 0099"], (250, 250, 250), (15, 15, 15), False, "sans-mono"),
]


def render_plate(lines, bg, fg, hsrp, font_key):
    two_line = len(lines) == 2
    w, h = (300, 150) if two_line else (520, 110)
    img = Image.new("RGB", (w, h), bg)
    d = ImageDraw.Draw(img)
    d.rectangle([2, 2, w - 3, h - 3], outline=fg, width=4)
    x0 = 12
    if hsrp:
        d.rectangle([8, 8, 48, h - 9], fill=(20, 60, 170))
        small = ImageFont.truetype(FONTS["sans-bold"], 16)
        d.text((12, h - 32), "IND", font=small, fill=(250, 250, 250))
        x0 = 58
    size = 62 if two_line else 72
    font = ImageFont.truetype(FONTS[font_key], size)
    for i, line in enumerate(lines):
        bbox = d.textbbox((0, 0), line, font=font)
        tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
        avail = w - x0 - 12
        if tw > avail:  # shrink to fit
            font = ImageFont.truetype(FONTS[font_key], int(size * avail / tw))
            bbox = d.textbbox((0, 0), line, font=font)
            tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
        cy = (h / 2 - th / 2) if not two_line else (h * (0.27 if i == 0 else 0.73) - th / 2)
        d.text((x0 + (avail - tw) / 2 - bbox[0], cy - bbox[1]), line, font=font, fill=fg)
    return img


def scene(plate, rng):
    W, H = 960, 540
    img = Image.new("RGB", (W, H), (118, 122, 128))
    d = ImageDraw.Draw(img)
    for y in range(0, H, 6):  # road-like gradient
        g = 90 + int(40 * y / H)
        d.line([(0, y), (W, y)], fill=(g, g, g + 4), width=6)
    body = (rng.randint(20, 60), rng.randint(20, 60), rng.randint(40, 90))
    d.rounded_rectangle([W * 0.2, H * 0.22, W * 0.8, H * 0.92], radius=40, fill=body)
    d.rectangle([W * 0.27, H * 0.28, W * 0.73, H * 0.5], fill=(40, 50, 60))  # windscreen
    p = plate.rotate(rng.uniform(-3, 3), expand=True, resample=Image.BICUBIC, fillcolor=body)
    scale = rng.uniform(0.55, 0.7)
    p = p.resize((int(p.width * scale), int(p.height * scale)), Image.BICUBIC)
    x = int(W / 2 - p.width / 2 + rng.uniform(-20, 20))
    y = int(H * 0.68 - p.height / 2)
    img.paste(p, (x, y))
    img = img.filter(ImageFilter.GaussianBlur(rng.uniform(0.4, 0.9)))
    px = img.load()
    for _ in range(4000):
        i, j = rng.randrange(W), rng.randrange(H)
        r, g, b = px[i, j]
        n = rng.randint(-18, 18)
        px[i, j] = (max(0, min(255, r + n)), max(0, min(255, g + n)), max(0, min(255, b + n)))
    return img, [x, y, p.width, p.height]


STATES = ["AP", "AR", "AS", "BR", "CG", "CH", "DD", "DL", "GA", "GJ", "HP", "HR", "JH", "JK", "KA", "KL", "LA", "LD",
          "MH", "ML", "MN", "MP", "MZ", "NL", "OD", "PB", "PY", "RJ", "SK", "TG", "TN", "TR", "UK", "UP", "WB"]
SERIES = "ABCDEFGHJKLMNPQRSTUVWXYZ"  # never I or O
STYLES = [  # (condition, background, foreground, hsrp, font)
    ("private", (250, 250, 250), (15, 15, 15), True, "sans-bold"),
    ("commercial", (245, 200, 30), (10, 10, 10), True, "sans-bold"),
    ("ev", (20, 130, 60), (250, 250, 250), False, "sans-bold"),
    ("mono", (250, 250, 250), (15, 15, 15), False, "sans-mono"),
    ("serif", (250, 250, 250), (15, 15, 15), True, "serif"),
]


def random_plate(rng):
    """Returns (display lines, normalised text) for a random, format-valid Indian plate."""
    if rng.random() < 0.15:
        yy, num = rng.randint(21, 26), rng.randint(1, 9999)
        suf = "".join(rng.choice(SERIES) for _ in range(rng.choice([1, 2])))
        text = f"{yy}BH{num:04d}{suf}"
        return [f"{yy} BH {num:04d} {suf}"], text
    st = rng.choice(STATES)
    dist = rng.randint(1, 99)
    ser = "".join(rng.choice(SERIES) for _ in range(rng.choice([1, 2, 2, 2])))
    num = rng.randint(1, 9999)
    text = f"{st}{dist:02d}{ser}{num:04d}"
    if rng.random() < 0.2:
        return [f"{st} {dist:02d}", f"{ser} {num:04d}"], text
    return [f"{st} {dist:02d} {ser} {num:04d}"], text


def random_dataset(out, n, rng, seed):
    os.makedirs(out, exist_ok=True)
    rows = ["image_path,plate_text,split,camera,condition,x,y,w,h"]
    for i in range(n):
        lines, text = random_plate(rng)
        cond, bg, fg, hsrp, font = rng.choice(STYLES)
        img, (x, y, w, h) = scene(render_plate(lines, bg, fg, hsrp, font), rng)
        name = f"SYNTHETIC_{i:05d}.png"
        img.save(os.path.join(out, name))
        split = "test" if i % 5 == 0 else ("val" if i % 5 == 1 else "train")
        rows.append(f"{name},{text},{split},synthetic,{cond}{'-2line' if len(lines) == 2 else ''},{x},{y},{w},{h}")
    with open(os.path.join(out, "labels.csv"), "w") as f:
        f.write("\n".join(rows) + "\n")
    with open(os.path.join(out, "dataset.json"), "w") as f:
        json.dump({"kind": "SYNTHETIC", "name": f"random synthetic plates (seed {seed}, n={n})",
                   "generator": "tools/anpr/synth_plates.py --random", "seed": seed}, f, indent=1)
    print(json.dumps({"written": n, "out": out}))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    ap.add_argument("--seed", type=int, default=7)
    ap.add_argument("--random", type=int, default=0, help="write N random plates as a labelled dataset")
    a = ap.parse_args()
    rng = random.Random(a.seed)
    if a.random:
        return random_dataset(a.out, a.random, rng, a.seed)
    os.makedirs(a.out, exist_ok=True)
    manifest = {"kind": "SYNTHETIC", "generator": "tools/anpr/synth_plates.py", "seed": a.seed, "images": []}
    for pid, lines, bg, fg, hsrp, font in PLATES:
        plate = render_plate(lines, bg, fg, hsrp, font)
        img, box = scene(plate, rng)
        name = f"SYNTHETIC_{pid}.png"
        img.save(os.path.join(a.out, name))
        text = "".join("".join(l.split()) for l in lines)
        manifest["images"].append({"file": name, "plateText": text, "lines": lines, "plateBoxXYWH": box, "format": pid})
    with open(os.path.join(a.out, "SYNTHETIC_manifest.json"), "w") as f:
        json.dump(manifest, f, indent=1)
    print(json.dumps({"written": len(manifest["images"]), "out": a.out}))


if __name__ == "__main__":
    main()
