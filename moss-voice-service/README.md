# Masroufi MOSS Voice Service

Private adapter between Masroufi and a self-hosted OpenMOSS/MOSS-TTS-Nano instance.

## Contract

- `GET /health`
- `POST /v1/tts` multipart fields: `text`, `reference_audio`, `format=pcm`, `sample_rate=24000`
- Response: raw PCM16 mono at 24 kHz.

## Environment

- `MOSS_UPSTREAM_URL`: URL of the MOSS-TTS-Nano HTTP server.

Run adapter:

```bash
pip install -r requirements.txt
uvicorn app:app --host 0.0.0.0 --port ${PORT:-8080}
```

Masroufi server environment:

```text
CUSTOM_VOICE_PROVIDER=moss
MOSS_TTS_URL=https://<this-service-host>
```

The user's reference recording remains private in Firebase Storage. The adapter does not persist it.

The upstream MOSS-TTS-Nano process should be deployed from the official OpenMOSS/MOSS-TTS-Nano repository using its ONNX/CPU path where appropriate for the host. Keep this adapter and upstream on a private network when the platform supports it.
