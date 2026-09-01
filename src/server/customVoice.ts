import { adminDb } from './firebaseAdmin';

const ELEVENLABS_API_BASE = 'https://api.elevenlabs.io/v1';
const FISH_AUDIO_API_BASE = 'https://api.fish.audio';
const SETTINGS_PATH = 'settings';
const CUSTOM_VOICE_DOC = 'customVoice';

export type CustomVoiceProvider = 'moss' | 'fish' | 'elevenlabs';

export type CustomVoiceProfile = {
  configured: boolean;
  voiceId?: string;
  provider?: CustomVoiceProvider;
  createdAt?: string;
  updatedAt?: string;
};

function selectedProvider(): CustomVoiceProvider {
  const provider = process.env.CUSTOM_VOICE_PROVIDER?.trim().toLowerCase();
  if (provider === 'elevenlabs' || provider === 'fish') return provider;
  return 'moss';
}

function requireMossUrl(): string {
  const url = process.env.MOSS_TTS_URL?.trim().replace(/\/$/, '');
  if (!url) throw new Error('MOSS_TTS_URL is not configured');
  return url;
}

function voiceReferencePath(userId: string): string {
  return `private/custom-voices/${userId}/reference.webm`;
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

function requireFishTtsModel(): 's1' | 's2-pro' {
  const model = process.env.FISH_MODEL_ID?.trim();
  if (model === 's1' || model === 's2-pro') return model;
  if (model === 's2.1-pro-free') {
    throw new Error('FISH_FREE_MODEL_EXPIRED: انتهت صلاحية نموذج Fish المجاني. اختر FISH_MODEL_ID=s1 أو s2-pro بعد تفعيل رصيد API.');
  }
  throw new Error('FISH_MODEL_REQUIRED: اضبط FISH_MODEL_ID إلى s1 أو s2-pro. لا يتم اختيار نموذج مدفوع تلقائياً.');
}

function decodeAudio(base64: string): Uint8Array {
  const cleaned = String(base64 || '').replace(/^data:[^;]+;base64,/, '').trim();
  if (!cleaned) throw new Error('Missing audio sample');
  const buffer = Buffer.from(cleaned, 'base64');
  if (buffer.length < 16_000) throw new Error('Audio sample is too short');
  if (buffer.length > 6 * 1024 * 1024) throw new Error('Audio sample exceeds 6 MB limit');
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
    provider: data.provider === 'moss' || data.provider === 'fish' || data.provider === 'elevenlabs' ? data.provider : undefined,
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
  const provider = selectedProvider();
  const bytes = decodeAudio(args.audioBase64);
  const mimeType = String(args.mimeType || 'audio/webm');
  const extension = mimeType.includes('mp4') ? 'm4a' : mimeType.includes('mpeg') ? 'mp3' : mimeType.includes('wav') ? 'wav' : 'webm';
  const existing = await getCustomVoiceProfile(args.userId);
  const form = new FormData();

  if (provider === 'moss') {
    const referencePath = voiceReferencePath(args.userId);
    await adminStorageBucket.file(referencePath).save(Buffer.from(bytes), {
      resumable: false,
      metadata: {
        contentType: mimeType,
        cacheControl: 'private, no-store',
        metadata: { ownerUid: args.userId, purpose: 'custom-voice-reference' },
      },
    });
    const now = new Date().toISOString();
    await profileRef(args.userId).set({
      voiceId: referencePath,
      provider: 'moss',
      referenceMimeType: mimeType,
      consentConfirmed: true,
      consentConfirmedAt: now,
      createdAt: existing.createdAt || now,
      updatedAt: now,
    }, { merge: true });
    if (existing.voiceId && existing.provider && existing.provider !== 'moss') {
      await deleteProviderVoice(existing.provider, existing.voiceId).catch((err) => {
        console.warn('[custom-voice] failed to delete replaced provider voice', err);
      });
    }
    return { configured: true, voiceId: referencePath, provider: 'moss', createdAt: existing.createdAt || now, updatedAt: now };
  }

  let response: Response;
  if (provider === 'fish') {
    form.append('title', `Masroufi-${args.userId.slice(0, 8)}`);
    form.append('description', 'User-created personal voice for Masroufi AI');
    form.append('visibility', 'private');
    form.append('type', 'tts');
    form.append('train_mode', 'fast');
    form.append('enhance_audio_quality', 'true');
    form.append('voices', new Blob([bytes], { type: mimeType }), `voice-sample.${extension}`);
    response = await fetch(`${FISH_AUDIO_API_BASE}/model`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${requireFishApiKey()}` },
      body: form,
    });
  } else {
    form.append('name', `Masroufi-${args.userId.slice(0, 8)}`);
    form.append('description', 'User-created personal voice for Masroufi AI');
    form.append('remove_background_noise', 'false');
    form.append('files', new Blob([bytes], { type: mimeType }), `voice-sample.${extension}`);
    response = await fetch(`${ELEVENLABS_API_BASE}/voices/add`, {
      method: 'POST',
      headers: { 'xi-api-key': requireElevenLabsApiKey() },
      body: form,
    });
  }

  const payload: any = await response.json().catch(() => ({}));
  const newVoiceId = provider === 'fish' ? payload?._id : payload?.voice_id;
  if (!response.ok || !newVoiceId) {
    throw new Error(payload?.detail?.message || payload?.detail || payload?.message || `VOICE_CLONE_FAILED_${response.status}`);
  }

  const voiceId = String(newVoiceId);
  const now = new Date().toISOString();
  try {
    await profileRef(args.userId).set({
      voiceId,
      provider,
      consentConfirmed: true,
      consentConfirmedAt: now,
      createdAt: existing.createdAt || now,
      updatedAt: now,
    }, { merge: true });
  } catch (err) {
    await deleteProviderVoice(provider, voiceId).catch(() => undefined);
    throw err;
  }

  if (existing.voiceId && existing.voiceId !== voiceId && existing.provider) {
    await deleteProviderVoice(existing.provider, existing.voiceId).catch((err) => {
      console.warn('[custom-voice] failed to delete replaced voice', err);
    });
  }

  return { configured: true, voiceId, provider, createdAt: existing.createdAt || now, updatedAt: now };
}

async function deleteProviderVoice(provider: CustomVoiceProvider, voiceId: string): Promise<void> {
  if (provider === 'moss') {
    await adminStorageBucket.file(voiceId).delete({ ignoreNotFound: true });
    return;
  }
  const response = provider === 'fish'
    ? await fetch(`${FISH_AUDIO_API_BASE}/model/${encodeURIComponent(voiceId)}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${requireFishApiKey()}` },
      })
    : await fetch(`${ELEVENLABS_API_BASE}/voices/${encodeURIComponent(voiceId)}`, {
        method: 'DELETE',
        headers: { 'xi-api-key': requireElevenLabsApiKey() },
      });
  if (!response.ok && response.status !== 404) {
    const body = await response.text().catch(() => '');
    throw new Error(`VOICE_DELETE_FAILED_${response.status}${body ? `: ${body.slice(0, 300)}` : ''}`);
  }
}

export async function deleteCustomVoice(userId: string): Promise<void> {
  const existing = await getCustomVoiceProfile(userId);
  if (existing.voiceId && existing.provider) await deleteProviderVoice(existing.provider, existing.voiceId);
  await profileRef(userId).delete();
}

export async function getCustomVoiceId(userId: string): Promise<string | null> {
  const profile = await getCustomVoiceProfile(userId);
  return profile.voiceId || null;
}

export async function getCustomVoiceRuntime(userId: string): Promise<{ voiceId: string; provider: CustomVoiceProvider } | null> {
  const profile = await getCustomVoiceProfile(userId);
  if (!profile.voiceId || !profile.provider) return null;
  return { voiceId: profile.voiceId, provider: profile.provider };
}

export async function* streamCustomVoiceAudio(args: {
  voiceId: string;
  text: string;
  provider?: CustomVoiceProvider;
}): AsyncGenerator<Uint8Array> {
  const provider = args.provider || selectedProvider();
  let response: Response;
  if (provider === 'moss') {
    const [reference] = await adminStorageBucket.file(args.voiceId).download();
    const form = new FormData();
    form.append('text', args.text);
    form.append('reference_audio', new Blob([new Uint8Array(reference)], { type: 'audio/webm' }), 'reference.webm');
    form.append('format', 'pcm');
    form.append('sample_rate', '24000');
    response = await fetch(`${requireMossUrl()}/v1/tts`, { method: 'POST', body: form, headers: { Accept: 'audio/pcm' } });
  } else response = provider === 'fish'
    ? await fetch(`${FISH_AUDIO_API_BASE}/v1/tts`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${requireFishApiKey()}`,
          'Content-Type': 'application/json',
          Accept: 'audio/pcm',
          model: requireFishTtsModel(),
        },
        body: JSON.stringify({
          text: args.text,
          reference_id: args.voiceId,
          format: 'pcm',
          sample_rate: 24000,
          latency: 'balanced',
        }),
      })
    : await fetch(`${ELEVENLABS_API_BASE}/text-to-speech/${encodeURIComponent(args.voiceId)}/stream?output_format=pcm_24000`, {
        method: 'POST',
        headers: {
          'xi-api-key': requireElevenLabsApiKey(),
          'Content-Type': 'application/json',
          Accept: 'audio/pcm',
        },
        body: JSON.stringify({
          text: args.text,
          model_id: process.env.ELEVENLABS_MODEL_ID?.trim() || 'eleven_flash_v2_5',
          voice_settings: { stability: 0.45, similarity_boost: 0.9, use_speaker_boost: true },
        }),
      });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`CUSTOM_VOICE_TTS_FAILED_${response.status}${body ? `: ${body.slice(0, 300)}` : ''}`);
  }

  if (!response.body) {
    const all = new Uint8Array(await response.arrayBuffer());
    if (all.byteLength > 0) yield all;
    return;
  }

  // Stream provider PCM as it arrives instead of buffering the whole utterance.
  // PCM16 samples are two bytes, so keep an odd trailing byte for the next chunk.
  const reader = response.body.getReader();
  let carry: number | null = null;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;

      let chunk = value;
      if (carry !== null) {
        const merged = new Uint8Array(chunk.byteLength + 1);
        merged[0] = carry;
        merged.set(chunk, 1);
        chunk = merged;
        carry = null;
      }

      if (chunk.byteLength % 2 === 1) {
        carry = chunk[chunk.byteLength - 1];
        chunk = chunk.subarray(0, chunk.byteLength - 1);
      }
      if (chunk.byteLength > 0) yield chunk;
    }
  } finally {
    reader.releaseLock();
  }
}
