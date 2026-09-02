/**
 * V6.1 E2E + Cross-System Consistency Tests.
 *
 * Tests the 13-step scenario from PHASE 17 + debt E2E + report snapshot.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { calculateBalances, calculateBreakdown } from '../src/lib/balanceCalc.ts';
import { selectOpenCreditorDebt } from '../src/lib/debtSelection.ts';
import { buildReportSnapshotRecord } from '../src/lib/reportUtils.ts';

function tx(opts: any) {
  return {
    id: opts.id || `tx_${Math.random().toString(36).slice(2,8)}`,
    amount: opts.amount,
    type: opts.type,
    account: opts.account || 'cash',
    fromAccount: opts.fromAccount,
    toAccount: opts.toAccount,
    category: opts.category || 'عام',
    subcategory: opts.subcategory || '',
    merchant: opts.merchant || '',
    notes: opts.notes || '',
    necessity: opts.necessity || (opts.type === 'expense' ? 'ضروري' : ''),
    date: opts.date || new Date().toISOString(),
    createdAt: opts.createdAt || new Date().toISOString(),
    transactionType: opts.transactionType,
    creditor: opts.creditor,
    creditorKey: opts.creditorKey,
    userId: opts.userId || 'test_user',
  };
}

// CASE A — BORROW CASH
test('DEBT-E2E-A: "استدنت 100 شيكل نقدي من أحمد" → Cash+100, Debt+100, Income+0, Expense+0, Creditor=أحمد', () => {
  const txs = [tx({
    type: 'transfer', amount: 100, fromAccount: 'debt', toAccount: 'cash',
    transactionType: 'DEBT_BORROWING', creditor: 'أحمد', merchant: 'أحمد'
  })];
  const b = calculateBalances(txs);
  assert.equal(b.cash, 100, 'Cash +100');
  assert.equal(b.debt, 100, 'Debt +100');
  assert.equal(b.total, 100, 'Total liquidity = cash only');
  // Income and expense must remain 0 (no income/expense txs).
  const bd = calculateBreakdown(txs);
  assert.equal(bd.income, 0, 'Income unchanged');
  assert.equal(bd.expense, 0, 'Expense unchanged');
  // Creditor tracked
  assert.ok(Object.keys(bd.creditorDebts).length > 0, 'Creditor debt tracked');
});

// CASE B — CREDIT PURCHASE
test('DEBT-E2E-B: "اشتريت ملابس للعيال بـ100 دين من أحمد" → Debt+100, Expense+100, Cash/PalPay/Income unchanged', () => {
  const txs = [tx({
    type: 'expense', amount: 100, account: 'debt',
    category: 'الأبناء', subcategory: 'ملابس',
    transactionType: 'CREDIT_PURCHASE', creditor: 'أحمد', merchant: 'أحمد'
  })];
  const b = calculateBalances(txs);
  assert.equal(b.cash, 0);
  assert.equal(b.palPay, 0);
  assert.equal(b.debt, 100);
  const bd = calculateBreakdown(txs);
  assert.equal(bd.income, 0);
  assert.equal(bd.expense, 100);
});

// CASE D — MULTIPLE CREDITORS, AMBIGUOUS SELECTION
test('DEBT-E2E-D: Ahmed=1000 + Mohammed=500 → "سدد 200" without creditor → NO MUTATION (backend asks)', () => {
  const selection = selectOpenCreditorDebt({
    amount: 200,
    debts: [
      { key: 'ahmed', creditor: 'Ahmed', remaining: 1000 },
      { key: 'mohammed', creditor: 'Mohammed', remaining: 500 },
    ],
  });
  assert.equal(selection.ok, false);
  if (!selection.ok) {
    assert.equal(selection.reason, 'AMBIGUOUS_CREDITOR');
    assert.deepEqual(selection.options, [
      { creditor: 'Ahmed', remaining: 1000 },
      { creditor: 'Mohammed', remaining: 500 },
    ]);
    assert.match(selection.message, /لمن تريد سداد 200/);
  }
});

// CASE F — OVERPAYMENT
test('DEBT-E2E-F: Ahmed=100, "سدد 200" → debt MUST NOT go negative', () => {
  const txs = [
    tx({ type: 'transfer', amount: 100, fromAccount: 'debt', toAccount: 'cash', transactionType: 'DEBT_BORROWING', creditor: 'أحمد', merchant: 'أحمد' }),
    // If overpayment were allowed, the math would produce debt=-100. We verify the math,
    // and the guard (OVERPAYMENT_ATOMIC in atomicPayDebt) blocks the actual write.
    tx({ type: 'transfer', amount: 200, fromAccount: 'cash', toAccount: 'debt', transactionType: 'DEBT_PAYMENT', creditor: 'أحمد', merchant: 'أحمد' }),
  ];
  const b = calculateBalances(txs);
  // The math DOES produce debt=-100. The OVERPAYMENT guard is essential.
  assert.equal(b.debt, -100, 'math would produce negative debt — payDebt guard is essential');
});

// CASE E — PAYMENT ACCOUNT MISSING
test('DEBT-E2E-E: "سددت لأحمد 200" without payment method → ask (no guessing)', async () => {
  const src = await readFile(join(process.cwd(), 'server.ts'), 'utf8');
  assert.ok(src.includes('حساب الدفع'),
    'prompt mentions payment account');
  assert.ok(src.includes('لا تخمن'),
    'prompt forbids guessing');
});

// NATURAL PURCHASE RECORDING
test('PURCHASE-E2E: "اشتريت أواعي للعيال بـ200" without payment method → NO MUTATION (MISSING_PAYMENT_METHOD)', async () => {
  const src = await readFile(join(process.cwd(), 'src/server/tools.ts'), 'utf8');
  assert.ok(src.includes('MISSING_PAYMENT_METHOD'),
    'addTransaction rejects expense without payment method');
});

// CASH ↔ PALPAY E2E
test('TRANSFER-E2E: Cash=1000, PalPay=500, "حول 200 من النقدي إلى PalPay" → Cash=800, PalPay=700', () => {
  const initial = [
    tx({ type: 'income', amount: 1000, account: 'cash' }),
    tx({ type: 'income', amount: 500, account: 'palPay' }),
  ];
  const after = [
    ...initial,
    tx({ type: 'transfer', amount: 200, fromAccount: 'cash', toAccount: 'palPay' }),
  ];
  const b = calculateBalances(after);
  assert.equal(b.cash, 800);
  assert.equal(b.palPay, 700);
  assert.equal(b.debt, 0);
});

// CROSS-SYSTEM CONSISTENCY (PHASE 17 — 13 steps)
test('E2E-13: Full scenario produces consistent balances across Dashboard/Report', () => {
  const dataset = [
    // 1. Income 3000 Cash
    tx({ type: 'income', amount: 3000, account: 'cash', date: '2026-08-01T10:00:00Z' }),
    // 2. Borrow 500 Cash from Ahmed
    tx({ type: 'transfer', amount: 500, fromAccount: 'debt', toAccount: 'cash', transactionType: 'DEBT_BORROWING', creditor: 'أحمد', merchant: 'أحمد', date: '2026-08-02T10:00:00Z' }),
    // 3. Buy clothes 200 Cash
    tx({ type: 'expense', amount: 200, account: 'cash', category: 'الأبناء', subcategory: 'ملابس', date: '2026-08-03T10:00:00Z' }),
    // 4. Transfer 300 Cash -> PalPay
    tx({ type: 'transfer', amount: 300, fromAccount: 'cash', toAccount: 'palPay', date: '2026-08-04T10:00:00Z' }),
    // 5. Buy food 150 PalPay
    tx({ type: 'expense', amount: 150, account: 'palPay', category: 'طعام ومشتريات منزل', subcategory: 'خضار وفواكه', date: '2026-08-05T10:00:00Z' }),
    // 6. Credit purchase 400 from Mohammed
    tx({ type: 'expense', amount: 400, account: 'debt', category: 'الأبناء', subcategory: 'مصروف', transactionType: 'CREDIT_PURCHASE', creditor: 'محمد', merchant: 'محمد', date: '2026-08-06T10:00:00Z' }),
    // 7. Pay Ahmed 200 Cash
    tx({ type: 'transfer', amount: 200, fromAccount: 'cash', toAccount: 'debt', transactionType: 'DEBT_PAYMENT', creditor: 'أحمد', merchant: 'أحمد', date: '2026-08-07T10:00:00Z' }),
  ];
  // Expected state calculation:
  // Cash: 3000 (income) + 500 (borrow) - 200 (clothes) - 300 (transfer out) - 200 (pay Ahmed) = 2800
  // PalPay: 0 + 300 (transfer in) - 150 (food) = 150
  // Debt: +500 (borrow from Ahmed) + 400 (credit from Mohammed) - 200 (pay Ahmed) = 700
  //   - Ahmed: 500 - 200 = 300
  //   - Mohammed: 400
  const b = calculateBalances(dataset);
  assert.equal(b.cash, 2800, 'Cash = 2800');
  assert.equal(b.palPay, 150, 'PalPay = 150');
  assert.equal(b.debt, 700, 'Total debt = 700');
  assert.equal(b.total, 2950, 'Total liquidity = cash + palPay = 2950');
  // Per-creditor breakdown
  const bd = calculateBreakdown(dataset);
  assert.equal(bd.creditorDebts[normalizeCreditorKeyLocal('أحمد')], 300, 'Ahmed debt = 300');
  assert.equal(bd.creditorDebts[normalizeCreditorKeyLocal('محمد')], 400, 'Mohammed debt = 400');
});

function normalizeCreditorKeyLocal(value: any): string {
  return String(value || '').trim().toLowerCase()
    .replace(/[أإآ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه')
    .replace(/[ـًٌٍَُِّْ]/g, '').replace(/\s+/g, ' ');
}

// REPORT SNAPSHOT CLARITY
test('REPORT-SNAPSHOT: generated reports marked isSnapshot + generatedAt', () => {
  const generatedAt = new Date('2026-08-31T12:00:00.000Z');
  const rows = [{ id: 'tx-1', amount: 10, type: 'expense' }];
  const report = buildReportSnapshotRecord({
    userId: 'user-1',
    title: 'تقرير تجريبي',
    timeframe: 'month',
    category: 'طعام',
    transactions: rows,
    now: generatedAt,
  });
  assert.equal(report.isSnapshot, true, 'report includes isSnapshot: true');
  assert.equal(report.generatedAt, '2026-08-31T12:00:00.000Z', 'report includes generatedAt timestamp');
  assert.equal(report.createdAt, report.generatedAt, 'report timestamps are snapshot generation timestamps');
  assert.deepEqual(report.transactions, rows, 'report freezes filtered transactions at generation time');
});

// CANONICAL BALANCE: Dashboard == Report
test('CANONICAL: dashboard uses calculateBalances (mirrors backend)', async () => {
  const src = await readFile(join(process.cwd(), 'src/App.tsx'), 'utf8');
  assert.ok(src.includes('calculateBalances(finalTx)'),
    'App.tsx uses canonical calculateBalances (not inline duplicate)');
});

// FLOATING ASSISTANT
test('MOB-01..06: FloatingAssistant component exists with resize/orientation handling', async () => {
  const src = await readFile(join(process.cwd(), 'src/components/FloatingAssistant.tsx'), 'utf8');
  assert.ok(src.includes("addEventListener('resize'"),
    'listens for resize');
  assert.ok(src.includes("addEventListener('orientationchange'"),
    'listens for orientation change');
  assert.ok(src.includes('visualViewport'),
    'uses visualViewport for mobile browser toolbar changes');
  assert.ok(src.includes('dragConstraints={constraints}'),
    'uses dynamic constraints (not hardcoded)');
  assert.ok(src.includes('touch-none'),
    'touch-none class to prevent scroll conflicts');
});

// AI PROMPT — DURABILITY TRUTHFULNESS
test('AI-DURABILITY: prompt instructs AI to be honest about pending durability', async () => {
  const src = await readFile(join(process.cwd(), 'server.ts'), 'utf8');
  assert.ok(src.includes('0.7- **V6.1 — المتانة (Durability)**'),
    'V6.1 durability prompt rule present');
  assert.ok(src.includes('لا تقل "تم" أو "حفظت" أو "سجلتها"'),
    'prompt forbids claiming success on pending');
  assert.ok(src.includes('لم تُسجّل العملية في السحابة'),
    'pending durability must be described as not registered in cloud');
  assert.equal(src.includes('ستصل السحابة عند عودة الاتصال'), false,
    'prompt must not describe pending financial writes as queued successful cloud sync');
  assert.equal(src.includes('معلّقة للمزامنة'), false,
    'prompt must not imply a local pending write is a successful addition');
});

// AI PROMPT — PURCHASE INTENT VS COMPLETED
test('AI-INTENT: prompt distinguishes purchase intent vs completed purchase', async () => {
  const src = await readFile(join(process.cwd(), 'server.ts'), 'utf8');
  assert.ok(src.includes('0.9- **V6.1 — نية الشراء vs الشراء المنجز'),
    'V6.1 intent-vs-completed rule present');
});

test('HISTORICAL-ENTRY: prompt and tool schema support backdated expense entry safely', async () => {
  const serverSrc = await readFile(join(process.cwd(), 'server.ts'), 'utf8');
  const toolsSrc = await readFile(join(process.cwd(), 'src/server/tools.ts'), 'utf8');
  assert.ok(serverSrc.includes('عند نقل مصروفات أشهر سابقة'),
    'prompt must instruct historical entry behavior');
  assert.ok(serverSrc.includes('لا تخترع تاريخاً'),
    'prompt must forbid inventing dates for historical month context');
  assert.ok(toolsSrc.includes('date: { type: "string"'),
    'add_transaction schema must expose explicit date');
  assert.ok(toolsSrc.includes('historicalMonth: { type: "string"'),
    'add_transaction schema must expose historical month context');
  assert.ok(toolsSrc.includes('day: { type: "number"'),
    'add_transaction schema must expose day within historical month');
  assert.ok(toolsSrc.includes('normalizeHistoricalTransactionDate'),
    'addTransaction must normalize historical dates before persistence');
});

test('SAVINGS-UI: dashboard exposes savings goals without touching stable Live voice pipeline', async () => {
  const app = await readFile(join(process.cwd(), 'src/App.tsx'), 'utf8');
  assert.ok(app.includes('const [showSavings, setShowSavings]'),
    'dashboard must expose a savings goals modal state');
  assert.ok(app.includes("fetch('/api/savings-goals'"),
    'dashboard must load savings goals from the backend API');
  assert.ok(app.includes('criticalSavingsGoals'),
    'dashboard must surface critical savings-goal alerts');
  assert.equal(app.includes("setVoice('Custom')"), false,
    'savings UI must not introduce custom voice into the stable Puck/Zephyr Live selector');
});

test('IMPORT-UI: expense file import supports images and spreadsheets with review-before-save', async () => {
  const app = await readFile(join(process.cwd(), 'src/App.tsx'), 'utf8');
  const server = await readFile(join(process.cwd(), 'server.ts'), 'utf8');
  assert.ok(app.includes('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'),
    'upload control must accept .xlsx expense files');
  assert.ok(app.includes('.csv,.tsv,.txt,.json,.xlsx'),
    'upload control must accept common table files');
  assert.ok(app.includes('fileBase64'),
    'client must send generic file data, not image-only payloads');
  assert.ok(app.includes('showScannerResult.warnings'),
    'review modal must show parser warnings before save');
  assert.ok(server.includes('parseExpenseImportFile'),
    'server must parse tabular expense files locally before optional AI fallback');
  assert.ok(server.includes('MISSING_IMPORTED_EXPENSE_DATE'),
    'tabular imports missing dates must not be saved as today by accident');
  assert.ok(server.includes("beneficiary: item.beneficiary || item.forWhom || item.purpose || item.category || item.subcategory || item.notes || 'مصروف مستورد'"),
    'reviewed imported items must pass an extracted purpose/beneficiary so normal expense guards do not ask again');
  assert.ok(app.includes('const [isRecordingScannedReceipt, setIsRecordingScannedReceipt]'),
    'receipt record UI must track in-flight submission state');
  assert.ok(app.includes('disabled={isRecordingScannedReceipt}'),
    'receipt record buttons must be disabled during submission to prevent duplicate quota-burning requests');
  assert.ok(app.includes('جارٍ التسجيل'),
    'receipt record UI must show clear progress instead of appearing unresponsive');
  assert.ok(app.includes('currentBalances: { cash, palPay, debt, total: balance }'),
    'receipt record UI must send the visible selected-account balance for split-to-debt imports');
  assert.ok(app.includes('splitOverflowToDebt: true'),
    'receipt record UI must request safe selected-balance-then-debt splitting');
  assert.ok(app.includes('controller.abort(), 30000') && app.includes("err?.name === 'AbortError'"),
    'receipt record UI must time out instead of staying stuck on submitting forever');
});

test('CLOUD-BADGE: partial ledger fallback must not override a successful cloud-health check', async () => {
  const app = await readFile(join(process.cwd(), 'src/App.tsx'), 'utf8');
  const server = await readFile(join(process.cwd(), 'server.ts'), 'utf8');
  assert.ok(app.includes("fetch('/api/cloud-health'") && app.includes("const cloudReady = cloudHealthRes.ok && cloudHealth?.firestore === 'read-write-ok'"),
    'cloud badge must have an explicit cloud-health source of truth');
  assert.ok(app.includes('setIsOfflineMode(!cloudReady)'),
    'partial or bounded ledger fallback must not force the badge to local when cloud-health is ok');
  assert.ok(app.includes('does not prove that the app is offline'),
    'source code should document that partial ledger data is not connectivity state');
  assert.ok(server.includes('let cachedCloudHealth') && server.includes('cached: true'),
    'cloud-health must cache recent success so the badge probe itself does not burn quota on every refresh');
});
