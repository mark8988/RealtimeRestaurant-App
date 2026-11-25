"""Loopback adapter for faster-whisper and ElevenLabs Text to Dialogue."""

import asyncio
import base64
import io
import json
import logging
import os
from pathlib import Path
import re
import sys
import threading
import unicodedata
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


LOG = logging.getLogger("restaurant.voice")
MAX_WAVE_BYTES = 2 * 1024 * 1024
MAX_SPEECH_BYTES = 24000 * 2 * 180
SUBTITLES = ("謝謝觀看", "感謝收看", "謝謝收看", "字幕由", "字幕提供", "中文字幕",
             "amaraorg", "請不吝點贊", "訂閱轉發", "明鏡與點點")
ELEVEN_URL = ("wss://api.elevenlabs.io/v1/text-to-dialogue/stream-input"
              "?model_id=eleven_v4_turbo&output_format=pcm_24000")


def usable_text(text):
    remainder = re.sub(r"[\[（(【].*?[\]）)】]", "", text)
    normalized = "".join(c.lower() for c in remainder if c.isalnum()
                         or unicodedata.category(c).startswith("M"))
    matched = sum(len(phrase) for phrase in SUBTITLES if phrase in normalized)
    return bool(normalized) and matched < len(normalized) / 2


def read_pcm(payload):
    try:
        with wave.open(io.BytesIO(payload)) as source:
            if (source.getnchannels(), source.getsampwidth(), source.getframerate()) != (1, 2, 16000):
                raise ValueError("Expected mono PCM16 at 16 kHz")
            frames = source.getnframes()
            if frames > 60 * 16000:
                raise ValueError("Expected at most 60 seconds")
            pcm = source.readframes(frames)
            if len(pcm) != frames * 2:
                raise ValueError("Truncated WAV")
            return pcm
    except (wave.Error, EOFError) as exc:
        raise ValueError("Invalid WAV") from exc


class Transcriber:
    def __init__(self):
        self.dll_handles = []
        if sys.platform == "win32":
            for directory in Path(sys.prefix, "Lib", "site-packages", "nvidia").glob("*/bin"):
                self.dll_handles.append(os.add_dll_directory(str(directory)))
                os.environ["PATH"] = f"{directory}{os.pathsep}{os.environ['PATH']}"
        import numpy as np
        from faster_whisper import WhisperModel
        from opencc import OpenCC

        self.np = np
        self.model = WhisperModel(os.getenv("WHISPER_MODEL", "large-v3-turbo"),
                                  device=os.getenv("WHISPER_DEVICE", "cuda"),
                                  compute_type=os.getenv("WHISPER_COMPUTE_TYPE", "float16"))
        self.converter = OpenCC("s2twp")
        self.lock = threading.Lock()
        self._decode(np.zeros(16000, dtype=np.float32))

    def _decode(self, samples):
        segments, _ = self.model.transcribe(samples, language="zh", beam_size=1, vad_filter=False)
        return "".join(segment.text for segment in segments).strip()

    def transcribe(self, pcm):
        if len(pcm) < 3200 or not any(pcm):
            return ""
        samples = self.np.frombuffer(pcm, dtype="<i2").astype(self.np.float32) / 32768
        with self.lock:
            result = self.converter.convert(self._decode(samples))
        return result if usable_text(result) else ""


async def synthesize(text, voice, api_key, connect=None):
    if connect is None:
        from websockets.asyncio.client import connect
    audio = bytearray()
    async with connect(ELEVEN_URL, additional_headers={"xi-api-key": api_key},
                       open_timeout=5, close_timeout=2) as socket:
        await socket.send(json.dumps({"voices": [voice]}))
        await socket.send(json.dumps({"inputs": [{"text": text, "voice_id": voice, "new_turn": True}]}))
        await socket.send(json.dumps({"flush": True}))
        while True:
            message = json.loads(await asyncio.wait_for(socket.recv(), 5))
            if message.get("error"):
                raise RuntimeError("ElevenLabs synthesis failed")
            if message.get("audio"):
                audio.extend(base64.b64decode(message["audio"], validate=True))
                if len(audio) > MAX_SPEECH_BYTES:
                    raise RuntimeError("TTS audio exceeds limit")
            if message.get("is_final_audio_for_turn"):
                break
    if not audio or len(audio) % 2:
        raise RuntimeError("Invalid PCM from ElevenLabs")
    destination = io.BytesIO()
    with wave.open(destination, "wb") as sink:
        sink.setnchannels(1)
        sink.setsampwidth(2)
        sink.setframerate(24000)
        sink.writeframes(audio)
    return destination.getvalue()


class VoiceHandler(BaseHTTPRequestHandler):
    def do_POST(self):
        if self.path not in ("/transcribe", "/synthesize"):
            self.send_error(404)
            return
        try:
            size = int(self.headers.get("Content-Length", -1))
            limit = MAX_WAVE_BYTES if self.path == "/transcribe" else 128 * 1024
            if not 0 < size <= limit:
                raise ValueError("Invalid body size")
            body = self.rfile.read(size)
            if self.path == "/transcribe":
                pcm = read_pcm(body)
            else:
                data = json.loads(body)
                if not isinstance(data, dict) or data.get("role") not in ("chef", "host"):
                    raise ValueError("Invalid role")
                text = data.get("text")
                if not isinstance(text, str) or not text.strip():
                    raise ValueError("Expected reply text")
        except (ValueError, UnicodeError):
            self.send_error(400, "Invalid voice request")
            return
        try:
            if self.path == "/transcribe":
                payload = json.dumps({"text": self.server.transcriber.transcribe(pcm)}).encode()
                mime = "application/json"
            else:
                name = "TTS_VOICE_" + data["role"].upper()
                key = os.getenv("ELEVENLABS_API_KEY")
                voice = os.getenv(name)
                if not key or not voice:
                    LOG.error("Set ELEVENLABS_API_KEY and %s for speech synthesis", name)
                    self.send_error(503, "Missing TTS configuration")
                    return
                payload = asyncio.run(asyncio.wait_for(synthesize(text, voice, key), timeout=60))
                mime = "audio/wav"
        except Exception as exc:
            LOG.error("%s provider failure (%s)", self.path, type(exc).__name__)
            self.send_error(502, "Voice provider failed")
            return
        self.send_response(200)
        self.send_header("Content-Type", mime)
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    engine = Transcriber()
    with ThreadingHTTPServer(("127.0.0.1", int(os.getenv("VOICE_SERVICE_PORT", "8091"))), VoiceHandler) as server:
        server.transcriber = engine
        LOG.info("Listening on http://127.0.0.1:%d", server.server_port)
        server.serve_forever()
