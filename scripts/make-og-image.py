"""Generate a 1200x630 OpenGraph share image for Pro Daily Link."""
from PIL import Image, ImageDraw, ImageFont
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
W, H = 1200, 630

# Brand colors (from landing.css)
INK = (17, 20, 22)
ORANGE = (255, 107, 26)
DARK = (16, 37, 30)      # theme-color #10251e
CREAM = (246, 243, 236)
WHITE = (255, 255, 255)
MUTED = (199, 207, 203)

img = Image.new("RGB", (W, H), DARK)
d = ImageDraw.Draw(img)

# Fonts: prefer DejaVu (ships with the runtime), fall back to PIL default.
def font(size, bold=True):
    candidates = [
        "C:/Windows/Fonts/arialbd.ttf" if bold else "C:/Windows/Fonts/arial.ttf",
        "C:/Windows/Fonts/segoeui.ttf",
    ]
    for c in candidates:
        if os.path.exists(c):
            return ImageFont.truetype(c, size)
    return ImageFont.load_default()

f_eyebrow = font(26)
f_h1 = font(62)
f_h1b = font(62)
f_sub = font(28, bold=False)

# Eyebrow
d.text((70, 120), "FIELD TRUTH. OFFICE CLARITY.", font=f_eyebrow, fill=ORANGE)

# Headline, two lines
d.text((70, 190), "Catch extra work", font=f_h1, fill=WHITE)
d.text((70, 272), "before it gets missed.", font=f_h1b, fill=WHITE)

# Subline
d.text((70, 385), "Daily notes, photos, and crew hours - organized by AI,", font=f_sub, fill=MUTED)
d.text((70, 430), "verified by the office, priced by the work actually done.", font=f_sub, fill=MUTED)

# Accent rule
d.rectangle([70, 500, 190, 508], fill=ORANGE)

# Logo on the right
logo = Image.open(os.path.join(ROOT, "assets/pro-daily-link-logo.png")).convert("RGBA")
logo.thumbnail((300, 300), Image.LANCZOS)
# white rounded tile behind logo
tile = Image.new("RGBA", (340, 340), (0, 0, 0, 0))
td = ImageDraw.Draw(tile)
td.rounded_rectangle([0, 0, 339, 339], radius=36, fill=(255, 255, 255, 255))
tile.alpha_composite(logo, ((340 - logo.width) // 2, (340 - logo.height) // 2))
img.paste(tile, (810, 145), tile)

out = os.path.join(ROOT, "assets", "og-image.png")
img.save(out, "PNG", optimize=True)
print("saved", out, os.path.getsize(out), "bytes")
