"""Find full-text-area blank frames in the manual recorded replay.

python3 scripts/analyze-manual-follow.py ../../output/follow-aba/<label>/manual-scroll --video
Requires Pillow/numpy, and ffmpeg for the optional local reproduction clip.
"""
import argparse
import bisect
import json
import subprocess
from pathlib import Path

import numpy as np
from PIL import Image


def analyze(directory, video=False, video_window=None):
    trace = json.loads((directory / "trace.json").read_text())
    frames, captures = trace["frames"], trace["captures"]
    epochs = [frame["epoch"] for frame in frames]
    origin = float(np.median([frame["epoch"] - frame["replay"] for frame in frames]))
    x, y = int(trace["viewport"]["left"]), int(trace["viewport"]["top"])
    blank = []
    for index, capture in enumerate(captures):
        with Image.open(directory / capture["file"]) as image:
            pixels = np.asarray(image.convert("L"), dtype=float)
        roi = pixels[max(0, y + 40):min(len(pixels), y + 590),
                     max(0, x + 30):min(pixels.shape[1], x + 850)]
        edge_fraction = float(np.mean(np.abs(np.diff(roi, axis=1)) > 12))
        if edge_fraction >= 0.0005:
            continue
        epoch = capture["timestamp"] * 1000
        at = min(bisect.bisect_left(epochs, epoch), len(frames) - 1)
        if at > 0 and epoch - epochs[at - 1] < epochs[at] - epoch:
            at -= 1
        frame = frames[at]
        blank.append({"index": index, "file": capture["file"],
                      "replayMs": epoch - origin, "edgeFraction": edge_fraction,
                      "nearestGeometryAgeMs": abs(frame["epoch"] - epoch),
                      "scrollTop": frame["st"], "scrollHeight": frame["sh"],
                      "domAnchors": frame["anchors"],
                      "streamState": {key: frame.get(key) for key in [
                          "status", "activeMessageId", "reasoningChars", "lastReasoningAt",
                          "lastStreamType", "thoughtChars", "thoughtVisible", "thoughtTop", "thoughtBottom"]}})
    result = {"directory": str(directory.resolve()), "captures": len(captures),
              "trustedWheels": sum(e.get("trusted", False) for e in trace["events"] if e["type"] == "wheel"),
              "blankFrames": len(blank), "blank": blank,
              "criterion": "Chat text ROI has <0.05% horizontal edges above 12 gray levels; inspect candidate images before concluding."}
    (directory / "analysis.json").write_text(json.dumps(result, indent=2) + "\n")
    if video and (blank or video_window):
        # Actual capture intervals are retained; no fabricated intermediate content.
        first = video_window[0] * 1000 if video_window else blank[0]["replayMs"] - 1500
        last = video_window[1] * 1000 if video_window else blank[-1]["replayMs"] + 1500
        selected = [capture for capture in captures
                    if first <= capture["timestamp"] * 1000 - origin <= last]
        lines = []
        for index, capture in enumerate(selected):
            lines.append("file '" + capture["file"] + "'")
            duration = (selected[index + 1]["timestamp"] - capture["timestamp"]) if index + 1 < len(selected) else 1 / 30
            lines.append(f"duration {max(duration, 0.001):.6f}")
        lines.append("file '" + selected[-1]["file"] + "'")
        listing = directory / "reproduction.concat.txt"
        listing.write_text("\n".join(lines) + "\n")
        subprocess.run(["/opt/homebrew/bin/ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
                        "-f", "concat", "-safe", "0", "-i", str(listing),
                        "-vf", "fps=60", "-c:v", "libx264", "-crf", "18",
                        "-pix_fmt", "yuv420p", str(directory / "reproduction.mp4")], check=True)
        result["video"] = str(directory / "reproduction.mp4")
    return {key: value for key, value in result.items() if key != "blank"}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directories", nargs="+", type=Path)
    parser.add_argument("--video", action="store_true")
    parser.add_argument("--video-window", type=float, nargs=2, metavar=("START_SECONDS", "END_SECONDS"))
    args = parser.parse_args()
    print(json.dumps([analyze(directory, args.video, args.video_window) for directory in args.directories], indent=2))
