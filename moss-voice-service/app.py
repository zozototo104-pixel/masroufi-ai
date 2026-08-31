from fastapi import FastAPI, UploadFile, File, Form, HTTPException
from fastapi.responses import Response
import httpx
import os

app = FastAPI(title="Masroufi MOSS Voice Service")
MOSS_UPSTREAM_URL = os.environ.get("MOSS_UPSTREAM_URL", "http://127.0.0.1:7860").rstrip("/")

@app.get("/health")
async def health():
    return {"ok": True, "provider": "moss-tts-nano"}

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

    # MOSS-TTS-Nano exposes a streaming generation endpoint. This adapter keeps
    # Masroufi's Node server independent from upstream request/response details.
    files = {"prompt_audio": (reference_audio.filename or "reference.webm", reference, reference_audio.content_type or "audio/webm")}
    data = {"text": text, "stream": "true", "output_format": "pcm", "sample_rate": "24000"}
    async with httpx.AsyncClient(timeout=120.0) as client:
        response = await client.post(f"{MOSS_UPSTREAM_URL}/api/generate-stream", data=data, files=files)
    if response.status_code >= 400:
        raise HTTPException(status_code=502, detail=f"MOSS upstream failed: {response.text[:300]}")
    return Response(content=response.content, media_type="audio/pcm")
