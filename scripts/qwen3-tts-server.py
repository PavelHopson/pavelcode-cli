"""Bounded loopback-only Qwen3-TTS adapter for Eclipse Ultron.

The adapter accepts short text only, keeps audio in memory, never logs a
transcript, and exposes no model/path controls to the renderer.
"""

from __future__ import annotations

import io
import json
import os
import threading
import time
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Final

import soundfile as sf
import torch
from qwen_tts import Qwen3TTSModel


HOST: Final = "127.0.0.1"
PORT: Final = 17862
MAX_BODY_BYTES: Final = 8 * 1024
MAX_TEXT_CHARS: Final = 400
ALLOWED_ORIGINS: Final = {"null", "http://localhost:3939", "http://127.0.0.1:3939"}
MODEL_NAME: Final = "Qwen3-TTS-12Hz-0.6B-CustomVoice"
SPEAKER: Final = "Uncle_Fu"
# qwen-tts 0.1.1 ignores `instruct` for the 0.6B CustomVoice checkpoint.
# Keep this lab adapter honest and rely on the selected built-in speaker only.

_generation_lock = threading.Lock()


def _model_directory() -> Path:
    configured = os.environ.get("ECLIPSE_QWEN_TTS_MODEL_DIR", "").strip()
    if not configured:
        raise RuntimeError("ECLIPSE_QWEN_TTS_MODEL_DIR is required")
    path = Path(configured).resolve()
    if path.name != MODEL_NAME or not path.is_dir():
        raise RuntimeError("Qwen3-TTS model directory is missing or invalid")
    return path


def _load_model() -> Qwen3TTSModel:
    model_directory = _model_directory()
    dtype = torch.bfloat16 if torch.cuda.is_available() else torch.float32
    device_map = "cuda:0" if torch.cuda.is_available() else "cpu"
    return Qwen3TTSModel.from_pretrained(
        str(model_directory),
        device_map=device_map,
        dtype=dtype,
        attn_implementation="sdpa",
    )


MODEL = _load_model()


class UltronTTSHandler(BaseHTTPRequestHandler):
    server_version = "EclipseUltronTTS/1"
    sys_version = ""

    def log_message(self, _format: str, *_args: object) -> None:
        # Do not leak transcripts, paths, request payloads, or local metadata.
        return

    def _origin(self) -> str:
        return self.headers.get("Origin", "")

    def _origin_allowed(self) -> bool:
        origin = self._origin()
        return not origin or origin in ALLOWED_ORIGINS

    def _headers(self, status: HTTPStatus, content_type: str, length: int = 0) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(length))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        origin = self._origin()
        if origin in ALLOWED_ORIGINS:
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
        self.end_headers()

    def _json_error(self, status: HTTPStatus, code: str) -> None:
        payload = json.dumps({"ok": False, "code": code}, separators=(",", ":")).encode("utf-8")
        self._headers(status, "application/json; charset=utf-8", len(payload))
        self.wfile.write(payload)

    def do_OPTIONS(self) -> None:
        if not self._origin_allowed():
            self._json_error(HTTPStatus.FORBIDDEN, "ORIGIN_REJECTED")
            return
        self.send_response(HTTPStatus.NO_CONTENT)
        origin = self._origin()
        if origin in ALLOWED_ORIGINS:
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Max-Age", "600")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self) -> None:
        if not self._origin_allowed():
            self._json_error(HTTPStatus.FORBIDDEN, "ORIGIN_REJECTED")
            return
        if self.path != "/health":
            self._json_error(HTTPStatus.NOT_FOUND, "NOT_FOUND")
            return
        payload = b'{"ok":true,"engine":"qwen3-tts-0.6b","storage":"memory-only"}'
        self._headers(HTTPStatus.OK, "application/json; charset=utf-8", len(payload))
        self.wfile.write(payload)

    def do_POST(self) -> None:
        if not self._origin_allowed():
            self._json_error(HTTPStatus.FORBIDDEN, "ORIGIN_REJECTED")
            return
        if self.path != "/synthesize":
            self._json_error(HTTPStatus.NOT_FOUND, "NOT_FOUND")
            return
        if self.headers.get_content_type() != "application/json":
            self._json_error(HTTPStatus.UNSUPPORTED_MEDIA_TYPE, "JSON_REQUIRED")
            return
        try:
            content_length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            content_length = 0
        if content_length <= 0 or content_length > MAX_BODY_BYTES:
            self._json_error(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, "BODY_LIMIT")
            return
        try:
            payload = json.loads(self.rfile.read(content_length).decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            self._json_error(HTTPStatus.BAD_REQUEST, "INVALID_JSON")
            return
        text = payload.get("text", "") if isinstance(payload, dict) else ""
        if not isinstance(text, str):
            self._json_error(HTTPStatus.BAD_REQUEST, "TEXT_REQUIRED")
            return
        text = " ".join(text.split()).strip()
        if not text or len(text) > MAX_TEXT_CHARS:
            self._json_error(HTTPStatus.BAD_REQUEST, "TEXT_LIMIT")
            return
        if not _generation_lock.acquire(blocking=False):
            self._json_error(HTTPStatus.CONFLICT, "TTS_BUSY")
            return

        started_at = time.monotonic()
        try:
            waveforms, sample_rate = MODEL.generate_custom_voice(
                text=text,
                language="Russian",
                speaker=SPEAKER,
            )
            output = io.BytesIO()
            sf.write(output, waveforms[0], sample_rate, format="WAV", subtype="PCM_16")
            audio = output.getvalue()
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", "audio/wav")
            self.send_header("Content-Length", str(len(audio)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Server-Timing", f'tts;dur={(time.monotonic() - started_at) * 1000:.0f}')
            origin = self._origin()
            if origin in ALLOWED_ORIGINS:
                self.send_header("Access-Control-Allow-Origin", origin)
                self.send_header("Vary", "Origin")
            self.end_headers()
            self.wfile.write(audio)
        except Exception:
            self._json_error(HTTPStatus.INTERNAL_SERVER_ERROR, "SYNTHESIS_FAILED")
        finally:
            _generation_lock.release()


class UltronTTSServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True


if __name__ == "__main__":
    server = UltronTTSServer((HOST, PORT), UltronTTSHandler)
    try:
        server.serve_forever(poll_interval=0.25)
    finally:
        server.server_close()
