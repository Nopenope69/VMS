#!/usr/bin/env python3
"""
Redaction test fixtures (P4.4): a SYNTHETIC road scene with a synthetic Indian plate and a
public-domain face.

The face is NASA's portrait of astronaut Eileen Collins, as shipped in scikit-image
(skimage/data/astronaut.png; "No known copyright restrictions, released into the public domain").
Pass its path with --astronaut. It is the only real-world image content in the fixtures.

    python3 tools/redaction/make_fixtures.py --astronaut skimage/data/astronaut.png --out DIR

Writes SYNTHETIC_face_plate_scene.png (960x540) and SYNTHETIC_redaction_manifest.json with the
ground-truth plate box and the face region of the pasted portrait.
"""
import argparse
import hashlib
import json
import os
import sys

from PIL import Image

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "anpr"))
from synth_plates import render_plate  # noqa: E402

ASTRONAUT_SHA256 = "88431cd9653ccd539741b555fb0a46b61558b301d4110412b5bc28b5e3ea6cb5"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--astronaut", required=True)
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    raw = open(a.astronaut, "rb").read()
    if hashlib.sha256(raw).hexdigest() != ASTRONAUT_SHA256:
        sys.exit("astronaut.png does not match the pinned scikit-image 0.26.0 file")
    os.makedirs(a.out, exist_ok=True)
    W, H = 960, 540
    scene = Image.new("RGB", (W, H), (110, 114, 120))
    # Portrait (512x512) scaled to 300x300, standing at the left of the frame.
    portrait = Image.open(a.astronaut).convert("RGB").resize((300, 300), Image.BICUBIC)
    px, py = 40, 60
    scene.paste(portrait, (px, py))
    # Vehicle rear with a plate on the right.
    from PIL import ImageDraw
    d = ImageDraw.Draw(scene)
    d.rounded_rectangle([470, 180, 920, 500], radius=30, fill=(35, 40, 70))
    plate = render_plate(["MH 12 AB 1234"], (250, 250, 250), (15, 15, 15), True, "sans-bold")
    plate = plate.resize((int(plate.width * 0.62), int(plate.height * 0.62)), Image.BICUBIC)
    bx, by = 695 - plate.width // 2, 410
    scene.paste(plate, (bx, by))
    name = "SYNTHETIC_face_plate_scene.png"
    scene.save(os.path.join(a.out, name))
    manifest = {
        "kind": "SYNTHETIC",
        "generator": "tools/redaction/make_fixtures.py",
        "faceSource": "scikit-image 0.26.0 skimage/data/astronaut.png (NASA, public domain)",
        "faceSourceSha256": ASTRONAUT_SHA256,
        "file": name,
        "portraitBoxXYXY": [px, py, px + 300, py + 300],
        "plateBoxXYXY": [bx, by, bx + plate.width, by + plate.height],
        "plateText": "MH12AB1234",
    }
    json.dump(manifest, open(os.path.join(a.out, "SYNTHETIC_redaction_manifest.json"), "w"), indent=1)
    print(json.dumps(manifest))


if __name__ == "__main__":
    main()
