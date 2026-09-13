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

test('VOICE-03: Puck and Zephyr are the only selectable Live voices', async () => {
  const app = await src('src/App.tsx');
  assert.ok(app.includes("setVoice('Puck')"), 'Puck must remain selectable');
  assert.ok(app.includes("setVoice('Zephyr')"), 'Zephyr must remain selectable');
  assert.equal(app.includes("setVoice('Custom')"), false, 'personal voice must not enter the built-in Live voice selector');
});

test('VOICE-04: Gemini Live forwards native audio without personal-voice interception', async () => {
  const server = await src('server.ts');
  assert.ok(server.includes('for (const part of parts)') && server.includes('part?.inlineData?.data') && server.includes('safeSend({ audio });'), 'Gemini native audio from every Live response part must be forwarded directly');
  assert.equal(server.includes('modelTurn?.parts?.[0]?.inlineData?.data'), false, 'Live audio must not be dropped when Gemini places it in a non-first part');
  assert.equal(server.includes('outputAudioTranscription'), false, 'built-in Live voices must not request custom TTS transcription');
  assert.equal(server.includes('streamCustomVoiceAudio({'), false, 'personal TTS must stay out of the Gemini Live message path');
});

test('VOICE-05: interruption handling matches the original Gemini Live path', async () => {
  const server = await src('server.ts');
  const live = await src('src/lib/useGeminiLive.ts');
  assert.ok(server.includes('if (message.serverContent?.interrupted)'), 'server must relay Gemini interruption events');
  assert.ok(server.includes('safeSend({ interrupted: true })'), 'server must notify the client immediately on interruption');
  assert.ok(live.includes('stopPlayback();\n          setStatus(\'listening\');'), 'client must stop playback and return to listening on interruption');
});

test('VOICE-06: mobile barge-in resists speaker echo false positives', async () => {
  const live = await src('src/lib/useGeminiLive.ts');
  assert.ok(live.includes('rms > 0.08'), 'barge-in must use a higher speech threshold to avoid echo-triggered cuts');
  assert.ok(live.includes('userSpeechCounter >= 6'), 'barge-in must require sustained speech before interrupting playback');
  assert.ok(live.includes('processorSink.gain.value = 0'), 'microphone processing must be silent and avoid speaker monitoring feedback');
});

test('VOICE-07: websocket connect reads the latest selected voice', async () => {
  const live = await src('src/lib/useGeminiLive.ts');
  assert.ok(live.includes('const settingsRef = useRef(settings)'), 'live hook must retain current settings outside stale callbacks');
  assert.ok(live.includes('const currentSettings = settingsRef.current'), 'connect must read settings at invocation time');
  assert.ok(live.includes("params.append('voice', currentSettings.voice)"), 'websocket URL must use the currently selected voice');
  assert.equal(live.includes("params.append('voice', settings.voice)"), false, 'connect must not capture a stale voice value');
});

test('VOICE-08: dormant personal-voice management remains isolated from Live voice runtime', async () => {
  const server = await src('server.ts');
  assert.ok(server.includes('app.get("/api/custom-voice", authMiddleware'), 'dormant personal-voice data remains manageable behind auth');
  assert.equal(server.includes('getCustomVoiceRuntime'), false, 'Gemini Live runtime must not load personal voice state');
  assert.equal(server.includes('streamCustomVoiceAudio'), false, 'Gemini Live runtime must not call personal voice synthesis');
});

test('FIN-LIVE-01: duplicate in-flight Live write prefers a confirmed committed result', async () => {
  const server = await src('server.ts');
  assert.ok(server.includes("result?.success === false && (result?.inFlight || result?.retryable)"), 'Live duplicate retry/in-flight responses must be recognized');
  assert.ok(server.includes("committedResult?.cloudStorageConfirmed === true || committedResult?.durability === 'committed' || committedResult?.transactionId"), 'only a confirmed/committed prior write may replace the retry warning');
  assert.ok(server.includes('recoveredFromDuplicateInFlight: true'), 'the recovered response must be explicitly marked as deduplicated recovery');
});

test('TREASURER-01: risky expenses are stopped before ledger commit until user confirmation', async () => {
  const tools = await src('src/server/tools.ts');
  const treasurer = await src('src/server/treasurerEngine.ts');
  assert.ok(treasurer.includes('confirmationReasons'), 'risk engine must separate blocking confirmation reasons from soft warnings');
  assert.ok(tools.includes('TREASURER_CRITICAL_RISK'), 'add_transaction must expose a critical treasurer risk reason');
  assert.ok(tools.includes('أمين الصندوق يوقف العملية مؤقتاً قبل الحفظ'), 'risky expense must be stopped before the transaction object is committed');
  assert.ok(tools.includes('riskAssessment: risk'), 'the blocking response must include the numeric risk assessment for deterministic replies/UI');
});

test('TREASURER-02: debt purchases go through the same preflight risk gate', async () => {
  const tools = await src('src/server/tools.ts');
  assert.ok(tools.includes("if (type === 'expense' && !args.deferBalanceCheckToAtomicBatch)"), 'expense preflight must not exclude credit/debt purchases');
  assert.equal(tools.includes("if (type === 'expense' && !isCreditPurchase && !args.deferBalanceCheckToAtomicBatch)"), false, 'debt purchases must not bypass the treasurer preflight');
});

test('TREASURER-03: safe spending limit tool protects commitments, reserve, and goals', async () => {
  const tools = await src('src/server/tools.ts');
  assert.ok(tools.includes('export async function getSafeSpendingLimit'), 'safe spending advisor must be implemented as a server tool');
  assert.ok(tools.includes('get_safe_spending_limit: getSafeSpendingLimit'), 'safe spending advisor must be registered in tool handlers');
  assert.ok(tools.includes('name: "get_safe_spending_limit"'), 'safe spending advisor must be exposed to Gemini tool declarations');
  assert.ok(tools.includes('dueCommitments + reserveTarget + savingsRequiredThisPeriod'), 'safe limit must protect commitments, reserve, and active savings goals');
  assert.ok(tools.includes('getFinancialDecisionContext({}, userId, token)'), 'safe limit must reuse the unified financial decision context');
  assert.ok(tools.includes("collection('contributions')"), 'safe limit must subtract current-cycle savings contributions already made');
  assert.ok(tools.includes('safeSpendingMonthlyRequired'), 'safe limit must avoid over-reserving unscheduled savings goals');
  assert.ok(tools.includes('savingsContributionDocsRead'), 'safe limit must expose savings contribution read cost');
});

test('TREASURER-04: advisor pulse endpoint exposes the safe spending summary', async () => {
  const server = await src('server.ts');
  assert.ok(server.includes('app.get("/api/advisor/pulse", authMiddleware'), 'advisor pulse must be available behind auth');
  assert.ok(server.includes('getSafeSpendingLimit({ period: \'salary_cycle\''), 'advisor pulse must be based on salary-cycle safe spending by default');
  assert.ok(server.includes('safeToSpendToday'), 'advisor pulse must expose today safe spend');
  assert.ok(server.includes('safeToSpendUntilSalaryCycleEnd'), 'advisor pulse must expose horizon safe spend');
  assert.ok((server.match(/0\.3\.1- \*\*حد الصرف الآمن\*\*/g) || []).length >= 2, 'text and voice prompts must both instruct Gemini to use the safe spending tool');
});

test('TREASURER-05: dashboard renders and refreshes advisor pulse', async () => {
  const app = await src('src/App.tsx');
  assert.ok(app.includes('const [advisorPulse, setAdvisorPulse]'), 'dashboard must keep advisor pulse state');
  assert.ok(app.includes("fetch('/api/advisor/pulse'"), 'dashboard must fetch advisor pulse from the server');
  assert.ok(app.includes("idbSet('lkgs_advisor_pulse'"), 'dashboard must cache last-known-good advisor pulse');
  assert.ok(app.includes('نبض أمين الصندوق'), 'dashboard must render the treasurer pulse card');
  assert.ok(app.includes('safeToSpendUntilSalaryCycleEnd'), 'dashboard card must display horizon safe spending');
});

test('TREASURER-06: advisor alert center persists and resolves financial warnings', async () => {
  const tools = await src('src/server/tools.ts');
  const server = await src('server.ts');
  const app = await src('src/App.tsx');
  assert.ok(tools.includes('export async function getAdvisorAlerts'), 'advisor alert center must expose a read API');
  assert.ok(tools.includes('export async function updateAdvisorAlert'), 'advisor alert center must expose an update API');
  assert.ok(tools.includes('advisorAlert: true'), 'financial warnings must be persisted as advisor alerts');
  assert.ok(tools.includes('advisor-budget-critical'), 'budget limit breaches must become persistent advisor alerts');
  assert.ok(tools.includes('advisor-debt-risk'), 'high debt purchase risks must become persistent advisor alerts');
  assert.ok(tools.includes('Object.assign(duplicatePatch'), 'repeated advisor alerts must reopen after a new duplicate event');
  assert.ok(tools.includes('get_advisor_alerts: getAdvisorAlerts'), 'advisor alert read tool must be registered');
  assert.ok(tools.includes('update_advisor_alert: updateAdvisorAlert'), 'advisor alert update tool must be registered');
  assert.ok(tools.includes('name: "get_advisor_alerts"'), 'advisor alert read tool must be exposed to Gemini');
  assert.ok(server.includes('app.get("/api/advisor/alerts", authMiddleware'), 'advisor alert center must be available behind auth');
  assert.ok(server.includes('app.post("/api/advisor/alerts/:id", authMiddleware'), 'advisor alert actions must be available behind auth');
  assert.ok((server.match(/0\.3\.2- \*\*مركز تنبيهات الخبير\*\*/g) || []).length >= 2, 'text and voice prompts must both instruct Gemini to use the advisor alert center');
  assert.ok(app.includes('const [advisorAlerts, setAdvisorAlerts]'), 'dashboard must keep advisor alerts state');
  assert.ok(app.includes("fetch('/api/advisor/alerts?limit=25'"), 'dashboard must fetch advisor alerts');
  assert.ok(app.includes('مركز تنبيهات الخبير المالي'), 'dashboard must render the advisor alert center');
  assert.ok(app.includes('handleAdvisorAlertAction'), 'dashboard must allow resolving/dismissing/snoozing alerts');
});
