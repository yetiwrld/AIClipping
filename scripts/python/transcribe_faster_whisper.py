#!/usr/bin/env python3
"""
Clipwright Studio — local transcription via faster-whisper.

Contract:
  - Progress: JSON lines on stderr: {"progress": 0.42, "message": "..."}
  - Result:   one JSON document on stdout:
              {"language": "en", "segments": [{"start", "end", "text",
               "words": [{"word", "start", "end"}]}]}
  - Errors:   JSON on stdout {"error": {"code", "message"}} with non-zero exit.

The model is downloaded on first use to --model-dir (the app's models folder)
via huggingface_hub. Nothing else leaves the machine.
"""
import argparse
import json
import sys


def emit_progress(fraction, message=""):
    line = json.dumps({"progress": round(max(0.0, min(1.0, fraction)), 4), "message": message})
    sys.stderr.write(line + "\n")
    sys.stderr.flush()


def main():
    parser = argparse.ArgumentParser(description="Transcribe media with faster-whisper")
    parser.add_argument("--input", required=True, help="Path to the media file")
    parser.add_argument("--model", default="base", help="Model size: tiny/base/small/medium")
    parser.add_argument("--model-dir", default=None, help="Where to cache models")
    parser.add_argument("--device", default="cpu", help="cpu or cuda")
    parser.add_argument("--compute", default="int8", help="int8, int8_float16, float16, float32")
    parser.add_argument("--language", default=None, help="ISO language code or None for auto")
    args = parser.parse_args()

    def fail(code, message):
        sys.stdout.write(json.dumps({"error": {"code": code, "message": message}}))
        sys.exit(3)

    try:
        from faster_whisper import WhisperModel
    except ImportError:
        fail(
            "FASTER_WHISPER_NOT_INSTALLED",
            "The Python package 'faster-whisper' is not installed. "
            "Install it with: pip install faster-whisper",
        )

    try:
        emit_progress(0.0, f"Loading {args.model} model")
        model = WhisperModel(
            args.model,
            device=args.device,
            compute_type=args.compute,
            download_root=args.model_dir,
        )
    except Exception as exc:  # noqa: BLE001
        fail("MODEL_LOAD_FAILED", f"Could not load the model: {exc}")

    try:
        segments_iter, info = model.transcribe(
            args.input,
            word_timestamps=True,
            language=args.language if args.language and args.language != "auto" else None,
            vad_filter=True,
        )
    except Exception as exc:  # noqa: BLE001
        fail("TRANSCRIBE_FAILED", f"Transcription could not start: {exc}")

    total = float(info.duration or 0.0)
    out_segments = []
    for seg in segments_iter:
        words = []
        for w in seg.words or []:
            words.append({"word": w.word.strip(), "start": round(w.start, 3), "end": round(w.end, 3)})
        text = (seg.text or "").strip()
        if not text:
            continue
        out_segments.append(
            {
                "start": round(seg.start, 3),
                "end": round(seg.end, 3),
                "text": text,
                "words": words,
            }
        )
        if total > 0:
            emit_progress(seg.end / total, "Transcribing")

    result = {"language": getattr(info, "language", None), "segments": out_segments}
    sys.stdout.write(json.dumps(result))
    emit_progress(1.0, "Done")


if __name__ == "__main__":
    main()
