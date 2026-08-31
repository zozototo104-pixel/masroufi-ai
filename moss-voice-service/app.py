from fastapi import FastAPI, UploadFile, File, Form, HTTPException
from fastapi.responses import Response
import httpx
import os
import io
import wave
import base64
from array import array

app = FastAPI(title="Masroufi MOSS Voice Service")
MOSS_UPSTREAM_URL = os.environ.get("MOSS_UPSTREAM_URL", "http://127.0.0.1:18083").rstrip("/")

@app.get("/health")
async def health():
    return {"ok": True, "provider": "moss-tts-nano", "upstream": MOSS_UPSTREAM_URL}


def wav_to_pcm24k_mono(wav_bytes: bytes) -> bytes:
    with wave.open(io.BytesIO(wav_bytes), "rb") as wav:
        channels = wav.getnchannels()
        sample_width = wav.getsampwidth()
        sample_rate = wav.getframerate()
        frames = wav.readframes(wav.getnframes())

    if sample_width != 2:
        raise ValueError(f"Unsupported WAV sample width: {sample_width}")
    if channels not in (1, 2):
        raise ValueError(f"Unsupported WAV channel count: {channels}")
    if sample_rate not in (24000, 48000):
        raise ValueError(f"Unsupported WAV sample rate: {sample_rate}")

    samples = array("h")
    samples.frombytes(frames)

    if channels == 2:
        mono = array("h")
        for i in range(0, len(samples) - 1, 2):
            mixed = int((int(samples[i]) + int(samples[i + 1])) / 2)
            mono.append(max(-32768, min(32767, mixed)))
        samples = mono

    if sample_rate == 48000:
        samples = array("h", samples[::2])

    return samples.tobytes()


@app.post("/v1/tts")
async def tts(
    text: str = Form(...),
    reference_audio: UploadFile = File(...),
    format: str = Form("pcm"),
    sample_rate: int = Form(24000),
):
    if not text.strip():
        raise HTTPException(status_code=400, detail="text is required")
    if format != "pcm" or sample_rate != 24000:
        raise HTTPException(status_code=400, detail="only pcm/24000 is supported")

    reference = await reference_audio.read()
    if not reference:
        raise HTTPException(status_code=400, detail="reference audio is required")

    files = {
        "prompt_audio": (
            reference_audio.filename or "reference.webm",
            reference,
            reference_audio.content_type or "audio/webm",
        )
    }
    data = {
        "text": text,
        "max_new_frames": "375",
        "voice_clone_max_text_tokens": "75",
    }

    async with httpx.AsyncClient(timeout=180.0) as client:
        response = await client.post(f"{MOSS_UPSTREAM_URL}/api/generate", data=data, files=files)

    if response.status_code >= 400:
        raise HTTPException(status_code=502, detail=f"MOSS upstream failed: {response.text[:300]}")

    try:
        payload = response.json()
        encoded = payload.get("audio_base64")
        if not encoded:
            raise ValueError("missing audio_base64")
        wav_bytes = base64.b64decode(encoded)
        pcm = wav_to_pcm24k_mono(wav_bytes)
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Invalid MOSS audio response: {exc}") from exc

    return Response(content=pcm, media_type="audio/pcm")
