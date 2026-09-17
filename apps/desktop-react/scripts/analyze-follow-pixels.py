"""Measure fixed-label pixel movement in probe-follow-recorded DPR=2 captures.

python3 scripts/analyze-follow-pixels.py ../../output/follow-aba/recorded-pixels-A/pixels
Requires Pillow and numpy. The ROI excludes the changing duration digits.
This measures captured device pixels, not every display frame or CSS layout.
"""

import argparse
import json
from collections import Counter
from pathlib import Path

import numpy as np
from PIL import Image


def analyze(directory):
    metadata = json.loads((directory / "index.json").read_text())
    samples = metadata["samples"]
    if not samples:
        raise ValueError("No captured frames")
    crops = []
    for sample in samples:
        with Image.open(directory / sample["file"]) as image:
            if image.size != (360, 180):
                raise ValueError("Expected 180x90 CSS clip at DPR=2")
            crop = np.asarray(image.convert("L"), dtype=float)[98:145, :116]
            if np.ptp(crop) < 10:
                raise ValueError("Label ROI is blank or too low contrast")
            crops.append(crop)
    reference = crops[0]
    shifts = list(range(-2, 3))
    fitted = []
    for sample, crop in zip(samples, crops):
        # Trim both edges so np.roll wrapping cannot enter the comparison.
        losses = [float(np.mean((np.roll(reference, shift, axis=0)[3:-3] - crop[3:-3]) ** 2))
                  for shift in shifts]
        best = int(np.argmin(losses))
        fitted.append({"file": sample["file"], "timeBeforeMs": sample["before"]["sourceTime"],
                       "timeAfterMs": sample["after"]["sourceTime"],
                       "devicePixelShift": shifts[best], "mseAfterShift": losses[best]})
    switches = [{"from": previous["file"], **current}
                for previous, current in zip(fitted, fitted[1:])
                if previous["devicePixelShift"] != current["devicePixelShift"]]
    ranges = {}
    for field in ("top", "spanTop", "glyphBoxTop"):
        values = [sample[phase][field] for sample in samples for phase in ("before", "after")
                  if field in sample[phase]]
        if values:
            ranges[field] = {"min": min(values), "max": max(values), "observations": len(values)}
    return {"directory": str(directory.resolve()), "frames": len(samples),
            "roiDevicePixels": {"left": 0, "top": 98, "right": 116, "bottom": 145},
            "shiftCounts": dict(Counter(frame["devicePixelShift"] for frame in fitted)),
            "switchCount": len(switches), "maxMseAfterShift": max(frame["mseAfterShift"] for frame in fitted),
            "exactMatchesAfterShift": sum(frame["mseAfterShift"] == 0 for frame in fitted),
            "domCoordinateRangesCssPixels": ranges, "switches": switches, "samples": fitted}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directories", nargs="+", type=Path)
    parser.add_argument("--output", type=Path, help="Save detailed measurements as JSON")
    parser.add_argument("--expect-stable", action="store_true", help="Fail if the fixed label moves or its pixels change")
    args = parser.parse_args()
    results = [analyze(directory) for directory in args.directories]
    if args.output:
        args.output.write_text(json.dumps(results, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps([{key: value for key, value in result.items() if key not in ("samples", "switches")}
                      for result in results], ensure_ascii=False, indent=2))
    if args.expect_stable and any(result["switchCount"] or result["maxMseAfterShift"] for result in results):
        raise SystemExit("Pixel stability regression: the fixed label moved or changed")
