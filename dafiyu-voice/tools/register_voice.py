"""Register (or update) a voice under ref/voices/<id>/ from a wav file.

Usage:
  python tools/register_voice.py <id> <name> <ref_wav> [--source TEXT] [--notes TEXT]
      [--created-at ISO] [--no-set-current]
"""
import argparse
import datetime
import json
import os
import shutil
import sys

ROOT = r"C:\dsh-qq\dafiyu-voice"
VOICES = os.path.join(ROOT, "ref", "voices")
ENGINE = "IndexTTS-2"


def wav_seconds(path):
    import soundfile as sf
    info = sf.info(path)
    return round(info.frames / float(info.samplerate), 2)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("vid")
    ap.add_argument("name")
    ap.add_argument("ref")
    ap.add_argument("--source", default="")
    ap.add_argument("--notes", default="")
    ap.add_argument("--created-at", default=None)
    ap.add_argument("--no-set-current", action="store_true")
    args = ap.parse_args()

    d = os.path.join(VOICES, args.vid)
    os.makedirs(d, exist_ok=True)
    dst = os.path.join(d, "ref.wav")
    if os.path.abspath(args.ref) != os.path.abspath(dst):
        shutil.copyfile(args.ref, dst)
    secs = wav_seconds(dst)
    meta = {
        "id": args.vid,
        "name": args.name,
        "source": args.source,
        "createdAt": args.created_at or datetime.datetime.now().astimezone().isoformat(timespec="seconds"),
        "notes": args.notes,
        "engine": ENGINE,
        "refSeconds": secs,
    }
    with open(os.path.join(d, "meta.json"), "w", encoding="utf-8") as f:
        json.dump(meta, f, ensure_ascii=False, indent=2)
    print(f"registered voice {args.vid!r} ({args.name}) {secs}s -> {d}")
    if not args.no_set_current:
        cur = os.path.join(VOICES, "current.json")
        with open(cur, "w", encoding="utf-8") as f:
            json.dump({"current": args.vid,
                       "updatedAt": datetime.datetime.now().astimezone().isoformat(timespec="seconds")},
                      f, ensure_ascii=False, indent=2)
        print(f"current voice -> {args.vid}")


if __name__ == "__main__":
    sys.exit(main())
