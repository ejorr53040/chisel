"""Regenerate Chisel's brand images: the faceted-block mark as favicon set and OG cards.

Reuses the ejorr brand generators (~/.claude/skills/brand), swapping the cube
mark for the faceted block: the ejorr cube with its near corner chiselled off.

    python3 scripts/brand.py        # writes public/ favicons + docs/og-{light,dark}.png
"""
import argparse
import importlib.util
from pathlib import Path

BRAND = Path.home() / ".claude/skills/brand/scripts/gen_pattern.py"
ROOT = Path(__file__).resolve().parent.parent

# Same 32 grid as the cube; the near corner (16,15) is cut at the midpoints of its three edges.
MARK_D = "M16 3l11 6v14l-11 6-11-6V9z M5 9l5.5 3h11L27 9 M10.5 12L16 22l5.5-10 M16 22v7"
HIDDEN_D = ""  # the cube's dashed back edge would cross the facet
SEGMENTS = [((16, 3), (27, 9)), ((27, 9), (27, 23)), ((27, 23), (16, 29)), ((16, 29), (5, 23)),
            ((5, 23), (5, 9)), ((5, 9), (16, 3)), ((5, 9), (10.5, 12)), ((10.5, 12), (21.5, 12)),
            ((21.5, 12), (27, 9)), ((10.5, 12), (16, 22)), ((21.5, 12), (16, 22)), ((16, 22), (16, 29))]

spec = importlib.util.spec_from_file_location("gen_pattern", BRAND)
gp = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gp)
ejorr_small = gp.mark_svg(small=True)  # the ejorr cube, kept for the card's byline
gp.MARK_D, gp.HIDDEN_D, gp.CUBE = MARK_D, HIDDEN_D, SEGMENTS

gp.do_favicon(argparse.Namespace(title="Chisel", out=str(ROOT / "public")))
chisel_mark = gp.mark_svg
gp.mark_svg = lambda small, colour="currentColor": ejorr_small if small else chisel_mark(False, colour)
for theme in ("light", "dark"):
    gp.do_og(argparse.Namespace(title="Chisel", subtitle="Sketch the blocks. An agent carves the code.",
                                theme=theme, out=str(ROOT / f"docs/og-{theme}.png")))
