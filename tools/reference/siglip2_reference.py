#!/usr/bin/env python3
"""
Reference for the SigLIP 2 embedding adapter (Phase 5, P5.3).

Uses the OFFICIAL Google checkpoint (google/siglip2-base-patch16-224, PyTorch safetensors) with the
Hugging Face transformers implementation as ground truth, and writes:

  * PNG source images (SYNTHETIC, generated here from a fixed seed, no third-party content);
  * for each: the SHA-256 of the 224x224 RGB bytes PIL's BILINEAR resize produces, the pixel_values
    the official SiglipImageProcessor produces (checked against PIL), and the official PyTorch image
    embedding (pooler_output, 768 floats);
  * the ONNX vision model's embedding for the same images, so the report shows how close the ONNX
    export is to the official weights;
  * for a list of prompts: the token ids the official tokenizer produces and the official text
    embedding, and the ONNX text model's embedding.

Nothing here is invented: every number comes from running the models named in the output.

  python tools/reference/siglip2_reference.py --official DIR --onnx-vision F --onnx-text F --out DIR
"""
import argparse
import base64
import hashlib
import json
import os

import numpy as np
import onnxruntime as ort
import PIL
import torch
import transformers
from PIL import Image
from transformers import AutoTokenizer, SiglipImageProcessor, SiglipModel

SIZE = 224


def sha256(b: bytes) -> str:
    return hashlib.sha256(b).hexdigest()


def b64f32(a: np.ndarray) -> str:
    return base64.b64encode(np.ascontiguousarray(a, dtype="<f4").tobytes()).decode()


def synth(name: str, w: int, h: int, seed: int) -> Image.Image:
    """Deterministic synthetic image: gradients, hard edges and fine noise, so a resize error shows."""
    rng = np.random.default_rng(seed)
    yy, xx = np.mgrid[0:h, 0:w]
    r = (xx * 255 // max(w - 1, 1)).astype(np.float64)
    g = (yy * 255 // max(h - 1, 1)).astype(np.float64)
    b = ((xx // 7 + yy // 5) % 2 * 200).astype(np.float64)
    img = np.stack([r, g, b], axis=-1)
    img[h // 4 : h // 2, w // 4 : w // 2] = [220, 30, 40]
    img[h // 2 : 3 * h // 4, w // 2 : 3 * w // 4] = [20, 60, 230]
    img += rng.normal(0, 12, img.shape)
    return Image.fromarray(np.clip(img, 0, 255).astype(np.uint8), "RGB")


IMAGES = [
    ("SYNTHETIC_37x91", 37, 91, 1),  # both axes enlarged
    ("SYNTHETIC_224x224", 224, 224, 2),  # identity size
    ("SYNTHETIC_100x300", 100, 300, 3),  # mixed: shrink one axis, enlarge the other
    ("SYNTHETIC_640x480", 640, 480, 4),  # typical crop source, shrink
    ("SYNTHETIC_1000x333", 1000, 333, 5),  # strong shrink, odd ratio
]

PROMPTS = [
    "a photo of a white delivery van",
    "a person wearing a red jacket",
    "a black motorcycle with two riders",
    "an auto rickshaw",
    "a truck",
    "",
    "A PHOTO OF A CAR",
    "café ünïcödé प्रवेश द्वार",
    "a very long description of a white delivery van parked near the main gate " * 8,  # > 64 tokens: truncation
]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--official", required=True)
    ap.add_argument("--onnx-vision", required=True)
    ap.add_argument("--onnx-text", required=True)
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)

    torch.set_num_threads(4)
    model = SiglipModel.from_pretrained(a.official, torch_dtype=torch.float32).eval()
    proc = SiglipImageProcessor.from_pretrained(a.official)
    tok = AutoTokenizer.from_pretrained(a.official)
    vis = ort.InferenceSession(a.onnx_vision, providers=["CPUExecutionProvider"])
    txt = ort.InferenceSession(a.onnx_text, providers=["CPUExecutionProvider"])

    out = {
        "generatedBy": "tools/reference/siglip2_reference.py",
        "versions": {"torch": torch.__version__, "transformers": transformers.__version__, "pillow": PIL.__version__, "numpy": np.__version__, "onnxruntime": ort.__version__},
        "checkpoint": "google/siglip2-base-patch16-224",
        "images": [],
        "prompts": [],
    }

    for name, w, h, seed in IMAGES:
        img = synth(name, w, h, seed)
        png = os.path.join(a.out, name + ".png")
        img.save(png, optimize=True)
        resized = img.resize((SIZE, SIZE), Image.BILINEAR)
        rb = np.asarray(resized, dtype=np.uint8).tobytes()
        pv = proc(images=Image.open(png).convert("RGB"), return_tensors="np")["pixel_values"]  # 1,3,224,224
        # our claim: processor == PIL resize / 255 -> (x-0.5)/0.5
        mine = ((np.asarray(resized, dtype=np.float32) / 255.0 - 0.5) / 0.5).transpose(2, 0, 1)[None]
        proc_max_diff = float(np.abs(pv - mine).max())
        with torch.no_grad():
            pt = model.vision_model(pixel_values=torch.from_numpy(pv)).pooler_output.numpy()[0]
        ox = vis.run(["pooler_output"], {"pixel_values": pv.astype(np.float32)})[0][0]
        cos = float(np.dot(pt, ox) / (np.linalg.norm(pt) * np.linalg.norm(ox)))
        out["images"].append({
            "file": name + ".png",
            "pngSha256": sha256(open(png, "rb").read()),
            "width": w,
            "height": h,
            "resized224Sha256": sha256(rb),
            "processorVsPilMaxAbsDiff": proc_max_diff,
            "pytorchEmbeddingF32b64": b64f32(pt),
            "onnxEmbeddingF32b64": b64f32(ox),
            "onnxVsPytorchCosine": cos,
            "onnxVsPytorchMaxAbsDiff": float(np.abs(pt - ox).max()),
        })

    for p in PROMPTS:
        # SigLIP 2 was trained with lower-cased text padded to 64 tokens (model card guidance).
        t = tok([p.lower()], padding="max_length", max_length=64, truncation=True, return_tensors="np")
        ids = t["input_ids"].astype(np.int64)
        with torch.no_grad():
            pt = model.text_model(input_ids=torch.from_numpy(ids)).pooler_output.numpy()[0]
        ox = txt.run(["pooler_output"], {"input_ids": ids})[0][0]
        cos = float(np.dot(pt, ox) / (np.linalg.norm(pt) * np.linalg.norm(ox)))
        out["prompts"].append({
            "text": p,
            "inputText": p.lower(),
            "inputIds": ids[0].tolist(),
            "pytorchEmbeddingF32b64": b64f32(pt),
            "onnxEmbeddingF32b64": b64f32(ox),
            "onnxVsPytorchCosine": cos,
            "onnxVsPytorchMaxAbsDiff": float(np.abs(pt - ox).max()),
        })

    with open(os.path.join(a.out, "siglip2.reference.json"), "w") as f:
        json.dump(out, f, indent=1)
    for i in out["images"]:
        print("image", i["file"], "cos", i["onnxVsPytorchCosine"], "procdiff", i["processorVsPilMaxAbsDiff"])
    for p in out["prompts"]:
        print("prompt", repr(p["text"]), "cos", p["onnxVsPytorchCosine"], "len", len(p["inputIds"]))


if __name__ == "__main__":
    main()
