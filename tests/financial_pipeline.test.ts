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
