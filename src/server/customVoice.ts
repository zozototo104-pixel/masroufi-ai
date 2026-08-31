import { adminDb } from './firebaseAdmin';

const ELEVENLABS_API_BASE = 'https://api.elevenlabs.io/v1';
const FISH_AUDIO_API_BASE = 'https://api.fish.audio';
const SETTINGS_PATH = 'settings';
const CUSTOM_VOICE_DOC = 'customVoice';

export type CustomVoiceProvider = 'fish' | 'elevenlabs';

export type CustomVoiceProfile = {
  configured: boolean;
  voiceId?: string;
  provider?: CustomVoiceProvider;
  createdAt?: string;
  updatedAt?: string;
};

function selectedProvider(): CustomVoiceProvider {
  return process.env.CUSTOM_VOICE_PROVIDER?.trim().toLowerCase() === 'elevenlabs' ? 'elevenlabs' : 'fish';
}

function requireElevenLabsApiKey(): string {
  const key = process.env.ELEVENLABS_API_KEY?.trim();
  if (!key) throw new Error('ELEVENLABS_API_KEY is not configured');
  return key;
}

function requireFishApiKey(): string {
  const key = process.env.FISH_API_KEY?.trim();
  if (!key) throw new Error('FISH_API_KEY is not configured');
  return key;
}

function decodeAudio(base64: string): Uint8Array {
  const cleaned = String(base64 || '').replace(/^data:[^;]+;base64,/, '').trim();
  if (!cleaned) throw new Error('Missing audio sample');
  const buffer = Buffer.from(cleaned, 'base64');
  if (buffer.length < 16_000) throw new Error('Audio sample is too short');
  if (buffer.length > 9 * 1024 * 1024) throw new Error('Audio sample exceeds 9 MB limit');
  return new Uint8Array(buffer);
}

function profileRef(userId: string) {
  return adminDb.collection('users').doc(userId).collection(SETTINGS_PATH).doc(CUSTOM_VOICE_DOC);
}

export async function getCustomVoiceProfile(userId: string): Promise<CustomVoiceProfile> {
  const snap = await profileRef(userId).get();
  if (!snap.exists) return { configured: false };
  const data = snap.data() || {};
  return {
    configured: Boolean(data.voiceId),
    voiceId: data.voiceId || undefined,
    provider: data.provider === 'elevenlabs' ? 'elevenlabs' : undefined,
    createdAt: data.createdAt || undefined,
    updatedAt: data.updatedAt || undefined,
  };
}

export async function createCustomVoiceClone(args: {
  userId: string;
  audioBase64: string;
  mimeType?: string;
  consent: boolean;
}): Promise<CustomVoiceProfile> {
  if (args.consent !== true) throw new Error('VOICE_CONSENT_REQUIRED');
  const apiKey = requireApiKey();
  const bytes = decodeAudio(args.audioBase64);
  const mimeType = String(args.mimeType || 'audio/webm');
  const extension = mimeType.includes('mp4') ? 'm4a' : mimeType.includes('mpeg') ? 'mp3' : mimeType.includes('wav') ? 'wav' : 'webm';
  const existing = await getCustomVoiceProfile(args.userId);

  const form = new FormData();
  form.append('name', `Masroufi-${args.userId.slice(0, 8)}`);
  form.append('description', 'User-created personal voice for Masroufi AI');
  form.append('remove_background_noise', 'false');
  form.append('files', new Blob([bytes], { type: mimeType }), `voice-sample.${extension}`);

  const response = await fetch(`${ELEVENLABS_API_BASE}/voices/add`, {
    method: 'POST',
    headers: { 'xi-api-key': apiKey },
    body: form,
  });
  const payload: any = await response.json().catch(() => ({}));
  if (!response.ok || !payload.voice_id) {
    throw new Error(payload?.detail?.message || payload?.detail || payload?.message || `VOICE_CLONE_FAILED_${response.status}`);
  }

  const newVoiceId = String(payload.voice_id);
  const now = new Date().toISOString();
  try {
    await profileRef(args.userId).set({
      voiceId: newVoiceId,
      provider: 'elevenlabs',
      consentConfirmed: true,
      consentConfirmedAt: now,
      createdAt: existing.createdAt || now,
      updatedAt: now,
    }, { merge: true });
  } catch (err) {
    await deleteElevenLabsVoice(newVoiceId).catch(() => undefined);
    throw err;
  }

  if (existing.voiceId && existing.voiceId !== newVoiceId) {
    await deleteElevenLabsVoice(existing.voiceId).catch((err) => {
      console.warn('[custom-voice] failed to delete replaced voice', err);
    });
  }

  return { configured: true, voiceId: newVoiceId, provider: 'elevenlabs', createdAt: existing.createdAt || now, updatedAt: now };
}

async function deleteElevenLabsVoice(voiceId: string): Promise<void> {
  const apiKey = requireApiKey();
  const response = await fetch(`${ELEVENLABS_API_BASE}/voices/${encodeURIComponent(voiceId)}`, {
    method: 'DELETE',
    headers: { 'xi-api-key': apiKey },
  });
  if (!response.ok && response.status !== 404) {
    const payload: any = await response.json().catch(() => ({}));
    throw new Error(payload?.detail?.message || payload?.detail || payload?.message || `VOICE_DELETE_FAILED_${response.status}`);
  }
}

export async function deleteCustomVoice(userId: string): Promise<void> {
  const existing = await getCustomVoiceProfile(userId);
  if (existing.voiceId) await deleteElevenLabsVoice(existing.voiceId);
  await profileRef(userId).delete();
}

export async function getCustomVoiceId(userId: string): Promise<string | null> {
  const profile = await getCustomVoiceProfile(userId);
  return profile.voiceId || null;
}

export async function streamCustomVoiceAudio(args: {
  voiceId: string;
  text: string;
}): Promise<ArrayBuffer> {
  const apiKey = requireApiKey();
  const response = await fetch(`${ELEVENLABS_API_BASE}/text-to-speech/${encodeURIComponent(args.voiceId)}/stream?output_format=pcm_24000`, {
    method: 'POST',
    headers: {
      'xi-api-key': apiKey,
      'Content-Type': 'application/json',
      'Accept': 'audio/pcm',
    },
    body: JSON.stringify({
      text: args.text,
      model_id: process.env.ELEVENLABS_MODEL_ID?.trim() || 'eleven_flash_v2_5',
      voice_settings: {
        stability: 0.45,
        similarity_boost: 0.9,
        use_speaker_boost: true,
      },
    }),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`CUSTOM_VOICE_TTS_FAILED_${response.status}${body ? `: ${body.slice(0, 300)}` : ''}`);
  }
  return response.arrayBuffer();
}
