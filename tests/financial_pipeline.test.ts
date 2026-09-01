import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

async function src(path: string) {
  return readFile(join(process.cwd(), path), 'utf8');
}

test('PIPE-01: financial writes must not pass through legacy /api/sync raw transaction doc.set', async () => {
  const tools = await src('src/server/tools.ts');
  assert.ok(tools.includes('transactions must sync through /api/command, not /api/sync'),
    'legacy sync must reject raw transaction writes and direct them to the canonical command path');
  assert.ok(tools.includes('dispatchFinancialCommand -> toolHandlers -> runIdempotent -> validation'),
    'financial sync guard must document the canonical validated mutation path');
  const transactionGuardStart = tools.indexOf('if (args.transactions && args.transactions.length > 0)');
  const reportsSyncStart = tools.indexOf('if (args.reports && args.reports.length > 0)', transactionGuardStart);
  const transactionSyncBlock = tools.slice(transactionGuardStart, reportsSyncStart);
  assert.ok(transactionGuardStart >= 0 && reportsSyncStart > transactionGuardStart,
    'transaction rejection block must remain distinct from allowed non-financial sync');
  assert.ok(!transactionSyncBlock.includes('await doc.set('),
    'raw transaction write must not execute inside the transaction sync block');
});

test('PIPE-02: all mutating financial tools are protected by runIdempotent wrapper', async () => {
  const tools = await src('src/server/tools.ts');
  const required = ['add_transaction', 'transfer_money', 'pay_debt', 'send_palpay_payment', 'delete_transaction', 'update_transaction'];
  for (const name of required) {
    assert.ok(tools.includes(`'${name}'`), `${name} must be listed in mutating tools`);
  }
  assert.ok(tools.includes('runIdempotent(userId, operationId'), 'tool wrapper must call runIdempotent');
});

test('PIPE-03: idempotency uses hashed Firestore doc ids and fails closed', async () => {
  const idem = await src('src/server/idempotency.ts');
  assert.ok(idem.includes("createHash('sha256')"), 'operationId must be hashed before Firestore doc id');
  assert.ok(idem.includes('MISSING_OPERATION_ID'), 'financial writes without operationId must be rejected');
  assert.ok(idem.includes('IDEMPOTENCY_LOCK_FAILED'), 'lock failure must fail closed');
  const transactionStart = idem.indexOf('adminDb.runTransaction');
  const transactionEnd = idem.indexOf("if (claim.action === 'return')", transactionStart);
  const claimTransaction = idem.slice(transactionStart, transactionEnd);
  assert.ok(!claimTransaction.includes('waitForCompletedResult('), 'must not await long polling inside Firestore transaction');
  assert.ok(idem.includes("if (claim.action === 'wait') return { kind: 'cache_hit', cachedResult: await waitForCompletedResult(ref) }"),
    'pending duplicates may wait only after the claim transaction has completed');
});

test('PIPE-04: notifications cannot turn a committed financial write into a failure', async () => {
  const tools = await src('src/server/tools.ts');
  assert.ok(tools.includes('financial commit remains valid'), 'notification failures must be swallowed after financial commit');
  assert.ok(tools.includes('transactionId: options.transactionId'), 'notifications must link to transactionId');
  assert.ok(tools.includes('operationId: options.operationId'), 'notifications must link to operationId');
});

test('PIPE-05: chat financial replies are deterministic from tool results, not model interpretation', async () => {
  const server = await src('server.ts');
  assert.ok(server.includes('buildDeterministicFinancialReply'), 'server must summarize financial tool outcome canonically');
  assert.ok(server.includes('the server response is canonical'), 'financial tool result must not be reinterpreted by the model');
});

test('PIPE-06: offline financial commands go through /api/command only', async () => {
  const app = await src('src/App.tsx');
  const queue = await src('src/lib/offlineQueue.ts');
  assert.ok(app.includes('enqueuePendingOp'), 'UI must enqueue offline financial commands');
  assert.ok(queue.includes("fetch('/api/command'"), 'offline queue must flush commands to /api/command');
  assert.ok(!app.includes('JSON.stringify({ transactions: unsyncedTx })'), 'UI must not sync raw transaction docs');
});

test('PIPE-07: income nature must be user-stated, not model-inferred from generated notes', async () => {
  const server = await src('server.ts');
  const tools = await src('src/server/tools.ts');
  assert.ok(server.includes('currentUserText: message'), 'current user message must be preserved in financial context');
  assert.ok(server.includes('userText: recentUserConversationText'), 'conversation-aware user text must be passed into tool validation');
  assert.ok(tools.includes('originalUserIncomeText'), 'income validation must inspect original user text');
  assert.ok(tools.includes('POSSIBLE_LOAN_NOT_INCOME'), 'possible loan must not be silently recorded as income');
});

test('VOICE-01: personal voice management endpoints are authenticated', async () => {
  const server = await src('server.ts');
  assert.ok(server.includes('app.get("/api/custom-voice", authMiddleware'), 'custom voice status must require auth');
  assert.ok(server.includes('app.post("/api/custom-voice", authMiddleware'), 'custom voice creation must require auth');
  assert.ok(server.includes('app.delete("/api/custom-voice", authMiddleware'), 'custom voice deletion must require auth');
});

test('VOICE-02: browser never receives custom voice provider API keys', async () => {
  const app = await src('src/App.tsx');
  const serverVoice = await src('src/server/customVoice.ts');
  assert.equal(app.includes('ELEVENLABS_API_KEY'), false, 'frontend must not reference ElevenLabs secret');
  assert.equal(app.includes('FISH_API_KEY'), false, 'frontend must not reference Fish Audio secret');
  assert.ok(serverVoice.includes('process.env.ELEVENLABS_API_KEY'), 'ElevenLabs secret must stay server-side');
  assert.ok(serverVoice.includes('process.env.FISH_API_KEY'), 'Fish Audio secret must stay server-side');
  assert.ok(serverVoice.includes("form.append('visibility', 'private')"), 'Fish Audio clones must be private');
  assert.ok(serverVoice.includes("'s2.1-pro-free'"), 'Fish Audio free TTS model must be configured');
});

test('VOICE-03: Puck and Zephyr remain available while Custom is additive', async () => {
  const app = await src('src/App.tsx');
  assert.ok(app.includes("setVoice('Puck')"), 'Puck must remain selectable');
  assert.ok(app.includes("setVoice('Zephyr')"), 'Zephyr must remain selectable');
  assert.ok(app.includes("setVoice('Custom')"), 'Custom must be an additional option');
});

test('VOICE-04: Custom suppresses Gemini native audio and uses cloned-voice synthesis', async () => {
  const server = await src('server.ts');
  assert.ok(server.includes('if (audio && !useCustomVoice)'), 'Gemini native audio must be suppressed only for Custom mode');
  assert.ok(server.includes('outputAudioTranscription'), 'Custom mode must request Gemini output transcription');
  assert.ok(server.includes('streamCustomVoiceAudio({'), 'Custom mode must synthesize through the stored personal voice');
  assert.ok(server.includes('voiceId: customVoiceId'), 'Custom synthesis must use the stored personal voice id');
});

test('VOICE-05: interruption invalidates late personal-voice audio', async () => {
  const server = await src('server.ts');
  assert.ok(server.includes('customVoiceGeneration++'), 'custom voice generation must be invalidated on interruption');
  assert.ok(server.includes('generation !== customVoiceGeneration || !isActive'), 'streaming TTS must stop relaying after interruption');
});

test('VOICE-06: personal voice TTS is streamed and mobile barge-in resists speaker echo', async () => {
  const server = await src('server.ts');
  const voice = await src('src/server/customVoice.ts');
  const live = await src('src/lib/useGeminiLive.ts');
  assert.ok(voice.includes('AsyncGenerator<Uint8Array>'), 'provider audio must be exposed as a stream');
  assert.ok(server.includes('for await (const pcmChunk of streamCustomVoiceAudio'), 'server must relay provider PCM incrementally');
  assert.ok(live.includes('rms > 0.07'), 'barge-in must reject low-level speaker echo');
  assert.ok(live.includes('userSpeechCounter >= 4'), 'barge-in must require sustained speech');
});

test('VOICE-07: websocket connect reads the latest selected voice', async () => {
  const live = await src('src/lib/useGeminiLive.ts');
  assert.ok(live.includes('const settingsRef = useRef(settings)'), 'live hook must retain current settings outside stale callbacks');
  assert.ok(live.includes('const currentSettings = settingsRef.current'), 'connect must read settings at invocation time');
  assert.ok(live.includes("params.append('voice', currentSettings.voice)"), 'websocket URL must use the currently selected voice');
  assert.equal(live.includes("params.append('voice', settings.voice)"), false, 'connect must not capture a stale voice value');
});

test('VOICE-08: MOSS custom voices stay on the free Firestore path and preserve provider identity', async () => {
  const voice = await src('src/server/customVoice.ts');
  const server = await src('server.ts');
  assert.ok(voice.includes("return 'moss'"), 'self-hosted MOSS must be the default custom voice provider');
  assert.equal(voice.includes('adminStorageBucket'), false, 'MOSS must not require paid Firebase Storage');
  assert.ok(voice.includes('referenceAudioBase64'), 'MOSS reference audio must be persisted in the private Firestore voice profile');
  assert.ok(voice.includes('MOSS_FIRESTORE_AUDIO_MAX_BYTES'), 'Firestore reference audio must have a safe document-size limit');
  assert.ok(voice.includes('getCustomVoiceRuntime'), 'runtime must return voice id together with its provider and reference');
  assert.ok(server.includes('customVoiceRuntime?.provider'), 'live sessions must bind to the provider that created the voice');
  assert.ok(server.includes('customVoiceRuntime?.referenceAudioBase64'), 'live sessions must load the Firestore MOSS reference');
  assert.ok(voice.includes("`${requireMossUrl()}/v1/tts`"), 'MOSS synthesis must go through the isolated service');
});
