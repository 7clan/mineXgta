#!/usr/bin/env python3
"""Generate a legacy 64x32 Minecraft-format test skin (top half only:
head/hat/body/right-arm/right-leg regions) with distinctive colors so the
loader's legacy->64x64 mirroring + classic detection can be visually QA'd.
Also copies the karriqs TLauncher skin for the file-upload path test."""
from PIL import Image
import shutil

# region: (x, y, w, h)
HEAD = {"top": (8,0,8,8), "bottom": (16,0,8,8), "right": (0,8,8,8), "front": (8,8,8,8), "left": (16,8,8,8), "back": (24,8,8,8)}
BODY = {"top": (20,16,8,4), "bottom": (28,16,8,4), "right": (16,20,4,12), "front": (20,20,8,12), "left": (28,20,4,12), "back": (32,20,8,12)}
ARMR = {"top": (44,16,4,4), "bottom": (48,16,4,4), "right": (40,20,4,12), "front": (44,20,4,12), "left": (48,20,4,12), "back": (52,20,4,12)}
LEGR = {"top": (4,16,4,4), "bottom": (8,16,4,4), "right": (0,20,4,12), "front": (4,20,4,12), "left": (8,20,4,12), "back": (12,20,4,12)}

im = Image.new("RGBA", (64, 32), (0, 0, 0, 0))

def fill(regions, color, marker=None):
    for name, (x, y, w, h) in regions.items():
        rgba = tuple(int(color[i:i+2], 16) for i in (0, 2, 4)) + (255,)
        for yy in range(y, y + h):
            for xx in range(x, x + w):
                im.putpixel((xx, yy), rgba)
        if marker and name == "front":
            # 2px black eyes + nose marker on the front face
            mx, my = x + w // 2 - 2, y + h // 2
            for e in (0, 3):
                im.putpixel((mx + e, my), (20, 18, 28, 255))
                im.putpixel((mx + e + 1, my), (20, 18, 28, 255))
            im.putpixel((x + w // 2, my + 2), (160, 100, 70, 255))

fill(HEAD, "e8c35a", marker=True)   # yellow head, black eyes
fill(BODY, "c0392b")                # red body
fill(ARMR, "27ae60")                # green right arm
fill(LEGR, "2980d9")                # blue right leg
# shade one column of the right-arm front for the mirror check
for yy in range(20, 32):
    im.putpixel((44, yy), (30, 90, 60, 255))  # darker green column at the front's left edge

im.save("/home/z/my-project/public/qa-legacy-skin.png")
shutil.copy("/tmp/tl-skin.png", "/home/z/my-project/public/qa-upload-skin.png")
print("wrote public/qa-legacy-skin.png", im.size)
print("copied public/qa-upload-skin.png")
