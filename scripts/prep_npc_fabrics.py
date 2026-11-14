#!/usr/bin/env python3
"""Prep raw NPC fabric textures for ped scale.

The Poly Haven 1024px weaves are too fine to read on a ~0.3m torso at game
distance. Crop the center 512px (a representative weave patch) and upscale
back to 1024 with a mild contrast boost: the weave pattern then lands at a
scale the eye resolves as fabric at 1-3m.
"""
from PIL import Image, ImageEnhance

BASE = "/home/z/my-project/public/textures/raw"
FILES = ["npc_shirt_diff.jpg", "npc_pants_diff.jpg", "npc_jacket_diff.jpg", "npc_shoe_diff.jpg"]

for name in FILES:
    p = f"{BASE}/{name}"
    im = Image.open(p).convert("RGB")
    w, h = im.size
    # Second zoom pass: take the center 512 (= the original photo's 256px core,
    # since the first pass already upscaled 512->1024) and blow it back to
    # 1024. Combined with 1x1 tiling this puts each knit loop at ~6 screen px
    # on a ped torso -- the weave finally resolves as fabric.
    cx0, cy0 = (w - 512) // 2, (h - 512) // 2
    crop = im.crop((cx0, cy0, cx0 + 512, cy0 + 512))
    up = crop.resize((1024, 1024), Image.LANCZOS)
    up = ImageEnhance.Contrast(up).enhance(1.18)
    up = ImageEnhance.Sharpness(up).enhance(1.2)
    up.save(p, "JPEG", quality=90)
    print(f"{name}: zoom pass 2 done")

print("done")
