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
  assert.ok(tools.includes('parseBooleanLike(args?.includeResolved)'), 'advisor alert query booleans must not treat "false" strings as true');
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

test('TREASURER-07: comprehensive financial audit is exposed to advisor and dashboard', async () => {
  const tools = await src('src/server/tools.ts');
  const server = await src('server.ts');
  const app = await src('src/App.tsx');
  assert.ok(tools.includes('export async function runFinancialAudit'), 'comprehensive audit must be implemented as a server tool');
  assert.ok(tools.includes('run_financial_audit: runFinancialAudit'), 'comprehensive audit must be registered in tool handlers');
  assert.ok(tools.includes('name: "run_financial_audit"'), 'comprehensive audit must be exposed to Gemini');
  assert.ok(tools.includes('FULL_FINANCIAL_AUDIT_REQUIRES_CONFIRMATION'), 'full-history audit must require explicit confirmation');
  assert.ok(tools.includes('parseBooleanLike(args?.allowFullLedgerAudit)'), 'full-history audit confirmation must not treat "false" strings as true');
  assert.ok(tools.includes('advisorAudits'), 'saved audit results must be persisted under advisorAudits');
  assert.ok(tools.includes('category: `audit_${finding.category}`'), 'audit findings must be able to create persistent advisor alerts');
  assert.ok(server.includes('app.get("/api/advisor/audit", authMiddleware'), 'advisor audit summary must be available behind auth');
  assert.ok(server.includes('app.post("/api/advisor/audit", authMiddleware'), 'manual advisor audit run must be available behind auth');
  assert.ok((server.match(/0\.3\.3- \*\*المدقق المالي الشامل\*\*/g) || []).length >= 2, 'text and voice prompts must both instruct Gemini to use the comprehensive audit');
  assert.ok(app.includes('const [advisorAudit, setAdvisorAudit]'), 'dashboard must keep advisor audit state');
  assert.ok(app.includes("fetch('/api/advisor/audit?scope=salary_cycle&findingLimit=6'"), 'dashboard must fetch a bounded advisor audit');
  assert.ok(app.includes('handleRunAdvisorAudit'), 'dashboard must allow a saved manual audit run');
  assert.ok(app.includes('تدقيق الدفتر المالي'), 'dashboard must render the advisor audit card');
  assert.ok(app.includes("idbSet('lkgs_advisor_audit'"), 'dashboard must cache last-known-good advisor audit');
});

test('TREASURER-08: market watchlist links local market intelligence with safe spending', async () => {
  const tools = await src('src/server/tools.ts');
  const server = await src('server.ts');
  const app = await src('src/App.tsx');
  const rules = await src('firestore.rules');
  assert.ok(tools.includes('export async function createMarketWatchItem'), 'market watchlist must create monitored purchases');
  assert.ok(tools.includes('export async function getMarketWatchlist'), 'market watchlist must expose a read tool');
  assert.ok(tools.includes('export async function updateMarketWatchItem'), 'market watchlist must update and re-evaluate items');
  assert.ok(tools.includes('export async function reviewMarketWatchlist'), 'market watchlist must support bulk review');
  assert.ok(tools.includes('create_market_watch_item: createMarketWatchItem'), 'create market watch tool must be registered');
  assert.ok(tools.includes('review_market_watchlist: reviewMarketWatchlist'), 'review market watch tool must be registered');
  assert.ok(tools.includes('name: "create_market_watch_item"'), 'market watch tools must be exposed to Gemini');
  assert.ok(tools.includes('getSafeSpendingLimit({ period: \'salary_cycle\' }'), 'market watch evaluation must include safe spending context');
  assert.ok(tools.includes('advisor-market-watch'), 'risky market watch evaluations must become advisor alerts');
  assert.ok(tools.includes('marketWatchlist'), 'wipe must include the market watchlist collection');
  assert.ok(rules.includes('match /marketWatchlist/{watchId}'), 'Firestore rules must allow user-scoped market watchlist access');
  assert.ok(rules.includes('match /advisorAudits/{auditId}'), 'Firestore rules must allow user-scoped advisor audit snapshots');
  assert.ok(server.includes('app.get("/api/advisor/market-watchlist", authMiddleware'), 'market watchlist API must be available behind auth');
  assert.ok(server.includes('app.post("/api/advisor/market-watchlist/review", authMiddleware'), 'market watchlist review API must be available behind auth');
  assert.ok(server.indexOf('app.post("/api/advisor/market-watchlist/review"') < server.indexOf('app.post("/api/advisor/market-watchlist/:id"'), 'review route must be registered before the :id route');
  assert.ok(app.includes('const [marketWatchlist, setMarketWatchlist]'), 'dashboard must keep market watchlist state');
  assert.ok(app.includes("fetch('/api/advisor/market-watchlist?limit=12'"), 'dashboard must fetch market watchlist');
  assert.ok(app.includes('handleReviewMarketWatchlist'), 'dashboard must allow manual watchlist review');
  assert.ok(app.includes('مراقب السوق والمشتريات'), 'dashboard must render market watchlist card');
  assert.ok(app.includes("idbSet('lkgs_market_watchlist'"), 'dashboard must cache last-known-good market watchlist');
});

test('TREASURER-09: expanded treasurer profile drives advisor safety decisions and dashboard readiness', async () => {
  const tools = await src('src/server/tools.ts');
  const server = await src('server.ts');
  const app = await src('src/App.tsx');
  assert.ok(tools.includes('TREASURER_PROFILE_DEFAULTS'), 'expanded treasurer profile defaults must exist');
  assert.ok(tools.includes('buildTreasurerProfileCompleteness'), 'profile completeness scoring must exist');
  assert.ok(tools.includes('normalizeTreasurerProfile'), 'profile writes/reads must normalize user settings');
  assert.ok(tools.includes("raw?.priorities ?? profile.financialPriorities"), 'profile normalization must preserve legacy priorities');
  assert.ok(tools.includes('profileCompleteness = buildTreasurerProfileCompleteness(profile)'), 'safe spending must include profile completeness');
  assert.ok(tools.includes('parsePositiveFinancialAmount(profile.criticalLiquidityFloor)'), 'safe spending must protect critical liquidity floor');
  assert.ok(tools.includes('profileDailyLimit'), 'safe spending must respect daily spending limit');
  assert.ok(tools.includes('effectiveDebtLimit'), 'safe spending must evaluate configured debt limits');
  assert.ok(tools.includes('preflightTreasurerProfile = normalizeTreasurerProfile'), 'expense preflight must load the normalized treasurer profile');
  assert.ok(tools.includes('breaksProfileDebtLimit'), 'debt purchase preflight must respect profile debt limits');
  assert.ok(tools.includes('warningRatio = Math.max'), 'budget alerts must use configurable profile thresholds');
  assert.ok(tools.includes('salaryCycleStartDay'), 'Gemini update_treasurer_profile schema must expose salary cycle settings');
  assert.ok(tools.includes('restrictedCategories'), 'Gemini update_treasurer_profile schema must expose restricted categories');
  assert.ok(server.includes('app.get("/api/treasurer/profile", authMiddleware'), 'treasurer profile read API must be available behind auth');
  assert.ok(server.includes('app.post("/api/treasurer/profile", authMiddleware'), 'treasurer profile update API must be available behind auth');
  assert.ok((server.match(/0\.3\.4- \*\*ملف أمين الصندوق الشخصي\*\*/g) || []).length >= 2, 'text and voice prompts must both instruct Gemini to maintain the profile');
  assert.ok(app.includes('const [treasurerProfile, setTreasurerProfile]'), 'dashboard must keep treasurer profile state');
  assert.ok(app.includes("fetch('/api/treasurer/profile'"), 'dashboard must fetch the treasurer profile');
  assert.ok(app.includes("idbSet('lkgs_treasurer_profile'"), 'dashboard must cache last-known-good treasurer profile');
  assert.ok(app.includes('ملف أمين الصندوق'), 'dashboard must render treasurer profile readiness card');
});

test('TREASURER-10: goal impact engine protects financial goals before major spending', async () => {
  const tools = await src('src/server/tools.ts');
  const server = await src('server.ts');
  const app = await src('src/App.tsx');
  assert.ok(tools.includes('export async function assessFinancialGoalImpact'), 'goal impact assessment tool must exist');
  assert.ok(tools.includes('assess_financial_goal_impact: assessFinancialGoalImpact'), 'goal impact tool must be registered in handlers');
  assert.ok(tools.includes('name: "assess_financial_goal_impact"'), 'goal impact tool must be exposed to Gemini');
  assert.ok(tools.includes('estimateGoalDelayDays'), 'goal impact must estimate delay days');
  assert.ok(tools.includes('shouldEstimateGeneralGoalDelay'), 'goal impact must avoid overstating unmeasured general goal delays');
  assert.ok(tools.includes('GOAL_AT_RISK'), 'goal impact must produce a blocking goal-risk decision');
  assert.ok(tools.includes('FINANCIAL_GOAL_IMPACT_RISK'), 'add_transaction must stop goal-damaging expenses before commit');
  assert.ok(tools.includes('advisor-goal-impact-block'), 'blocked goal-impact expenses must become advisor alerts');
  assert.ok(tools.includes('goalImpact, confidence'), 'purchase assessment must include goal impact results');
  assert.ok(server.includes('app.post("/api/advisor/goal-impact", authMiddleware'), 'goal impact API must be available behind auth');
  assert.ok((server.match(/assess_financial_goal_impact/g) || []).length >= 2, 'text and voice prompts must instruct the advisor to assess goal impact');
  assert.ok(app.includes('أهداف تحتاج حماية'), 'dashboard pulse must highlight savings goals that need protection');
});

test('TREASURER-11: financial scenario simulator forecasts outcomes without recording transactions', async () => {
  const tools = await src('src/server/tools.ts');
  const server = await src('server.ts');
  const app = await src('src/App.tsx');
  const rules = await src('firestore.rules');
  assert.ok(tools.includes('export async function simulateFinancialScenario'), 'scenario simulator must exist');
  assert.ok(tools.includes('export async function getFinancialScenarios'), 'saved scenario reader must exist');
  assert.ok(tools.includes('simulate_financial_scenario: simulateFinancialScenario'), 'scenario simulator must be registered in handlers');
  assert.ok(tools.includes('get_financial_scenarios: getFinancialScenarios'), 'saved scenario reader must be registered in handlers');
  assert.ok(tools.includes('name: "simulate_financial_scenario"'), 'scenario simulator must be exposed to Gemini');
  assert.ok(tools.includes('buildScenarioRecoveryPlan'), 'scenario simulator must return a recovery plan');
  assert.ok(tools.includes('SCENARIO_CRITICAL'), 'scenario simulator must produce critical decisions');
  assert.ok(tools.includes('advisorScenarios'), 'saved scenarios must be persisted and included in wipe');
  assert.ok(tools.includes('advisor-scenario'), 'risky scenarios must become advisor alerts when requested');
  assert.ok(tools.includes("'simulate_financial_scenario'"), 'saved scenario simulations must be deduplicated as mutating tools');
  assert.ok(server.includes('app.post("/api/advisor/scenario", authMiddleware'), 'scenario simulation API must be available behind auth');
  assert.ok(server.includes('app.get("/api/advisor/scenarios", authMiddleware'), 'saved scenarios API must be available behind auth');
  assert.ok((server.match(/0\.3\.5- \*\*محاكاة السيناريوهات\*\*/g) || []).length >= 2, 'text and voice prompts must both instruct Gemini to simulate scenarios');
  assert.ok(app.includes('const [financialScenarios, setFinancialScenarios]'), 'dashboard must keep financial scenario state');
  assert.ok(app.includes("fetch('/api/advisor/scenarios?limit=8'"), 'dashboard must fetch saved financial scenarios');
  assert.ok(app.includes("fetch('/api/advisor/scenario'"), 'dashboard must run quick financial scenarios');
  assert.ok(app.includes('handleQuickScenarioSimulation'), 'dashboard must expose a quick scenario action');
  assert.ok(app.includes("fetch('/api/advisor/alerts?limit=25'"), 'quick scenario simulation must refresh advisor alerts after persisted risks');
  assert.ok(app.includes('محرك السيناريوهات المالية'), 'dashboard must render financial scenario card');
  assert.ok(app.includes("idbSet('lkgs_financial_scenarios'"), 'dashboard must cache last-known-good financial scenarios');
  assert.ok(rules.includes('match /advisorScenarios/{scenarioId}'), 'Firestore rules must allow user-scoped saved scenarios');
});

test('TREASURER-12: recurring commitment manager detects subscriptions and converts them safely', async () => {
  const tools = await src('src/server/tools.ts');
  const server = await src('server.ts');
  const app = await src('src/App.tsx');
  assert.ok(tools.includes('normalizeRecurringCommitmentFrequency'), 'recurring commitment frequency normalization must exist');
  assert.ok(tools.includes('buildRecurringCandidate'), 'recurring commitment candidate builder must exist');
  assert.ok(tools.includes('export async function detectRecurringCommitments'), 'recurring commitment detection tool must exist');
  assert.ok(tools.includes('export async function reviewRecurringCommitments'), 'recurring due-date review tool must exist');
  assert.ok(tools.includes('export async function createRecurringCommitmentFromCandidate'), 'recurring commitment conversion tool must exist');
  assert.ok(tools.includes('recurringDetectionKey'), 'converted commitments must carry recurrence detection metadata');
  assert.ok(tools.includes('const due = auditAsDate(c.dueDate)'), 'commitment enrichment must handle Firestore timestamp due dates');
  assert.ok(tools.includes('duplicate: true'), 'direct recurring conversion must avoid duplicate commitments');
  assert.ok(tools.includes('advisor-recurring-detected'), 'high-confidence recurring candidates must become advisor alerts when requested');
  assert.ok(tools.includes('advisor-recurring-due'), 'due or overdue recurring commitments must become advisor alerts when reviewed');
  assert.ok(tools.includes('category: \'recurring_commitments\''), 'comprehensive audit must flag untracked recurring commitments');
  assert.ok(tools.includes('detect_recurring_commitments: detectRecurringCommitments'), 'recurring detection must be registered in handlers');
  assert.ok(tools.includes('review_recurring_commitments: reviewRecurringCommitments'), 'recurring due-date review must be registered in handlers');
  assert.ok(tools.includes('create_recurring_commitment_from_candidate: createRecurringCommitmentFromCandidate'), 'recurring conversion must be registered in handlers');
  assert.ok(tools.includes('name: "detect_recurring_commitments"'), 'recurring detection must be exposed to Gemini');
  assert.ok(tools.includes('name: "review_recurring_commitments"'), 'recurring due-date review must be exposed to Gemini');
  assert.ok(tools.includes('name: "create_recurring_commitment_from_candidate"'), 'recurring conversion must be exposed to Gemini');
  assert.ok(server.includes('app.get("/api/commitments/recurring/detect", authMiddleware'), 'recurring detection API must be available behind auth');
  assert.ok(server.includes('app.post("/api/commitments/recurring/review", authMiddleware'), 'recurring due review API must be available behind auth');
  assert.ok(server.includes('app.post("/api/commitments/recurring/create", authMiddleware'), 'recurring conversion API must be available behind auth');
  assert.ok(server.indexOf('app.get("/api/commitments/recurring/detect"') < server.indexOf('app.delete("/api/commitments/:id"'), 'recurring routes must be registered before id routes');
  assert.ok((server.match(/0\.3\.6- \*\*مدير الاشتراكات والالتزامات المتكررة\*\*/g) || []).length >= 2, 'text and voice prompts must both instruct Gemini to manage recurring commitments');
  assert.ok(app.includes('const [recurringCommitmentCandidates, setRecurringCommitmentCandidates]'), 'dashboard must keep recurring candidate state');
  assert.ok(app.includes("fetch('/api/commitments/recurring/detect?candidateLimit=6&minOccurrences=2'"), 'dashboard must fetch bounded recurring candidates');
  assert.ok(app.includes('handleDetectRecurringCommitments'), 'dashboard must allow manual recurring detection');
  assert.ok(app.includes('handleCreateRecurringCommitment'), 'dashboard must allow converting a candidate to a recurring commitment');
  assert.ok(app.includes('مدير الاشتراكات والالتزامات'), 'dashboard must render recurring commitments manager card');
  assert.ok(app.includes("idbSet('lkgs_recurring_commitment_candidates'"), 'dashboard must cache last-known-good recurring candidates');
  assert.ok(app.includes('CalendarDays'), 'dashboard must import the recurring commitment icon it renders');
});

test('TREASURER-13: financial habit engine detects spending patterns and surfaces them to the advisor', async () => {
  const tools = await src('src/server/tools.ts');
  const server = await src('server.ts');
  const app = await src('src/App.tsx');
  const rules = await src('firestore.rules');
  assert.ok(tools.includes('export async function analyzeFinancialHabits'), 'financial habit analyzer must exist');
  assert.ok(tools.includes('export async function getFinancialHabitReports'), 'saved habit report reader must exist');
  assert.ok(tools.includes('summarizeHabitTransactions'), 'habit analyzer must summarize transaction buckets');
  assert.ok(tools.includes('buildFinancialHabitInsights'), 'habit analyzer must build pattern insights');
  assert.ok(tools.includes('category_spike'), 'habit analyzer must detect category spikes');
  assert.ok(tools.includes('merchant_spike'), 'habit analyzer must detect merchant spikes');
  assert.ok(tools.includes('small_purchase_accumulation'), 'habit analyzer must detect accumulated small purchases');
  assert.ok(tools.includes('day_risk'), 'habit analyzer must detect high-spend days');
  assert.ok(tools.includes('debt_usage_drift'), 'habit analyzer must detect debt usage drift');
  assert.ok(tools.includes('advisor-habit-pattern'), 'habit warnings must become advisor alerts when requested');
  assert.ok(tools.includes('advisorHabitReports'), 'saved habit reports must be persisted and included in wipe');
  assert.ok(tools.includes("category: 'habit_patterns'"), 'comprehensive audit must flag risky habit patterns');
  assert.ok(tools.includes('analyze_financial_habits: analyzeFinancialHabits'), 'habit analyzer must be registered in handlers');
  assert.ok(tools.includes('get_financial_habit_reports: getFinancialHabitReports'), 'habit report reader must be registered in handlers');
  assert.ok(tools.includes('name: "analyze_financial_habits"'), 'habit analyzer must be exposed to Gemini');
  assert.ok(tools.includes('name: "get_financial_habit_reports"'), 'habit report reader must be exposed to Gemini');
  assert.ok(server.includes('app.post("/api/advisor/habits", authMiddleware'), 'habit analysis API must be available behind auth');
  assert.ok(server.includes('app.get("/api/advisor/habits", authMiddleware'), 'habit report API must be available behind auth');
  assert.ok((server.match(/0\.3\.7- \*\*محرك العادات والأنماط المالية\*\*/g) || []).length >= 2, 'text and voice prompts must both instruct Gemini to analyze habits');
  assert.ok(app.includes('const [financialHabitReports, setFinancialHabitReports]'), 'dashboard must keep financial habit report state');
  assert.ok(app.includes("fetch('/api/advisor/habits?limit=8'"), 'dashboard must fetch saved habit reports');
  assert.ok(app.includes("fetch('/api/advisor/habits'"), 'dashboard must run habit analysis');
  assert.ok(app.includes('handleAnalyzeFinancialHabits'), 'dashboard must expose a manual habit analysis action');
  assert.ok(app.includes('محرك العادات والأنماط'), 'dashboard must render financial habits card');
  assert.ok(app.includes("idbSet('lkgs_financial_habit_reports'"), 'dashboard must cache last-known-good habit reports');
  assert.ok(rules.includes('match /advisorHabitReports/{reportId}'), 'Firestore rules must allow user-scoped habit reports');
});

test('TREASURER-14: weekly recommendation engine turns financial signals into an actionable plan', async () => {
  const tools = await src('src/server/tools.ts');
  const server = await src('server.ts');
  const app = await src('src/App.tsx');
  const rules = await src('firestore.rules');
  assert.ok(tools.includes('export async function generateWeeklyFinancialRecommendations'), 'weekly recommendation generator must exist');
  assert.ok(tools.includes('export async function getWeeklyFinancialRecommendations'), 'saved weekly plan reader must exist');
  assert.ok(tools.includes('buildWeeklyRecommendationMessage'), 'weekly plan must include a user-facing message builder');
  assert.ok(tools.includes('extractWeeklyActionBuckets'), 'weekly plan must bucket actions by stop/reduce/pay/save');
  assert.ok(tools.includes("type: 'stop'"), 'weekly plan must support stop recommendations');
  assert.ok(tools.includes("type: 'reduce'"), 'weekly plan must support reduce recommendations');
  assert.ok(tools.includes("type: 'pay_debt'"), 'weekly plan must support debt payment recommendations');
  assert.ok(tools.includes("type: 'save_goal'"), 'weekly plan must support goal transfer recommendations');
  assert.ok(tools.includes("type: 'pay_commitment'"), 'weekly plan must support commitment payment recommendations');
  assert.ok(tools.includes('advisorWeeklyPlans'), 'saved weekly plans must be persisted and included in wipe');
  assert.ok(tools.includes('advisor-weekly-plan'), 'risky weekly plans must become advisor alerts when requested');
  assert.ok(tools.includes('generate_weekly_financial_recommendations: generateWeeklyFinancialRecommendations'), 'weekly generator must be registered in handlers');
  assert.ok(tools.includes('get_weekly_financial_recommendations: getWeeklyFinancialRecommendations'), 'weekly plan reader must be registered in handlers');
  assert.ok(tools.includes('name: "generate_weekly_financial_recommendations"'), 'weekly generator must be exposed to Gemini');
  assert.ok(tools.includes('name: "get_weekly_financial_recommendations"'), 'weekly reader must be exposed to Gemini');
  assert.ok(server.includes('app.post("/api/advisor/weekly-plan", authMiddleware'), 'weekly plan generation API must be available behind auth');
  assert.ok(server.includes('app.get("/api/advisor/weekly-plan", authMiddleware'), 'weekly plan read API must be available behind auth');
  assert.ok((server.match(/0\.3\.8- \*\*خطة الأسبوع الذكية\*\*/g) || []).length >= 2, 'text and voice prompts must both instruct Gemini to generate weekly plans');
  assert.ok(app.includes('const [weeklyFinancialPlans, setWeeklyFinancialPlans]'), 'dashboard must keep weekly plan state');
  assert.ok(app.includes("fetch('/api/advisor/weekly-plan?limit=8'"), 'dashboard must fetch saved weekly plans');
  assert.ok(app.includes("fetch('/api/advisor/weekly-plan'"), 'dashboard must generate weekly plans');
  assert.ok(app.includes('handleGenerateWeeklyFinancialPlan'), 'dashboard must expose a manual weekly plan action');
  assert.ok(app.includes('خطة الأسبوع الذكية'), 'dashboard must render weekly plan card');
  assert.ok(app.includes("idbSet('lkgs_weekly_financial_plans'"), 'dashboard must cache last-known-good weekly plans');
  assert.ok(rules.includes('match /advisorWeeklyPlans/{planId}'), 'Firestore rules must allow user-scoped weekly plans');
});

test('TREASURER-15: adaptive budget engine proposes and applies smarter category limits safely', async () => {
  const tools = await src('src/server/tools.ts');
  const server = await src('server.ts');
  const app = await src('src/App.tsx');
  const rules = await src('firestore.rules');
  assert.ok(tools.includes('export async function generateAdaptiveBudgetPlan'), 'adaptive budget plan generator must exist');
  assert.ok(tools.includes('export async function getAdaptiveBudgetPlans'), 'adaptive budget plan reader must exist');
  assert.ok(tools.includes('export async function applyAdaptiveBudgetPlan'), 'adaptive budget plan applier must exist');
  assert.ok(tools.includes('normalizeAdaptiveBudgetMode'), 'adaptive budget modes must be normalized');
  assert.ok(tools.includes('adaptiveBudgetCategoryKind'), 'adaptive budgets must classify protected/essential/discretionary categories');
  assert.ok(tools.includes('monthlyCommitmentAmount'), 'adaptive budgets must account for recurring commitments monthly');
  assert.ok(tools.includes('roundBudgetLimit'), 'adaptive budget limits must be rounded to usable amounts');
  assert.ok(tools.includes('fitAdaptiveBudgetProposalsToIncomeEnvelope'), 'adaptive budgets must cap proposed totals to the real available income envelope');
  assert.ok(tools.includes('const incomeFitReference = referenceMonthlyIncome > 0 ? referenceMonthlyIncome : usingDefaultBudgetTemplate ? 1 : 0'), 'adaptive budgets must still cap the default template when income is missing');
  assert.ok(tools.includes("queryTransactions({ period: 'current_salary_cycle'"), 'adaptive budgets must infer income from the current salary cycle when the treasurer profile salary is missing');
  assert.ok(tools.includes('referenceMonthlyIncome'), 'adaptive budget output must expose the income used for the plan');
  assert.ok(tools.includes('usingDefaultBudgetTemplate'), 'adaptive budgets must detect the default 7300 ILS template instead of treating it as real income');
  assert.ok(tools.includes('DEFAULT_BUDGETS is only an') && tools.includes('it is not an active user budget'), 'budget overview must not treat the default 7300 ILS template as an active user budget');
  assert.ok(tools.includes('const userBudgets: Record<string, number> = {}'), 'stored budget reads must start from explicit user budgets, not the default template');
  assert.ok(tools.includes('initialBudgetSetup') && tools.includes('قالب ${defaultBudgetTemplateTotal} ₪ استخدم فقط كأوزان توزيع'), 'adaptive budget must present default template as distribution weights during first setup');
  assert.ok(tools.includes('لن أعتبر قالب 7300'), 'adaptive budget must not present the default 7300 ILS template as a valid recommendation when income is missing');
  assert.ok(tools.includes('needs_income_profile'), 'adaptive budget must ask for income setup when no reliable income exists');
  assert.ok(tools.includes('income_conflict'), 'adaptive budget must flag conflicts when obligations exceed income');
  assert.ok(tools.includes('incomeSource'), 'adaptive budget result must disclose whether income came from profile, salary cycle, or is missing');
  assert.ok(tools.includes('CONFIRM_ADAPTIVE_BUDGET_APPLY'), 'adaptive budget apply must require explicit confirmation');
  assert.ok(tools.includes('adminDb.batch()'), 'adaptive budget apply must write category limits atomically');
  assert.ok(tools.includes('adaptiveBudgetPlanId'), 'applied category budgets must retain the source plan id');
  assert.ok(tools.includes('advisorBudgetPlans'), 'adaptive budget plans must be persisted and included in wipe');
  assert.ok(tools.includes('advisor-adaptive-budget'), 'adaptive budget plans that need review must become advisor alerts');
  assert.ok(tools.includes('generate_adaptive_budget_plan: generateAdaptiveBudgetPlan'), 'adaptive budget generator must be registered in handlers');
  assert.ok(tools.includes('get_adaptive_budget_plans: getAdaptiveBudgetPlans'), 'adaptive budget reader must be registered in handlers');
  assert.ok(tools.includes('apply_adaptive_budget_plan: applyAdaptiveBudgetPlan'), 'adaptive budget applier must be registered in handlers');
  assert.ok(tools.includes("'apply_adaptive_budget_plan'"), 'adaptive budget application must be deduplicated as a mutating tool');
  assert.ok(tools.includes('name: "generate_adaptive_budget_plan"'), 'adaptive budget generator must be exposed to Gemini');
  assert.ok(tools.includes('name: "get_adaptive_budget_plans"'), 'adaptive budget reader must be exposed to Gemini');
  assert.ok(tools.includes('name: "apply_adaptive_budget_plan"'), 'adaptive budget applier must be exposed to Gemini');
  assert.ok(server.includes('app.post("/api/advisor/adaptive-budget", authMiddleware'), 'adaptive budget generation API must be available behind auth');
  assert.ok(server.includes('app.get("/api/advisor/adaptive-budget", authMiddleware'), 'adaptive budget plan read API must be available behind auth');
  assert.ok(server.includes('app.post("/api/advisor/adaptive-budget/apply", authMiddleware'), 'adaptive budget apply API must be available behind auth');
  assert.ok((server.match(/0\.3\.9- \*\*الميزانية المتكيّفة\*\*/g) || []).length >= 2, 'text and voice prompts must both instruct Gemini to use adaptive budgets');
  assert.ok(app.includes('const [adaptiveBudgetPlans, setAdaptiveBudgetPlans]'), 'dashboard must keep adaptive budget plan state');
  assert.ok(app.includes("fetch('/api/advisor/adaptive-budget?limit=8'"), 'dashboard must fetch saved adaptive budget plans');
  assert.ok(app.includes("fetch('/api/advisor/adaptive-budget'"), 'dashboard must generate adaptive budget plans');
  assert.ok(app.includes("fetch('/api/advisor/adaptive-budget/apply'"), 'dashboard must apply adaptive budget plans through the API');
  assert.ok(app.includes('handleGenerateAdaptiveBudgetPlan'), 'dashboard must expose adaptive budget generation action');
  assert.ok(app.includes('handleApplyAdaptiveBudgetPlan'), 'dashboard must expose adaptive budget application action');
  assert.ok(app.includes('الميزانية المتكيّفة'), 'dashboard must render adaptive budget card');
  assert.ok(app.includes("idbSet('lkgs_adaptive_budget_plans'"), 'dashboard must cache last-known-good adaptive budget plans');
  assert.ok(rules.includes('match /advisorBudgetPlans/{planId}'), 'Firestore rules must allow user-scoped adaptive budget plans');
});

test('TREASURER-16: month-end forecast engine predicts surplus pressure or deficit with corrections', async () => {
  const tools = await src('src/server/tools.ts');
  const server = await src('server.ts');
  const app = await src('src/App.tsx');
  const rules = await src('firestore.rules');
  assert.ok(tools.includes('export async function forecastMonthEndFinancialPosition'), 'month-end forecast tool must exist');
  assert.ok(tools.includes('export async function getMonthEndForecasts'), 'saved month-end forecast reader must exist');
  assert.ok(tools.includes('resolveMonthEndForecastWindow'), 'month-end forecast must resolve salary-cycle/calendar windows');
  assert.ok(tools.includes('normalizeMonthEndForecastStatus'), 'month-end forecast must classify status');
  assert.ok(tools.includes('buildMonthEndCorrectionPlan'), 'month-end forecast must return a correction plan');
  assert.ok(tools.includes('month_end_deficit'), 'month-end forecast must detect deficits');
  assert.ok(tools.includes('month_end_pressure'), 'month-end forecast must detect pressure');
  assert.ok(tools.includes('month_end_surplus'), 'month-end forecast must detect surplus');
  assert.ok(tools.includes('advisorMonthEndForecasts'), 'saved month-end forecasts must be persisted and included in wipe');
  assert.ok(tools.includes('advisor-month-end-forecast'), 'risky month-end forecasts must become advisor alerts when requested');
  assert.ok(tools.includes("category: 'month_end_forecast'"), 'comprehensive audit must flag risky month-end forecasts');
  assert.ok(tools.includes('forecast_month_end_financial_position: forecastMonthEndFinancialPosition'), 'month-end forecast must be registered in handlers');
  assert.ok(tools.includes('get_month_end_forecasts: getMonthEndForecasts'), 'month-end forecast reader must be registered in handlers');
  assert.ok(tools.includes('name: "forecast_month_end_financial_position"'), 'month-end forecast must be exposed to Gemini');
  assert.ok(tools.includes('name: "get_month_end_forecasts"'), 'month-end forecast reader must be exposed to Gemini');
  assert.ok(server.includes('app.post("/api/advisor/month-end-forecast", authMiddleware'), 'month-end forecast API must be available behind auth');
  assert.ok(server.includes('app.get("/api/advisor/month-end-forecast", authMiddleware'), 'month-end forecast read API must be available behind auth');
  assert.ok((server.match(/0\.3\.10- \*\*توقع نهاية الشهر\*\*/g) || []).length >= 2, 'text and voice prompts must both instruct Gemini to forecast month-end position');
  assert.ok(app.includes('const [monthEndForecasts, setMonthEndForecasts]'), 'dashboard must keep month-end forecast state');
  assert.ok(app.includes("fetch('/api/advisor/month-end-forecast?limit=8'"), 'dashboard must fetch saved month-end forecasts');
  assert.ok(app.includes("fetch('/api/advisor/month-end-forecast'"), 'dashboard must generate month-end forecasts');
  assert.ok(app.includes('handleForecastMonthEnd'), 'dashboard must expose a manual month-end forecast action');
  assert.ok(app.includes('توقع نهاية الشهر'), 'dashboard must render month-end forecast card');
  assert.ok(app.includes("idbSet('lkgs_month_end_forecasts'"), 'dashboard must cache last-known-good month-end forecasts');
  assert.ok(rules.includes('match /advisorMonthEndForecasts/{forecastId}'), 'Firestore rules must allow user-scoped month-end forecasts');
});

test('TREASURER-17: daily financial pulse gives a practical today plan without pretending background automation', async () => {
  const tools = await src('src/server/tools.ts');
  const server = await src('server.ts');
  const app = await src('src/App.tsx');
  const rules = await src('firestore.rules');
  assert.ok(tools.includes('export async function generateDailyFinancialPulse'), 'daily financial pulse generator must exist');
  assert.ok(tools.includes('export async function getDailyFinancialPulses'), 'saved daily pulse reader must exist');
  assert.ok(tools.includes('normalizeDailyPulseStatus'), 'daily pulse must classify daily risk status');
  assert.ok(tools.includes('buildDailyPulseHeadline'), 'daily pulse must build a concise daily headline');
  assert.ok(tools.includes('buildDailyDoNotSpendList'), 'daily pulse must return a do-not-spend list');
  assert.ok(tools.includes('daily_block'), 'daily pulse must detect days where discretionary spending should be blocked');
  assert.ok(tools.includes('daily_caution'), 'daily pulse must detect caution days');
  assert.ok(tools.includes('daily_growth'), 'daily pulse must detect healthy improvement days');
  assert.ok(tools.includes('biggestRisk'), 'daily pulse must expose the biggest risk for today');
  assert.ok(tools.includes('advisorDailyPulses'), 'daily pulses must be persisted and included in wipe');
  assert.ok(tools.includes('advisor-daily-pulse'), 'risky daily pulses must become advisor alerts when requested');
  assert.ok(tools.includes("category: 'daily_financial_pulse'"), 'daily pulse alerts must be categorized');
  assert.ok(tools.includes('generate_daily_financial_pulse: generateDailyFinancialPulse'), 'daily pulse generator must be registered in handlers');
  assert.ok(tools.includes('get_daily_financial_pulses: getDailyFinancialPulses'), 'daily pulse reader must be registered in handlers');
  assert.ok(tools.includes('name: "generate_daily_financial_pulse"'), 'daily pulse generator must be exposed to Gemini');
  assert.ok(tools.includes('name: "get_daily_financial_pulses"'), 'daily pulse reader must be exposed to Gemini');
  assert.ok(server.includes('app.post("/api/advisor/daily-pulse", authMiddleware'), 'daily pulse generation API must be available behind auth');
  assert.ok(server.includes('app.get("/api/advisor/daily-pulse", authMiddleware'), 'daily pulse read API must be available behind auth');
  assert.ok((server.match(/0\.3\.11- \*\*نبض اليوم المالي\*\*/g) || []).length >= 2, 'text and voice prompts must both instruct Gemini to generate daily pulses');
  assert.ok(server.includes('بدون ادعاء تشغيل تلقائي بالخلفية'), 'daily pulse prompt must avoid pretending background automation');
  assert.ok(app.includes('const [dailyFinancialPulses, setDailyFinancialPulses]'), 'dashboard must keep daily pulse state');
  assert.ok(app.includes("fetch('/api/advisor/daily-pulse?limit=8'"), 'dashboard must fetch saved daily pulses');
  assert.ok(app.includes("fetch('/api/advisor/daily-pulse'"), 'dashboard must generate daily pulses');
  assert.ok(app.includes('handleGenerateDailyFinancialPulse'), 'dashboard must expose a manual daily pulse action');
  assert.ok(app.includes('نبض اليوم المالي'), 'dashboard must render daily pulse card');
  assert.ok(app.includes('لا تصرف اليوم على'), 'dashboard must render do-not-spend guidance');
  assert.ok(app.includes("idbSet('lkgs_daily_financial_pulses'"), 'dashboard must cache last-known-good daily pulses');
  assert.ok(rules.includes('match /advisorDailyPulses/{pulseId}'), 'Firestore rules must allow user-scoped daily pulses');
});

test('TREASURER-18: advisor dashboard numbers remain explainable and tied to real transaction dates', async () => {
  const tools = await src('src/server/tools.ts');
  const app = await src('src/App.tsx');
  const guide = await src('FINANCIAL_ADVISOR_GUIDE_AR.md');
  assert.ok(tools.includes('protectionEndIso') && tools.includes('spendingPaceDays') && tools.includes('rawSafeToSpendUntilProtection'),
    'safe spending must protect the remaining salary cycle and pace daily/weekly caps instead of showing all cash as today spend');
  assert.ok(tools.includes('const reserveTarget = roundMoney(explicitReserve)') && tools.includes('behaviorBufferForForecastOnly'),
    'safe spending must not reserve average spending as a hidden buffer; average spending is forecast-only');
  assert.ok(tools.includes('if (!c.dueDate) return false'),
    'safe spending must not reserve undated commitments as upcoming unpaid obligations');
  assert.ok(tools.includes('findImplicitCommitmentPayment') && tools.includes('implicitlyPaidCommitments'),
    'safe spending must not reserve commitments that appear already paid by matching current-cycle expenses');
  assert.ok(tools.includes('transactionAnalysisDate') && tools.includes('tx?.localDay') && tools.includes('tx?.dateKey'),
    'habit and recurring engines must understand local transaction date fields, not only date');
  assert.ok(tools.includes('insufficient_data') && tools.includes('لا توجد مصروفات مقروءة في هذه الفترة'),
    'habit analysis must not claim stability when no current-period expenses are readable');
  assert.ok(tools.includes("queryTransactions({ period: 'current_salary_cycle', includeTransactions: true, limit }") && tools.includes("queryTransactions({ period: 'previous_salary_cycle', includeTransactions: true, limit }"),
    'habit analysis must read current and previous salary-cycle transactions like the rest of the advisor engines');
  assert.ok(tools.includes('habitTransactionKind') && tools.includes("transactionType === 'EXPENSE'") && tools.includes("transactionType === 'CREDIT_PURCHASE'"),
    'habit analysis must recognize expense-like transactions even when the type field is missing or stored in older formats');
  assert.ok(tools.includes('readDiagnostics') && app.includes('تشخيص القراءة'),
    'habit analysis must expose read diagnostics when expenses still cannot be read');
  assert.ok(app.includes("status === 'insufficient_data' ? 'بيانات غير كافية'"),
    'habit dashboard must display insufficient-data status instead of stable when spending cannot be read');
  assert.ok(tools.includes('NO_DATE_SORTED_TRANSACTIONS_FOR_HABITS'),
    'habit analysis must fall back when date-sorted queries miss localDay-only transactions');
  assert.ok(tools.includes('NO_DATE_SORTED_TRANSACTIONS_FOR_RECURRING_DETECTION'),
    'recurring detection must fall back when date-sorted queries miss localDay-only transactions');
  assert.ok(tools.includes('service|phone_bill') && tools.includes('service|internet_bill') && tools.includes('service|family_support_mother'),
    'recurring detection must group local phone, internet, and family-support wording semantically');
  assert.ok(tools.includes('tx.description') && tools.includes('tx.note'),
    'recurring detection must consider description/note fields, not only merchant or notes');
  assert.ok(tools.includes('orderedSnapshot') && tools.includes('unorderedSnapshot') && tools.includes('orderedDocsRead'),
    'commitments list must merge ordered and unordered reads so undated saved commitments are not hidden');
  assert.ok(tools.includes('hasValidDueDate') && tools.includes('daysRemaining !== null'),
    'undated commitments must not be marked as due today');
  assert.ok(tools.includes("return Boolean(c.dueDate || c.recurring || c.recurringFrequency || c.recurringDetectionKey)"),
    'commitment review must not hide real due commitments just because recurring=true is missing');
  assert.ok(tools.includes('dailyAverage <= 0') && tools.includes('لا أعتبر المبلغ المتبقي كله فائضاً'),
    'month-end forecast must not claim current remaining cash is a surplus when spending pace is missing');
  assert.ok(app.includes('notificationDismissTimersRef') && app.includes("const delay = type === 'error' ? 12000"),
    'top notifications must auto-dismiss after a visible delay');
  assert.ok(app.includes('إغلاق التنبيه') && app.includes('لا يعدّل العمليات المالية تلقائياً'),
    'advisor alert action must clarify that resolving an alert does not auto-fix ledger data');
  assert.ok(app.includes('تفصيل السقف الآمن') && app.includes('متوسط الصرف للتوقع والتحذير فقط وليس مبلغًا محجوزًا'),
    'treasurer pulse card must explain why cash is reserved and that spending pace is not a hidden reserve');
  assert.ok(tools.includes('hardDeficitToProtected') && tools.includes('spendingPressureGap') && tools.includes('daily_reduce_spending_pressure'),
    'daily pulse must separate hard recovery from expected-spending pressure');
  assert.ok(app.includes('عجز فعلي') && app.includes('ضغط متوقع') && app.includes('spendingPressureGap'),
    'dashboard must label hard deficit separately from expected spending pressure');
  assert.ok(tools.includes('hardWeeklyDeficit') && tools.includes('reduce_expected_spending_pressure'),
    'weekly plan must show spending pressure as watch/reduce, not recovery');
  assert.ok(tools.includes('hardForecastDeficit') && tools.includes('spendingReductionNeeded'),
    'month-end forecast must distinguish real projected gaps from the protected critical floor and spending pressure');
  assert.ok(tools.includes('safeCalculationOk') && tools.includes('daily_safe_spending_unavailable'),
    'daily pulse must not display a zero cap as a real result when safe-spending calculation fails');
  assert.ok(tools.includes('alreadyCoveredByPulse') && tools.includes("actionType === 'daily_cap'") && tools.includes("actionType === 'recover_gap'"),
    'daily pulse must not duplicate the same cap/recovery/pressure tasks from weekly and month-end engines');
  assert.ok(app.includes("fetch('/api/advisor/audit?scope=salary_cycle&findingLimit=6'") && app.includes("idbSet('lkgs_advisor_audit'"),
    'resolving or dismissing an alert must refresh the audit score shown on the dashboard');
  assert.ok(app.includes('window.confirm') && app.includes('تطبيق الخطة سيغيّر حدود الميزانيات'),
    'adaptive budget application must require visible user confirmation');
  assert.ok(tools.includes('calculationTrace') && tools.includes('currentLiquid + expectedRoutineIncome - expectedRoutineSpend - dueCommitments'),
    'scenario engine must expose its calculation trace so users can understand the judgment');
  assert.ok(tools.includes("queryTransactions({ period: 'current_salary_cycle', includeTransactions: true, limit: 500 }"),
    'financial context must fall back to salary-cycle transaction reads when date-only queries miss localDay records');
  assert.ok(app.includes('الهامش بعده') && app.includes('المحاكاة لا تسجل عملية'),
    'scenario card must explain that it is a what-if simulation, not a transaction');
  assert.ok(app.includes('سقف الأسبوع') && app.includes('weeklyFinancialPlans[0].actions.slice(0, 3)'),
    'weekly plan card must use clearer labels and show multiple recommendations');
  assert.ok(app.includes('تفصيل التوقع') && app.includes('هامش نهاية الدورة = المتبقي الحالي - الصرف المتوقع'),
    'month-end forecast card must show the calculation behind projected surplus/pressure');
  assert.ok(app.includes('يوجد {commitments.length} التزام محفوظ'),
    'commitments dashboard must show saved commitments even when no new recurring candidates exist');
  assert.ok(guide.includes('ماذا يحدث خلف الكواليس') && guide.includes('السقف اليومي = الهامش القابل للتوزيع / عدد الأيام المتبقية') && guide.includes('ولا يُحجز كالتزام فعلي'),
    'Arabic advisor guide must document features and behind-the-scenes calculations without claiming average spending is reserved');
});
