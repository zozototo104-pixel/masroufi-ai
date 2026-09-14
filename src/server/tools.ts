import { createHash } from 'crypto';
import { getDb, clearAllLocalUserData, type WriteResult } from './fakeDb';
import { adminDb as firebaseAdminDb } from './firebaseAdmin';
import { buildReportSnapshotRecord, matchesArabicCategory } from '../lib/reportUtils';
import { validateImportEnvelope } from '../lib/importEnvelope';
import { prepareImportedFinancialTransactions } from '../lib/importFinancialTransactions';
import { selectOpenCreditorDebt } from '../lib/debtSelection';
import {
  buildSavingsGoalPlan,
  buildSavingsGoalRecord,
  normalizeSavingsDueDate,
  selectSavingsGoalForContribution,
  roundMoney,
} from '../lib/savingsCore';
import { parseAbsoluteFinancialAmount, parsePositiveFinancialAmount } from '../lib/amount';
import { normalizeHistoricalTransactionDate } from '../lib/historicalDate';
import {
  addVaultCurrencyAmount,
  deriveVaultAdjustmentCurrencyDelta,
  mergeVaultCurrencyDeltas,
  normalizeVaultAdjustmentEntries,
  type VaultAdjustmentEntry,
} from '../lib/vaultCurrency';
import {
  buildSalaryCycleForMonth,
  getCurrentSalaryCycle,
  getSalaryCycleForDate,
  normalizeDigits,
  parseDateLike,
  parseSalaryCycleMonth,
  resolveSalaryCycleFromArgs,
  summarizeSalaryCycleTransactions,
  type SalaryCyclePeriod,
} from '../lib/salaryCycle';
import { calculateBalances, calculateBreakdown, normalizeAccount, normalizeCreditorKey, normalizeLedgerAccount } from '../lib/balanceCalc';
export { normalizeAccount } from '../lib/balanceCalc';
import { addBalanceDelta, transactionReplacementDelta, txBalanceDelta } from '../lib/accountBalance';
import { GoogleGenAI } from '@google/genai';
import { runIdempotent } from './idempotency';
import { atomicAddTransaction, atomicDeleteTransaction, atomicDeleteTransactions, atomicPayDebt, atomicTransferMoney, atomicUpdateTransaction } from './atomicOps';
import {
  getCachedMarketResult,
  cacheMarketResult,
  isGazaSource,
  classifyMarketScope,
  normalizeCurrencyToIls,
  getFxConversionMetadata,
  refreshExchangeRatesToIls,
  computeNormalizedPriceRange,
  buildMarketComparison,
  extractPricesFromText,
  computePriceRange,
  shouldSearchMarket,
  isSmallDailyPurchase,
  type MarketResult,
  type MarketSearchResponse,
} from './marketIntelligence';
import {
  inferCategory,
  inferNecessityForGazaContext,
  normalizeArabicText,
  normalizeIncomeAllocations,
  needsIncomeAllocationQuestion,
  evaluateTreasurerRisk,
  buildTreasurerReport,
  TREASURER_CATEGORY_TAXONOMY,
} from './treasurerEngine';

const FIRESTORE_WRITE_BATCH_LIMIT = 500;
const IMPORT_REPLACE_ATOMIC_HEADROOM = 50;
const IMPORT_REPLACE_ATOMIC_MUTATION_LIMIT = FIRESTORE_WRITE_BATCH_LIMIT - IMPORT_REPLACE_ATOMIC_HEADROOM;

// Persistent notification center. Notifications are stored per-user so Cloud Run restarts do not erase them.
// The UI still renders short-lived toasts, but persistence is the source of truth.
export async function getNotifications(userId: string, token: string, limit: number = 50) {
  const adminDb = getDb(token);
  const requestedLimit = Math.max(1, Math.min(100, limit));
  const snap = await adminDb.collection('users').doc(userId).collection('notifications')
    .orderBy('createdAt', 'desc')
    .limit(requestedLimit)
    .get();
  const allItems = snap.docs.map((d: any) => ({ id: d.id, ...d.data() }));
  const items = allItems.filter((n: any) => !n.delivered).slice(0, requestedLimit);
  // V6 (MF-5): mark items as delivered in a SINGLE Firestore batch instead of N writes.
  // This reduces quota usage and prevents partial-write storms.
  if (items.length > 0) {
    const batch = adminDb.batch();
    const now = new Date().toISOString();
    for (const n of items) {
      batch.set(adminDb.collection('users').doc(userId).collection('notifications').doc(n.id), {
        ...n,
        delivered: true,
        deliveredAt: now,
      });
    }
    try {
      await batch.commit();
    } catch (batchErr) {
      // Best-effort delivery marking. Don't fail the GET if the batch write fails.
      console.warn('[notifications] delivery-marking batch failed:', batchErr);
    }
  }
  return { notifications: items, unreadCount: allItems.filter((n: any) => !n.read).length, partial: (snap as any).partial };
}

export async function markNotificationRead(args: any, userId: string, token: string) {
  if (!args?.id) return { success: false, error: 'Notification ID is required' };
  const adminDb = getDb(token);
  const ref = adminDb.collection('users').doc(userId).collection('notifications').doc(String(args.id));
  const snap = await ref.get();
  if (!snap.exists) return { success: false, error: 'Notification not found' };
  await ref.set({ ...snap.data(), read: true, readAt: new Date().toISOString() });
  return { success: true };
}

function parseBooleanLike(value: any): boolean {
  if (typeof value === 'boolean') return value;
  const raw = String(value || '').trim().toLowerCase();
  return ['1', 'true', 'yes', 'y', 'نعم', 'اه', 'أه'].includes(raw);
}

function normalizeAdvisorAlertStatus(value: any) {
  const raw = String(value || 'open').toLowerCase();
  return ['open', 'resolved', 'dismissed', 'snoozed'].includes(raw) ? raw : 'open';
}

export async function getAdvisorAlerts(args: any, userId: string, token: string) {
  const adminDb = getDb(token);
  const requestedLimit = Math.max(1, Math.min(100, Number(args?.limit) || 50));
  const includeResolved = parseBooleanLike(args?.includeResolved);
  const includeSnoozed = parseBooleanLike(args?.includeSnoozed);
  const nowIso = new Date().toISOString();
  const snap = await adminDb.collection('users').doc(userId).collection('notifications')
    .orderBy('createdAt', 'desc')
    .limit(requestedLimit)
    .get();
  const alerts = snap.docs
    .map((d: any) => ({ id: d.id, ...d.data() }))
    .filter((item: any) => Boolean(item.advisorAlert))
    .filter((item: any) => {
      const status = normalizeAdvisorAlertStatus(item.advisorStatus);
      if (!includeResolved && ['resolved', 'dismissed'].includes(status)) return false;
      if (!includeSnoozed && status === 'snoozed' && item.snoozedUntil && String(item.snoozedUntil) > nowIso) return false;
      return true;
    })
    .slice(0, requestedLimit);

  const counts = alerts.reduce((acc: any, item: any) => {
    const status = normalizeAdvisorAlertStatus(item.advisorStatus);
    const severity = String(item.severity || item.type || 'info');
    acc.total += 1;
    acc.byStatus[status] = (acc.byStatus[status] || 0) + 1;
    acc.bySeverity[severity] = (acc.bySeverity[severity] || 0) + 1;
    if (!item.read) acc.unread += 1;
    return acc;
  }, { total: 0, unread: 0, byStatus: {}, bySeverity: {} });

  return {
    success: true,
    alerts,
    counts,
    partial: Boolean((snap as any).partial),
    readEfficiency: { notificationsLimit: requestedLimit, docsRead: snap.docs.length, advisorAlertsReturned: alerts.length },
  };
}

export async function updateAdvisorAlert(args: any, userId: string, token: string) {
  if (!args?.id) return { success: false, error: 'Advisor alert ID is required' };
  const action = String(args.action || 'read').toLowerCase();
  const adminDb = getDb(token);
  const ref = adminDb.collection('users').doc(userId).collection('notifications').doc(String(args.id));
  const snap = await ref.get();
  if (!snap.exists) return { success: false, error: 'Advisor alert not found' };
  const current = snap.data() || {};
  if (!current.advisorAlert) return { success: false, error: 'Notification is not an advisor alert' };

  const nowIso = new Date().toISOString();
  const patch: any = { read: true, readAt: current.readAt || nowIso, lastAdvisorAction: action, lastAdvisorActionAt: nowIso };
  if (action === 'resolve' || action === 'resolved') {
    Object.assign(patch, { advisorStatus: 'resolved', resolvedAt: nowIso, dismissedAt: null, snoozedUntil: null });
  } else if (action === 'dismiss' || action === 'dismissed') {
    Object.assign(patch, { advisorStatus: 'dismissed', dismissedAt: nowIso, resolvedAt: null, snoozedUntil: null });
  } else if (action === 'snooze' || action === 'snoozed') {
    const until = args?.until ? new Date(String(args.until)) : new Date(Date.now() + 24 * 60 * 60 * 1000);
    const safeUntil = Number.isFinite(until.getTime()) ? until : new Date(Date.now() + 24 * 60 * 60 * 1000);
    Object.assign(patch, { advisorStatus: 'snoozed', snoozedUntil: safeUntil.toISOString(), resolvedAt: null, dismissedAt: null });
  } else if (action === 'reopen' || action === 'open') {
    Object.assign(patch, { advisorStatus: 'open', resolvedAt: null, dismissedAt: null, snoozedUntil: null });
  } else if (action !== 'read') {
    return { success: false, error: `Unsupported advisor alert action: ${action}` };
  }

  await ref.set(patch, { merge: true });
  return { success: true, id: String(args.id), action, advisorStatus: patch.advisorStatus || normalizeAdvisorAlertStatus(current.advisorStatus) };
}

function stableDocId(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 40);
}

function roundFinancial(value: unknown): number {
  return Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
}

function amountsClose(a: unknown, b: unknown, tolerance = 0.01): boolean {
  return Math.abs(roundFinancial(a) - roundFinancial(b)) <= tolerance;
}

function normalizeBalanceDoc(data: any = {}) {
  const cash = roundFinancial(data.cash);
  const palPay = roundFinancial(data.palPay);
  const debt = roundFinancial(data.debt);
  const vault = roundFinancial(data.vault);
  return { cash, palPay, debt, vault, total: roundFinancial(cash + palPay) };
}

async function verifyAddTransactionCommit(userId: string, transactionId: string, tx: any, expectedBalances: any, atomicResult: any) {
  const verification: any = {
    ok: false,
    transactionId,
    transactionDocumentConfirmed: false,
    balanceSnapshotConfirmed: false,
    balanceEffectConfirmed: false,
    userIdHash: stableDocId(userId),
    previousBalances: atomicResult?.previousBalances || null,
    balanceDelta: atomicResult?.balanceDelta || txBalanceDelta(tx),
    expectedBalances: expectedBalances ? normalizeBalanceDoc(expectedBalances) : null,
    storedBalances: null,
    errors: [] as string[],
    warnings: [] as string[],
  };

  try {
    const [txSnap, balanceSnap] = await Promise.all([
      firebaseAdminDb.collection('transactions').doc(transactionId).get(),
      firebaseAdminDb.collection('users').doc(userId).collection('meta').doc('accountBalances').get(),
    ]);

    if (!txSnap.exists) {
      verification.errors.push('TRANSACTION_DOC_NOT_FOUND_AFTER_COMMIT');
    } else {
      const storedTx = txSnap.data() || {};
      const amountMatches = amountsClose(storedTx.amount, tx.amount);
      const coreMatches = storedTx.userId === userId
        && amountMatches
        && String(storedTx.type || '') === String(tx.type || '')
        && String(storedTx.account || '') === String(tx.account || '')
        && String(storedTx.date || '').slice(0, 10) === String(tx.date || '').slice(0, 10);
      verification.transactionDocumentConfirmed = coreMatches;
      verification.storedTransactionPreview = {
        id: transactionId,
        amount: storedTx.amount,
        type: storedTx.type,
        account: storedTx.account,
        category: storedTx.category,
        subcategory: storedTx.subcategory,
        date: storedTx.date,
      };
      if (!coreMatches) verification.errors.push('TRANSACTION_DOC_CORE_FIELDS_MISMATCH');
    }

    if (!balanceSnap.exists) {
      verification.errors.push('BALANCE_SNAPSHOT_NOT_FOUND_AFTER_COMMIT');
    } else {
      verification.storedBalances = normalizeBalanceDoc(balanceSnap.data() || {});
      const expected = verification.expectedBalances;
      if (expected) {
        verification.balanceSnapshotConfirmed = ['cash', 'palPay', 'debt', 'vault'].every((key) => amountsClose(verification.storedBalances[key], expected[key]));
        verification.balanceEffectConfirmed = verification.balanceSnapshotConfirmed;
        if (!verification.balanceSnapshotConfirmed) verification.errors.push('BALANCE_SNAPSHOT_MISMATCH_AFTER_COMMIT');
      } else {
        verification.balanceSnapshotConfirmed = true;
        verification.balanceEffectConfirmed = true;
      }
    }

    if (verification.transactionDocumentConfirmed && !verification.balanceSnapshotConfirmed) {
      // The money ledger document is the source of truth. If the snapshot read is
      // missing/stale, repair it from the user's ledger immediately instead of
      // reporting a vague cloud-save failure while the transaction itself exists.
      try {
        const ledgerSnap = await firebaseAdminDb.collection('transactions').where('userId', '==', userId).get();
        const ledgerTransactions = (ledgerSnap.docs || []).map((doc: any) => ({ id: doc.id, ...doc.data() }));
        const repairedBalances = normalizeBalanceDoc(calculateBalances(ledgerTransactions));
        await firebaseAdminDb.collection('users').doc(userId).collection('meta').doc('accountBalances').set({
          userId,
          ...repairedBalances,
          total: roundFinancial(repairedBalances.cash + repairedBalances.palPay),
          source: 'post_commit_verification_repair',
          repairedAfterTransactionId: transactionId,
          repairedAt: new Date().toISOString(),
          version: 1,
        }, { merge: true });
        verification.balanceRepairAttempted = true;
        verification.balanceRepairApplied = true;
        verification.balanceRepairLedgerDocsRead = ledgerSnap.docs.length;
        verification.storedBalances = repairedBalances;
        verification.balanceSnapshotConfirmed = true;
        verification.balanceEffectConfirmed = true;
        verification.warnings.push('BALANCE_SNAPSHOT_REPAIRED_FROM_LEDGER_AFTER_COMMIT');
        verification.errors = verification.errors.filter((e: string) => e !== 'BALANCE_SNAPSHOT_NOT_FOUND_AFTER_COMMIT' && e !== 'BALANCE_SNAPSHOT_MISMATCH_AFTER_COMMIT');
      } catch (repairErr: any) {
        verification.balanceRepairAttempted = true;
        verification.balanceRepairApplied = false;
        verification.balanceRepairError = repairErr?.message || String(repairErr);
        verification.errors.push(`BALANCE_SNAPSHOT_REPAIR_FAILED: ${verification.balanceRepairError}`);
      }
    }

    verification.ok = verification.transactionDocumentConfirmed && verification.balanceSnapshotConfirmed && verification.balanceEffectConfirmed;
    return verification;
  } catch (error: any) {
    verification.errors.push(error?.message || String(error));
    verification.error = error?.message || String(error);
    return verification;
  }
}

async function addNotification(
  userId: string,
  message: string,
  type: string = 'success',
  adminDb?: any,
  options: {
    idempotencyKey?: string;
    transactionId?: string;
    operationId?: string;
    metadata?: any;
    advisorAlert?: boolean;
    advisorStatus?: string;
    severity?: string;
    priority?: string;
    category?: string;
    source?: string;
    actions?: any[];
  } = {}
) {
  if (!adminDb) return;
  try {
    const now = new Date().toISOString();
    const docId = options.idempotencyKey ? stableDocId(`${userId}|notification|${options.idempotencyKey}`) : undefined;
    const ref = docId
      ? adminDb.collection('users').doc(userId).collection('notifications').doc(docId)
      : adminDb.collection('users').doc(userId).collection('notifications').doc();
    const existing = docId ? await ref.get() : null;
    if (existing?.exists) {
      const duplicatePatch: any = {
        duplicateCount: Number(existing.data()?.duplicateCount || 0) + 1,
        lastDuplicateAt: now,
        delivered: existing.data()?.delivered ?? false,
      };
      if (options.advisorAlert) {
        Object.assign(duplicatePatch, {
          message,
          type,
          read: false,
          advisorAlert: true,
          advisorStatus: options.advisorStatus || 'open',
          severity: options.severity || existing.data()?.severity || null,
          priority: options.priority || existing.data()?.priority || null,
          category: options.category || existing.data()?.category || null,
          source: options.source || existing.data()?.source || null,
          actions: Array.isArray(options.actions) ? options.actions.slice(0, 6) : existing.data()?.actions || [],
          metadata: options.metadata || existing.data()?.metadata || null,
          resolvedAt: null,
          dismissedAt: null,
          snoozedUntil: null,
        });
      }
      await ref.set(duplicatePatch, { merge: true });
      return;
    }
    await ref.set({
      message,
      type,
      read: false,
      delivered: false,
      createdAt: now,
      transactionId: options.transactionId || null,
      operationId: options.operationId || null,
      idempotencyKey: options.idempotencyKey || null,
      metadata: options.metadata || null,
      advisorAlert: Boolean(options.advisorAlert),
      advisorStatus: options.advisorStatus || (options.advisorAlert ? 'open' : null),
      severity: options.severity || null,
      priority: options.priority || null,
      category: options.category || null,
      source: options.source || null,
      actions: Array.isArray(options.actions) ? options.actions.slice(0, 6) : [],
      resolvedAt: null,
      dismissedAt: null,
      snoozedUntil: null,
      duplicateCount: 0,
    });
  } catch (e) {
    console.warn('Notification write failed after financial operation; financial commit remains valid:', e);
  }
}

export async function recordTransactionCommittedSideEffects(
  userId: string,
  transactionId: string,
  tx: any,
  db: any,
  options: { preUserBudgets?: Record<string, number>; preTxSnapshot?: any } = {}
) {
  const amount = parsePositiveFinancialAmount(tx?.amount);
  const type = String(tx?.type || 'expense');
  const account = String(tx?.account || 'cash');
  const category = String(tx?.category || '');
  const subcategory = String(tx?.subcategory || '');
  const merchant = String(tx?.merchant || '');
  const operationId = String(tx?.operationId || transactionId);

  let notificationMsg = `تم تسجيل ${type === 'expense' ? 'مصروف' : 'دخل'} بقيمة ${amount} ₪`;
  if (account === 'debt') {
    notificationMsg += " (دين)";
  } else if (account === 'palPay') {
    notificationMsg += " (PalPay)";
  }
  if (category && category !== 'غير مصنف') {
    notificationMsg += ` [${category}]`;
  }
  if (tx?.necessity) {
    notificationMsg += ` - ${tx.necessity}`;
  }

  await addNotification(userId, notificationMsg, 'success', db, {
    idempotencyKey: `transaction-success:${operationId}`,
    transactionId,
    operationId,
    metadata: { amount, type, account, category, subcategory, merchant, transactionType: tx?.transactionType }
  });

  // Budget threshold warning check (80% / 100%)
  if (type === 'expense' && category && category !== 'غير مصنف') {
    try {
      const userBudgets = options.preUserBudgets || await getUserBudgets(userId, db);
      const budgetLimit = Number(userBudgets[category] || 0);
      if (!(budgetLimit > 0)) return;

      const txDate = new Date(tx?.date || new Date().toISOString());
      const safeTxDate = Number.isNaN(txDate.getTime()) ? new Date() : txDate;
      const thisMonth = safeTxDate.toISOString().slice(0, 7);
      let txSnapshot = options.preTxSnapshot;
      if (!txSnapshot) {
        const monthStart = `${thisMonth}-01T00:00:00.000Z`;
        const nextMonthDate = new Date(Date.UTC(safeTxDate.getUTCFullYear(), safeTxDate.getUTCMonth() + 1, 1));
        const nextMonthStart = `${nextMonthDate.toISOString().slice(0, 10)}T00:00:00.000Z`;
        txSnapshot = await db.collection('transactions')
          .where('userId', '==', userId)
          .where('date', '>=', monthStart)
          .where('date', '<', nextMonthStart)
          .where('category', '==', category)
          .get();
      }
      const monthExpenses = txSnapshot.docs
        .map((d: any) => d.data())
        .filter((item: any) => item.type === 'expense' && (item.date || '').startsWith(thisMonth) && item.category === category);

      const totalSpentForCat = monthExpenses.reduce((sum: number, item: any) => sum + (Number(item.amount) || 0), 0);
      const ratio = totalSpentForCat / budgetLimit;
      let alertPrefs = TREASURER_PROFILE_DEFAULTS.alertPreferences;
      try {
        const profileSnap = await db.collection('users').doc(userId).collection('treasurer').doc('profile').get();
        alertPrefs = normalizeTreasurerProfile(profileSnap.exists ? profileSnap.data() : {}).alertPreferences;
      } catch {}
      const warningRatio = Math.max(0.5, Math.min(0.99, Number(alertPrefs.budgetThresholdPct || 80) / 100));
      const criticalRatio = Math.max(warningRatio + 0.01, Math.min(1.5, Number(alertPrefs.criticalBudgetThresholdPct || 100) / 100));

      if (ratio >= criticalRatio) {
        await addNotification(
          userId,
          `⚠️ تنبيه ميزانية: تجاوزت سقف ميزانية [${category}] لهذا الشهر (${totalSpentForCat} ₪ من ${budgetLimit} ₪).`,
          'warning', db,
          {
            idempotencyKey: `advisor-budget-critical:${category}:${thisMonth}`,
            advisorAlert: true,
            advisorStatus: 'open',
            severity: 'critical',
            priority: 'high',
            category: 'budget_threshold',
            source: 'recordTransactionCommittedSideEffects',
            transactionId,
            operationId,
            metadata: { amount, category, budgetLimit, totalSpentForCat, ratio: roundFinancial(ratio), thisMonth },
            actions: [
              { id: 'review_budget', label: 'راجع الميزانية', type: 'review' },
              { id: 'pause_category_spending', label: 'أوقف الصرف على البند', type: 'behavior' },
              { id: 'resolve', label: 'تم التعامل', type: 'resolve' },
            ],
          }
        );
      } else if (ratio >= warningRatio) {
        await addNotification(
          userId,
          `⚠️ تنبيه ميزانية: اقتربت من سقف ميزانية [${category}] لهذا الشهر (وصلت ${Math.round(ratio * 100)}% - ${totalSpentForCat} ₪ من ${budgetLimit} ₪).`,
          'warning', db,
          {
            idempotencyKey: `advisor-budget-warning:${category}:${thisMonth}`,
            advisorAlert: true,
            advisorStatus: 'open',
            severity: 'warning',
            priority: 'medium',
            category: 'budget_threshold',
            source: 'recordTransactionCommittedSideEffects',
            transactionId,
            operationId,
            metadata: { amount, category, budgetLimit, totalSpentForCat, ratio: roundFinancial(ratio), thisMonth },
            actions: [
              { id: 'review_budget', label: 'راجع الميزانية', type: 'review' },
              { id: 'slow_down', label: 'خفّض الصرف', type: 'behavior' },
              { id: 'resolve', label: 'تم التعامل', type: 'resolve' },
            ],
          }
        );
      }
    } catch (budgetErr) {
      console.error("Budget check error:", budgetErr);
    }
  }
}

// V5: unified financial context used by the assistant before consequential decisions.
// It is on-demand only: no timers/polling. The transaction snapshot is reused for all calculations.
// V6 (MF-1): exclude commitments with status='paid' from due30 to prevent double subtraction.
function resolveSafeSpendingHorizon(args: any, now: Date) {
  const raw = normalizeArabicText(String(args?.period || args?.horizon || 'salary_cycle')).toLowerCase();
  const salaryCycle = getCurrentSalaryCycle(now);
  let period = 'salary_cycle';
  let label = salaryCycle.name || 'دورة الراتب الحالية';
  let end = new Date(salaryCycle.endExclusiveIso);

  if (args?.untilDate) {
    const explicit = new Date(String(args.untilDate));
    if (Number.isFinite(explicit.getTime())) {
      period = 'custom';
      label = `حتى ${explicit.toISOString().slice(0, 10)}`;
      explicit.setUTCHours(23, 59, 59, 999);
      end = explicit;
    }
  } else if (/today|اليوم|يوم/.test(raw)) {
    period = 'today';
    label = 'اليوم';
    end = new Date(now.getTime());
    end.setUTCHours(23, 59, 59, 999);
  } else if (/week|اسبوع|أسبوع|7/.test(raw)) {
    period = 'week';
    label = 'الأسبوع القادم';
    end = new Date(now.getTime() + 7 * 86400000);
  } else if (/30|month|شهر/.test(raw)) {
    period = 'next_30_days';
    label = 'الـ 30 يوم القادمة';
    end = new Date(now.getTime() + 30 * 86400000);
  }

  if (!Number.isFinite(end.getTime()) || end.getTime() <= now.getTime()) end = new Date(now.getTime() + 86400000);
  const daysRemaining = Math.max(1, Math.ceil((end.getTime() - now.getTime()) / 86400000));
  return { period, label, startIso: now.toISOString(), endIso: end.toISOString(), daysRemaining, salaryCycle };
}

function buildSafeSpendingAdvice(input: {
  status: string;
  deficitToProtected: number;
  cashFlowGap: number;
  safeToSpendToday: number;
  safeToSpendThisWeek: number;
  safeToSpendUntilHorizon: number;
  horizonLabel: string;
}) {
  if (input.status === 'critical') return `الوضع حرج: السيولة الحالية لا تغطي الالتزامات القريبة. تحتاج توفير ${input.cashFlowGap || input.deficitToProtected} ₪ قبل أي صرف إضافي.`;
  if (input.status === 'danger') return `الوضع ضاغط: لا يوجد مبلغ آمن للصرف قبل حماية الالتزامات والاحتياطي. العجز مقابل الحدود المحمية ${input.deficitToProtected} ₪.`;
  if (input.status === 'warning') return `الصرف لازم يكون مضبوط. الحد الآمن اليوم تقريباً ${input.safeToSpendToday} ₪، وخلال ${input.horizonLabel}: ${input.safeToSpendUntilHorizon} ₪.`;
  return `الوضع يسمح بصرف مضبوط. الحد الآمن اليوم تقريباً ${input.safeToSpendToday} ₪، وهذا الأسبوع ${input.safeToSpendThisWeek} ₪.`;
}

function normalizePaymentMatchText(value: any) {
  return normalizeArabicText(String(value || '')).toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
}

function textLooksRelatedForPayment(commitment: any, tx: any) {
  const commitmentText = normalizePaymentMatchText([commitment.title, commitment.name, commitment.category, commitment.merchant, commitment.description].filter(Boolean).join(' '));
  const transactionText = normalizePaymentMatchText([tx.title, tx.name, tx.category, tx.merchant, tx.description, tx.note, tx.notes].filter(Boolean).join(' '));
  if (!commitmentText || !transactionText) return false;
  if (transactionText.includes(commitmentText) || commitmentText.includes(transactionText)) return true;
  const commitmentWords = commitmentText.split(' ').filter((w: string) => w.length >= 3);
  return commitmentWords.some((word: string) => transactionText.includes(word));
}

function findImplicitCommitmentPayment(commitment: any, transactions: any[], salaryCycleStartIso: string, protectionEndIso: string) {
  const amount = parsePositiveFinancialAmount(commitment.amount);
  if (amount <= 0) return null;
  const start = auditAsDate(salaryCycleStartIso);
  const end = auditAsDate(protectionEndIso);
  return transactions.find((tx: any) => {
    if (String(tx.type || '').toLowerCase() !== 'expense') return false;
    if (tx.transactionType === 'CREDIT_PURCHASE') return false;
    const txDate = transactionAnalysisDate(tx);
    if (!txDate || (start && txDate < start) || (end && txDate > end)) return false;
    const txAmount = parsePositiveFinancialAmount(tx.amount);
    const amountTolerance = Math.max(2, amount * 0.08);
    if (Math.abs(txAmount - amount) > amountTolerance) return false;
    return textLooksRelatedForPayment(commitment, tx);
  }) || null;
}

export async function getSafeSpendingLimit(args: any, userId: string, token: string) {
  const adminDb = getDb(token);
  const now = args?.now ? new Date(String(args.now)) : new Date();
  const safeNow = Number.isFinite(now.getTime()) ? now : new Date();
  const horizon = resolveSafeSpendingHorizon(args, safeNow);
  const salaryCycleEnd = new Date(horizon.salaryCycle.endExclusiveIso);
  const protectionEndIso = ['today', 'week'].includes(horizon.period)
    ? horizon.salaryCycle.endExclusiveIso
    : horizon.endIso;
  const spendingPaceEnd = Number.isFinite(salaryCycleEnd.getTime()) && salaryCycleEnd.getTime() > safeNow.getTime()
    ? salaryCycleEnd
    : new Date(horizon.endIso);
  const spendingPaceDays = Math.max(1, Math.ceil((spendingPaceEnd.getTime() - safeNow.getTime()) / 86400000));
  const horizonAllowanceDays = horizon.period === 'salary_cycle'
    ? spendingPaceDays
    : Math.max(1, Math.min(horizon.daysRemaining, spendingPaceDays));
  const ctx: any = await getFinancialDecisionContext({}, userId, token);

  const [profileSnap, goalSnap, cycleTxResult] = await Promise.all([
    adminDb.collection('users').doc(userId).collection('treasurer').doc('profile').get().catch(() => ({ exists: false, data: () => ({}) })),
    adminDb.collection('users').doc(userId).collection('savingsGoals').limit(100).get().catch(() => ({ docs: [], partial: true })),
    queryTransactions({ period: 'current_salary_cycle', includeTransactions: true, limit: 500 }, userId, token).catch(() => ({ transactions: [], partial: true })),
  ]);

  const profile = normalizeTreasurerProfile((profileSnap as any).exists ? ((profileSnap as any).data() || {}) : {});
  const profileCompleteness = buildTreasurerProfileCompleteness(profile);
  const rawGoals = ((goalSnap as any).docs || []).map((d: any) => ({ id: d.id, ...d.data() }))
    .filter((goal: any) => !['completed', 'cancelled', 'archived'].includes(String(goal.status || 'active').toLowerCase()));
  const savingsPeriod = {
    startIso: horizon.salaryCycle.startIso,
    endExclusiveIso: horizon.salaryCycle.endExclusiveIso,
    label: horizon.salaryCycle.name,
  };
  let savingsContributionDocsRead = 0;
  const savingsGoalPlans: any[] = [];
  for (const goal of rawGoals) {
    let contributions: any[] = [];
    try {
      const contributionSnap = await adminDb.collection('users').doc(userId).collection('savingsGoals').doc(String(goal.id)).collection('contributions')
        .where('createdAt', '>=', savingsPeriod.startIso)
        .where('createdAt', '<', savingsPeriod.endExclusiveIso)
        .limit(100)
        .get();
      contributions = contributionSnap.docs.map((d: any) => ({ id: d.id, ...d.data() }));
      savingsContributionDocsRead += contributions.length;
    } catch {}
    const plan = buildSavingsGoalPlan({ goal, contributions, now: safeNow, period: savingsPeriod });
    const hasSavingsDeadline = /^\d{4}-\d{2}-\d{2}$/.test(String(goal.dueDate || ''));
    const storedMonthlyRequired = parsePositiveFinancialAmount(goal.monthlyRequired);
    const safeSpendingMonthlyRequired = roundMoney(hasSavingsDeadline ? Number(plan.monthlyRequired || 0) : storedMonthlyRequired);
    savingsGoalPlans.push({ ...plan, safeSpendingMonthlyRequired });
  }
  const savingsRequiredThisPeriod = roundMoney(savingsGoalPlans.reduce((sum: number, goal: any) => {
    return sum + Math.max(0, Number(goal.safeSpendingMonthlyRequired || 0) - Number(goal.monthlySavedAmount || 0));
  }, 0));

  const cycleTransactions = Array.isArray((cycleTxResult as any).transactions) ? (cycleTxResult as any).transactions : [];
  const implicitlyPaidCommitments: any[] = [];
  const activeCommitments = (ctx.commitments || []).filter((c: any) => {
    const status = String(c.status || 'pending').toLowerCase();
    if (status === 'paid' || status === 'cancelled') return false;
    if (!c.dueDate) return false;
    const dueDate = auditAsDate(c.dueDate);
    const dueWithinHorizon = dueDate ? dueDate.toISOString() <= protectionEndIso : String(c.dueDate || '') <= protectionEndIso;
    if (!dueWithinHorizon) return false;
    const implicitPayment = findImplicitCommitmentPayment(c, cycleTransactions, horizon.salaryCycle.startIso, protectionEndIso);
    if (implicitPayment) {
      implicitlyPaidCommitments.push({ id: c.id, title: c.title, amount: c.amount, paidByTransactionId: implicitPayment.id, paidByDate: implicitPayment.date || implicitPayment.localDay || implicitPayment.createdAt });
      return false;
    }
    return true;
  });
  const dueCommitments = roundMoney(activeCommitments.reduce((sum: number, c: any) => sum + parsePositiveFinancialAmount(c.amount), 0));
  const balances = ctx.balances || { cash: 0, palPay: 0, debt: 0, vault: 0, total: 0 };
  const liquidTotal = roundMoney(Number(balances.total || 0));
  const dailyExpenseAverage = roundMoney(Number(ctx.dailyExpenseAverage || 0));
  const strictness = normalizeTreasurerStrictness(args?.strictness || profile.strictness || 'balanced');
  const bufferDays = Math.max(
    strictness === 'strict' ? 7 : strictness === 'gentle' ? 2 : 3,
    Number(profile.criticalCoverageDays || 0) > 0 ? Math.min(Number(profile.criticalCoverageDays || 0), 14) : 0
  );
  const behaviorBuffer = roundMoney(dailyExpenseAverage * bufferDays);
  const explicitReserve = Math.max(
    parsePositiveFinancialAmount(args?.reserveTarget),
    parsePositiveFinancialAmount(profile.cashReserveTarget),
    parsePositiveFinancialAmount(profile.minimumCashFloor),
    parsePositiveFinancialAmount(profile.criticalLiquidityFloor)
  );
  // Do not reserve average spending as if it were a real obligation. The user's
  // safe cap should be based on the explicit critical floor they configured plus
  // unpaid due commitments and real active savings goals. Spending pace is used
  // for warnings/forecasts only, not as a hidden reserve that cuts salary in half.
  const reserveTarget = roundMoney(explicitReserve);
  const protectedTotal = roundMoney(dueCommitments + reserveTarget + savingsRequiredThisPeriod);
  const rawSafeToSpendUntilProtection = roundMoney(Math.max(0, liquidTotal - protectedTotal));
  const rawSafeToSpendToday = roundMoney(Math.max(0, rawSafeToSpendUntilProtection / spendingPaceDays));
  const profileDailyLimit = parsePositiveFinancialAmount(profile.dailySpendingLimit);
  const profileWeeklyLimit = parsePositiveFinancialAmount(profile.weeklySpendingLimit);
  const safeToSpendToday = roundMoney(profileDailyLimit > 0 ? Math.min(rawSafeToSpendToday, profileDailyLimit) : rawSafeToSpendToday);
  const safeToSpendUntilHorizon = roundMoney(Math.min(rawSafeToSpendUntilProtection, safeToSpendToday * horizonAllowanceDays));
  const safeToSpendThisWeek = roundMoney(Math.min(rawSafeToSpendUntilProtection, profileWeeklyLimit > 0 ? profileWeeklyLimit : safeToSpendToday * Math.min(7, spendingPaceDays)));
  const expectedRoutineSpend = roundMoney(dailyExpenseAverage * spendingPaceDays);
  const discretionaryAfterExpectedRoutine = roundMoney(liquidTotal - protectedTotal - expectedRoutineSpend);
  const deficitToProtected = roundMoney(Math.max(0, protectedTotal - liquidTotal));
  const cashFlowGap = roundMoney(Math.max(0, protectedTotal + expectedRoutineSpend - liquidTotal));
  const currentDebt = parsePositiveFinancialAmount(balances.debt);
  const salaryDebtLimit = parsePositiveFinancialAmount(profile.monthlySalary) > 0 && Number(profile.debtLimitRatio || 0) > 0
    ? roundMoney(parsePositiveFinancialAmount(profile.monthlySalary) * Number(profile.debtLimitRatio || 0))
    : 0;
  const explicitDebtLimit = parsePositiveFinancialAmount(profile.maxDebtBalance);
  const effectiveDebtLimit = roundMoney(Math.max(salaryDebtLimit, explicitDebtLimit));
  const debtOverLimit = effectiveDebtLimit > 0 && currentDebt > effectiveDebtLimit;

  let status = 'safe';
  if (liquidTotal <= 0 || liquidTotal < dueCommitments) status = 'critical';
  else if (deficitToProtected > 0 || debtOverLimit) status = 'danger';
  else if (discretionaryAfterExpectedRoutine < 0 || safeToSpendToday < Math.max(20, dailyExpenseAverage * 0.5)) status = 'warning';

  const warnings: string[] = [];
  if (dueCommitments > liquidTotal) warnings.push(`الالتزامات القريبة (${dueCommitments} ₪) أكبر من السيولة الحالية (${liquidTotal} ₪).`);
  if (deficitToProtected > 0) warnings.push(`السيولة ناقصة ${deficitToProtected} ₪ لحماية الالتزامات والاحتياطي والأهداف.`);
  if (debtOverLimit) warnings.push(`إجمالي الدين الحالي (${currentDebt} ₪) أعلى من حد الدين المحدد في ملف أمين الصندوق (${effectiveDebtLimit} ₪).`);
  if (profileDailyLimit > 0 && rawSafeToSpendToday > profileDailyLimit) warnings.push(`تم تقييد الصرف اليومي إلى ${profileDailyLimit} ₪ حسب ملف أمين الصندوق.`);
  if (profileWeeklyLimit > 0 && safeToSpendThisWeek >= profileWeeklyLimit) warnings.push(`تم تقييد الصرف الأسبوعي إلى ${profileWeeklyLimit} ₪ حسب ملف أمين الصندوق.`);
  if (profileCompleteness.status !== 'ready') warnings.push(`ملف أمين الصندوق مكتمل بنسبة ${profileCompleteness.score}%؛ دقة النصائح تتحسن عند استكمال البيانات الناقصة.`);
  if (discretionaryAfterExpectedRoutine < 0) warnings.push(`بعد نمط الصرف المعتاد يوجد عجز متوقع ${Math.abs(discretionaryAfterExpectedRoutine)} ₪ حتى ${horizon.label}.`);
  if (savingsRequiredThisPeriod > 0) warnings.push(`الأهداف النشطة تحتاج تقريباً ${savingsRequiredThisPeriod} ₪ هذا الشهر للبقاء على المسار.`);
  if (implicitlyPaidCommitments.length > 0) warnings.push(`تم تجاهل ${implicitlyPaidCommitments.length} التزام من الحجز لأنه يبدو مدفوعاً كعملية مصروف داخل دورة الراتب الحالية.`);

  const recommendations = (status === 'safe'
    ? ['حافظ على الصرف اليومي ضمن الحد الآمن ولا تلمس مبلغ الالتزامات أو الاحتياطي.', 'أي شراء كمالي كبير يفضّل فحصه بالسوق المحلي أولاً.', profileCompleteness.nextPrompt ? `لزيادة دقة المستشار: ${profileCompleteness.nextPrompt}` : '']
    : ['أوقف الكماليات مؤقتاً حتى تغطي الالتزامات والاحتياطي.', 'راجع الالتزامات القريبة، وحوّل أي فائض صغير للأهداف ذات الأولوية العالية.', profileCompleteness.nextPrompt ? `استكمل ملف أمين الصندوق: ${profileCompleteness.nextPrompt}` : '']).filter(Boolean);

  return {
    success: true,
    decision: status,
    message: buildSafeSpendingAdvice({ status, deficitToProtected, cashFlowGap, safeToSpendToday, safeToSpendThisWeek, safeToSpendUntilHorizon, horizonLabel: horizon.label }),
    safeSpending: {
      currency: profile.currency || 'ILS',
      horizon,
      safeToSpendToday,
      safeToSpendThisWeek,
      safeToSpendUntilHorizon,
      rawSafeToSpendToday,
      rawSafeToSpendUntilHorizon: rawSafeToSpendUntilProtection,
      rawSafeToSpendUntilProtection,
      protectionEndIso,
      spendingPaceDays,
      horizonAllowanceDays,
      discretionaryAfterExpectedRoutine,
      deficitToProtected,
      cashFlowGap,
    },
    breakdown: {
      balances,
      liquidTotal,
      dueCommitments,
      implicitlyPaidCommitments,
      reserveTarget,
      reserveSource: explicitReserve > 0 ? 'treasurer_profile_or_request' : 'none',
      behaviorBufferForForecastOnly: behaviorBuffer,
      savingsRequiredThisPeriod,
      protectedTotal,
      protectionEndIso,
      spendingPaceDays,
      horizonAllowanceDays,
      dailyExpenseAverage,
      expectedRoutineSpend,
      strictness,
      bufferDays,
      profileLimits: {
        minimumCashFloor: profile.minimumCashFloor,
        criticalLiquidityFloor: profile.criticalLiquidityFloor,
        criticalCoverageDays: profile.criticalCoverageDays,
        warningCoverageDays: profile.warningCoverageDays,
        dailySpendingLimit: profile.dailySpendingLimit,
        weeklySpendingLimit: profile.weeklySpendingLimit,
        debtLimitRatio: profile.debtLimitRatio,
        maxDebtBalance: profile.maxDebtBalance,
        effectiveDebtLimit,
        debtOverLimit,
      },
      profileCompleteness,
    },
    commitments: activeCommitments.slice(0, 10).map((c: any) => ({ id: c.id, title: c.title, amount: c.amount, dueDate: c.dueDate, category: c.category, status: c.status || 'pending' })),
    savingsGoals: savingsGoalPlans.slice(0, 10).map((g: any) => ({ id: g.id, name: g.name, remainingAmount: g.remainingAmount, monthlyRequired: g.monthlyRequired, priority: g.priority, dueDate: g.dueDate, alertLevel: g.alertLevel })),
    warnings,
    recommendations,
    confidence: ctx.confidence,
    partial: Boolean(ctx.partial || (goalSnap as any).partial),
    readEfficiency: { ...(ctx.readEfficiency || {}), treasurerProfileDocsRead: 1, savingsGoalLimit: 100, savingsGoalDocsRead: rawGoals.length, savingsContributionDocsRead },
  };
}

function normalizeGoalPriorityScore(value: any): number {
  const raw = normalizeArabicText(String(value || 'medium')).toLowerCase();
  const n = Number(value);
  if (Number.isFinite(n) && n > 0) return Math.max(1, Math.min(5, 6 - Math.round(n)));
  if (['critical', 'urgent', 'high', 'عالي', 'مهم', 'عاجل', 'حرج'].includes(raw)) return 5;
  if (['medium', 'متوسط', 'normal', 'عادي'].includes(raw)) return 3;
  if (['low', 'منخفض', 'خفيف'].includes(raw)) return 1;
  return 3;
}

function estimateGoalDelayDays(pressureAmount: number, monthlyRequired: number): number {
  const dailyRequired = monthlyRequired > 0 ? monthlyRequired / 30 : 0;
  if (dailyRequired <= 0 || pressureAmount <= 0) return 0;
  return Math.max(1, Math.min(365, Math.ceil(pressureAmount / dailyRequired)));
}

function goalImpactMessage(input: { decision: string; amount: number; topGoal?: any; delayDays: number; safeGap: number }) {
  if (input.decision === 'GOAL_AT_RISK') {
    return `هذا القرار يضغط أهدافك المالية. قد يؤخر ${input.topGoal?.name || input.topGoal?.title || 'أهم هدف'} حوالي ${input.delayDays} يوم، ويوجد تجاوز للحد الآمن بقيمة ${input.safeGap} ₪.`;
  }
  if (input.decision === 'GOAL_DELAY_WARNING') {
    return `العملية ممكنة لكنها قد تبطئ أهدافك. أكبر أثر متوقع على ${input.topGoal?.name || input.topGoal?.title || 'هدف مالي'} حوالي ${input.delayDays} يوم.`;
  }
  return `العملية لا تظهر أثراً خطيراً على أهدافك ضمن البيانات الحالية، بشرط الالتزام بالحد الآمن للصرف.`;
}

export async function assessFinancialGoalImpact(args: any, userId: string, token: string) {
  const adminDb = getDb(token);
  const amount = parsePositiveFinancialAmount(args?.amount ?? args?.expenseAmount ?? args?.price ?? args?.offeredPrice);
  if (amount <= 0) return { success: false, needsClarification: true, reason: 'INVALID_GOAL_IMPACT_AMOUNT', message: 'كم قيمة المصروف أو الشراء الذي تريد قياس أثره على الأهداف؟' };
  const now = args?.now ? new Date(String(args.now)) : new Date();
  const safeNow = Number.isFinite(now.getTime()) ? now : new Date();
  const category = String(args?.category || args?.item || args?.product || 'غير محدد');
  const necessity = String(args?.necessity || '');
  const safe = await getSafeSpendingLimit({ period: args?.period || 'salary_cycle' }, userId, token).catch((e: any) => ({ success: false, error: e?.message || String(e), safeSpending: {} }));
  const profileResult: any = await getTreasurerProfile({}, userId, token).catch(() => ({ profile: normalizeTreasurerProfile({}), completeness: buildTreasurerProfileCompleteness(normalizeTreasurerProfile({})) }));
  const profile = normalizeTreasurerProfile(profileResult.profile || {});
  const horizon = resolveSafeSpendingHorizon({ period: args?.period || 'salary_cycle' }, safeNow);
  const savingsPeriod = { startIso: horizon.salaryCycle.startIso, endExclusiveIso: horizon.salaryCycle.endExclusiveIso, label: horizon.salaryCycle.name };
  const goalSnap = await adminDb.collection('users').doc(userId).collection('savingsGoals').limit(100).get().catch(() => ({ docs: [], partial: true }));
  const activeGoals = ((goalSnap as any).docs || [])
    .map((d: any) => ({ id: d.id, ...d.data() }))
    .filter((goal: any) => !['completed', 'cancelled', 'archived'].includes(String(goal.status || 'active').toLowerCase()));

  let savingsContributionDocsRead = 0;
  const safeUntilHorizon = parsePositiveFinancialAmount((safe as any)?.safeSpending?.safeToSpendUntilHorizon);
  const safeToday = parsePositiveFinancialAmount((safe as any)?.safeSpending?.safeToSpendToday);
  const amountAboveSafe = roundMoney(Math.max(0, amount - safeUntilHorizon));
  const dailyPressure = roundMoney(Math.max(0, amount - safeToday));
  const restricted = normalizeTreasurerStringList(profile.restrictedCategories || []).map((c: string) => normalizeArabicText(c).toLowerCase());
  const isRestrictedCategory = restricted.some((c: string) => c && normalizeArabicText(category).toLowerCase().includes(c));
  const isDiscretionary = normalizeArabicText(necessity).includes('كمالي') || isRestrictedCategory;

  const impactedSavingsGoals: any[] = [];
  for (const goal of activeGoals) {
    let contributions: any[] = [];
    try {
      const contributionSnap = await adminDb.collection('users').doc(userId).collection('savingsGoals').doc(String(goal.id)).collection('contributions')
        .where('createdAt', '>=', savingsPeriod.startIso)
        .where('createdAt', '<', savingsPeriod.endExclusiveIso)
        .limit(100)
        .get();
      contributions = contributionSnap.docs.map((d: any) => ({ id: d.id, ...d.data() }));
      savingsContributionDocsRead += contributions.length;
    } catch {}
    const plan: any = buildSavingsGoalPlan({ goal, contributions, now: safeNow, period: savingsPeriod });
    const hasDeadline = /^\d{4}-\d{2}-\d{2}$/.test(String(goal.dueDate || ''));
    const monthlyRequired = roundMoney(hasDeadline ? Number(plan.monthlyRequired || 0) : parsePositiveFinancialAmount(goal.monthlyRequired));
    const monthlyGap = roundMoney(Math.max(0, monthlyRequired - Number(plan.monthlySavedAmount || 0)));
    const priorityScore = normalizeGoalPriorityScore(goal.priority);
    const goalPressure = roundMoney(Math.min(amount, Math.max(monthlyGap, amountAboveSafe, dailyPressure)));
    const delayDays = estimateGoalDelayDays(goalPressure, monthlyRequired);
    const threatensGoal = monthlyGap > 0 || ['critical', 'warning'].includes(String(plan.alertLevel || '')) || amountAboveSafe > 0;
    if (threatensGoal || delayDays > 0) {
      impactedSavingsGoals.push({
        id: goal.id,
        name: goal.name || 'هدف ادخار',
        priority: goal.priority || 'medium',
        priorityScore,
        targetAmount: plan.targetAmount,
        savedAmount: plan.savedAmount,
        remainingAmount: plan.remainingAmount,
        dueDate: goal.dueDate || '',
        alertLevel: plan.alertLevel,
        monthlyRequired,
        monthlySavedAmount: plan.monthlySavedAmount,
        monthlyGap,
        estimatedDelayDays: delayDays,
        compensationNeeded: goalPressure,
        message: delayDays > 0 ? `قد يتأخر الهدف حوالي ${delayDays} يوم إذا لم تعوض ${goalPressure} ₪.` : plan.alertMessage,
      });
    }
  }

  impactedSavingsGoals.sort((a: any, b: any) => b.priorityScore - a.priorityScore || b.monthlyGap - a.monthlyGap || b.estimatedDelayDays - a.estimatedDelayDays);
  const profileGoals = [...(profile.financialPriorities || []), ...(profile.financialGoals || [])].slice(0, 10).map((goal: any) => {
    const targetAmount = parsePositiveFinancialAmount(goal.targetAmount);
    const priorityScore = normalizeGoalPriorityScore(goal.priority);
    const hasDueDate = /^\d{4}-\d{2}-\d{2}$/.test(String(goal.dueDate || ''));
    const shouldEstimateGeneralGoalDelay = targetAmount > 0 && (hasDueDate || amountAboveSafe > 0 || dailyPressure > 0 || isDiscretionary);
    const delayDays = shouldEstimateGeneralGoalDelay ? estimateGoalDelayDays(Math.min(amount, targetAmount), Math.max(targetAmount / 6, 1)) : 0;
    return { title: goal.title || goal.name, priority: goal.priority, priorityScore, targetAmount, dueDate: goal.dueDate || '', estimatedDelayDays: delayDays, measurableImpact: shouldEstimateGeneralGoalDelay, notes: goal.notes || '' };
  }).filter((goal: any) => goal.title);

  const topGoal = impactedSavingsGoals[0] || profileGoals.sort((a: any, b: any) => b.priorityScore - a.priorityScore)[0];
  const maxDelayDays = Math.max(0, ...impactedSavingsGoals.map((g: any) => Number(g.estimatedDelayDays || 0)), ...profileGoals.map((g: any) => Number(g.estimatedDelayDays || 0)));
  const highPriorityThreat = impactedSavingsGoals.some((g: any) => g.priorityScore >= 5 && (g.monthlyGap > 0 || g.estimatedDelayDays >= 7));
  let decision = 'GOAL_SAFE';
  let severity = 'info';
  if (amountAboveSafe > 0 && (highPriorityThreat || isDiscretionary || ['critical', 'danger'].includes(String((safe as any)?.decision || '')))) {
    decision = 'GOAL_AT_RISK';
    severity = 'critical';
  } else if (maxDelayDays >= 7 || impactedSavingsGoals.some((g: any) => ['critical', 'warning'].includes(String(g.alertLevel || ''))) || (isDiscretionary && dailyPressure > 0)) {
    decision = 'GOAL_DELAY_WARNING';
    severity = 'warning';
  }
  const needsConfirmation = decision === 'GOAL_AT_RISK' && !parseBooleanLike(args?.riskConfirmed);
  const warnings: string[] = [];
  if (amountAboveSafe > 0) warnings.push(`المبلغ يتجاوز الحد الآمن المحمي للأهداف والالتزامات بـ ${amountAboveSafe} ₪.`);
  if (highPriorityThreat) warnings.push('يوجد هدف عالي الأولوية قد يتأثر بهذا القرار.');
  if (maxDelayDays >= 7) warnings.push(`أكبر تأخير تقديري على الأهداف حوالي ${maxDelayDays} يوم.`);
  if (isRestrictedCategory) warnings.push('هذا البند ضمن البنود المقيدة في ملف أمين الصندوق.');

  const result: any = {
    success: true,
    decision,
    severity,
    needsConfirmation,
    message: goalImpactMessage({ decision, amount, topGoal, delayDays: maxDelayDays, safeGap: amountAboveSafe }),
    goalImpact: {
      amount,
      category,
      necessity,
      isDiscretionary,
      isRestrictedCategory,
      safeToSpendToday: safeToday,
      safeToSpendUntilHorizon: safeUntilHorizon,
      amountAboveSafe,
      dailyPressure,
      maxEstimatedDelayDays: maxDelayDays,
    },
    impactedSavingsGoals: impactedSavingsGoals.slice(0, Math.max(1, Math.min(10, Number(args?.goalLimit) || 5))),
    profileGoals,
    warnings,
    recommendations: decision === 'GOAL_SAFE'
      ? ['تابع الهدف بدون تعويض إضافي حالياً.', 'ابقَ ضمن الحد الآمن للصرف.']
      : ['عوّض نفس قيمة المصروف في أقرب دخل أو خفّض بنداً كمالياً آخر.', 'إذا كان الهدف عالي الأولوية، أجّل الشراء أو خفّض المبلغ.'],
    profileCompleteness: profileResult.completeness,
    partial: Boolean((goalSnap as any).partial || (safe as any)?.partial),
    readEfficiency: { savingsGoalLimit: 100, savingsGoalDocsRead: activeGoals.length, savingsContributionDocsRead, safeSpendingPartial: Boolean((safe as any)?.partial) },
  };

  if (parseBooleanLike(args?.persistAlert) && ['critical', 'warning'].includes(severity)) {
    await addNotification(userId, `🎯 تأثير على الأهداف: ${result.message}`, 'warning', adminDb, {
      idempotencyKey: `advisor-goal-impact:${stableDocId(`${userId}:${amount}:${category}:${decision}:${topGoal?.id || topGoal?.title || ''}`)}`,
      advisorAlert: true,
      advisorStatus: 'open',
      severity,
      priority: severity === 'critical' ? 'high' : 'medium',
      category: 'goal_impact',
      source: 'assessFinancialGoalImpact',
      metadata: { amount, category, decision, topGoal, goalImpact: result.goalImpact },
      actions: [
        { id: 'compensate_goal', label: 'عوّض الهدف', type: 'behavior' },
        { id: 'reduce_spending', label: 'خفّض الصرف', type: 'behavior' },
        { id: 'snooze', label: 'ذكرني لاحقاً', type: 'snooze' },
      ],
    });
  }

  return result;
}

function normalizeFinancialScenarioType(value: any) {
  const raw = normalizeArabicText(String(value || 'expense')).toLowerCase();
  if (['income', 'دخل', 'راتب', 'ايراد', 'إيراد'].includes(raw)) return 'income';
  if (['debt_payment', 'pay_debt', 'سداد دين', 'سداد'].includes(raw)) return 'debt_payment';
  if (['savings_contribution', 'saving', 'ادخار', 'توفير'].includes(raw)) return 'savings_contribution';
  if (['transfer', 'تحويل'].includes(raw)) return 'transfer';
  return 'expense';
}

function normalizeFinancialScenarioFrequency(value: any) {
  const raw = normalizeArabicText(String(value || 'once')).toLowerCase();
  if (['daily', 'يومي', 'كل يوم'].includes(raw)) return 'daily';
  if (['weekly', 'اسبوعي', 'أسبوعي', 'كل اسبوع', 'كل أسبوع'].includes(raw)) return 'weekly';
  if (['monthly', 'شهري', 'كل شهر'].includes(raw)) return 'monthly';
  return 'once';
}

function financialScenarioOccurrenceCount(frequency: string, days: number, explicitCount: any) {
  const explicit = Number(explicitCount);
  if (Number.isFinite(explicit) && explicit > 0) return Math.max(1, Math.min(365, Math.round(explicit)));
  if (frequency === 'daily') return Math.max(1, Math.min(365, days));
  if (frequency === 'weekly') return Math.max(1, Math.min(52, Math.ceil(days / 7)));
  if (frequency === 'monthly') return Math.max(1, Math.min(12, Math.ceil(days / 30)));
  return 1;
}

function buildScenarioRecoveryPlan(input: { gap: number; days: number; weeklyGap: number; dailyExpenseAverage: number; category: string; scenarioType: string }) {
  const days = Math.max(1, input.days || 1);
  const weeks = Math.max(1, Math.ceil(days / 7));
  const dailyCutNeeded = roundMoney(input.gap / days);
  const weeklyCutNeeded = roundMoney(input.gap / weeks);
  const recommendations = input.gap <= 0
    ? ['لا تحتاج خطة تعويض خاصة لهذا السيناريو؛ حافظ على السقف اليومي فقط.']
    : [
        `عوّض ${input.gap} ₪ عبر تخفيض يومي يقارب ${dailyCutNeeded} ₪ حتى نهاية الأفق.`,
        `أو خفّض مصروفات أسبوعية بحوالي ${weeklyCutNeeded} ₪ لمدة ${weeks} أسبوع.`,
        input.scenarioType === 'expense' ? `ابدأ من بند ${input.category || 'الكماليات'} قبل المساس بالبنود المحمية.` : 'وجّه أي دخل إضافي أولاً لتغطية الفجوة ثم الأهداف.',
      ];
  return { gap: roundMoney(input.gap), days, weeks, dailyCutNeeded, weeklyCutNeeded, recommendations };
}

function buildScenarioMessage(input: { decision: string; scenarioLabel: string; amount: number; safeDelta: number; projectedAfter: number; horizonLabel: string }) {
  if (input.decision === 'SCENARIO_CRITICAL') return `سيناريو ${input.scenarioLabel} خطر: بعده ستحتاج تعويض ${Math.abs(input.safeDelta)} ₪ تقريباً لحماية الالتزامات والأهداف خلال ${input.horizonLabel}.`;
  if (input.decision === 'SCENARIO_WARNING') return `سيناريو ${input.scenarioLabel} ممكن لكن بحذر: يبقى هامش آمن ضعيف بعد العملية، والرصيد المتوقع ${input.projectedAfter} ₪.`;
  if (input.decision === 'SCENARIO_IMPROVES') return `سيناريو ${input.scenarioLabel} يحسن وضعك المالي ويزيد الهامش الآمن.`;
  return `سيناريو ${input.scenarioLabel} يبدو آمناً ضمن البيانات الحالية، مع الالتزام بسقف الصرف اليومي.`;
}

export async function simulateFinancialScenario(args: any, userId: string, token: string) {
  const adminDb = getDb(token);
  const amount = parsePositiveFinancialAmount(args?.amount ?? args?.expenseAmount ?? args?.incomeAmount ?? args?.price);
  if (amount <= 0) return { success: false, needsClarification: true, reason: 'INVALID_SCENARIO_AMOUNT', message: 'ما المبلغ الذي تريد محاكاته؟ مثال: لو صرفت 500 ₪.' };
  const now = args?.now ? new Date(String(args.now)) : new Date();
  const safeNow = Number.isFinite(now.getTime()) ? now : new Date();
  const scenarioType = normalizeFinancialScenarioType(args?.type || args?.scenarioType || args?.transactionType);
  const frequency = normalizeFinancialScenarioFrequency(args?.frequency || args?.repeat);
  const horizon = resolveSafeSpendingHorizon({ period: args?.period || args?.horizon || 'salary_cycle' }, safeNow);
  const horizonDays = Math.max(1, Math.min(365, Number(args?.horizonDays) || horizon.daysRemaining));
  const occurrenceCount = financialScenarioOccurrenceCount(frequency, horizonDays, args?.occurrences || args?.count);
  const totalScenarioAmount = roundMoney(amount * occurrenceCount);
  const category = String(args?.category || args?.item || args?.product || (scenarioType === 'income' ? 'دخل افتراضي' : 'مصروف افتراضي'));
  const scenarioLabel = String(args?.label || args?.name || category || 'سيناريو مالي');

  const [ctx, safe, profileResult] = await Promise.all([
    getFinancialDecisionContext({}, userId, token).catch((e: any) => ({ success: false, error: e?.message || String(e), balances: {} })),
    getSafeSpendingLimit({ period: args?.period || args?.horizon || 'salary_cycle' }, userId, token).catch((e: any) => ({ success: false, error: e?.message || String(e), safeSpending: {}, breakdown: {} })),
    getTreasurerProfile({}, userId, token).catch(() => ({ profile: normalizeTreasurerProfile({}), completeness: buildTreasurerProfileCompleteness(normalizeTreasurerProfile({})) })),
  ]);
  const profile = normalizeTreasurerProfile((profileResult as any).profile || {});
  const balances = (ctx as any).balances || (safe as any).breakdown?.balances || {};
  const currentLiquid = roundMoney(parsePositiveFinancialAmount((safe as any).breakdown?.liquidTotal ?? balances.total));
  const dailyExpenseAverage = roundMoney(Number((ctx as any).dailyExpenseAverage || (safe as any).breakdown?.dailyExpenseAverage || 0));
  const dailyIncomeAverage = roundMoney(Number((ctx as any).dailyIncomeAverage || 0));
  const dueCommitments = roundMoney(parsePositiveFinancialAmount((safe as any).breakdown?.dueCommitments ?? (ctx as any).dueCommitments30Days));
  const protectedTotal = roundMoney(parsePositiveFinancialAmount((safe as any).breakdown?.protectedTotal));
  const safeUntilHorizon = roundMoney(parsePositiveFinancialAmount((safe as any).safeSpending?.safeToSpendUntilHorizon));
  const safeToday = roundMoney(parsePositiveFinancialAmount((safe as any).safeSpending?.safeToSpendToday));
  const expectedRoutineSpend = roundMoney(dailyExpenseAverage * horizonDays);
  const expectedRoutineIncome = roundMoney(dailyIncomeAverage * horizonDays);

  const outflowTypes = ['expense', 'debt_payment', 'savings_contribution'];
  const totalOutflow = outflowTypes.includes(scenarioType) ? totalScenarioAmount : 0;
  const totalInflow = scenarioType === 'income' ? totalScenarioAmount : 0;
  const baselineProjectedBalance = roundMoney(currentLiquid + expectedRoutineIncome - expectedRoutineSpend - dueCommitments);
  const afterScenarioLiquid = roundMoney(currentLiquid + totalInflow - totalOutflow);
  const afterScenarioProjectedBalance = roundMoney(baselineProjectedBalance + totalInflow - totalOutflow);
  const afterScenarioSafeToSpend = roundMoney(safeUntilHorizon + totalInflow - totalOutflow);
  const reserveGapAfterScenario = roundMoney(Math.max(0, protectedTotal - afterScenarioLiquid));
  const cashFlowGapAfterScenario = roundMoney(Math.max(0, protectedTotal + expectedRoutineSpend - expectedRoutineIncome - afterScenarioLiquid));
  const conservativeShock = roundMoney(Math.max(dailyExpenseAverage * Math.min(7, horizonDays) * 0.25, parsePositiveFinancialAmount(profile.minimumCashFloor) * 0.05));
  const conservativeProjectedBalance = roundMoney(afterScenarioProjectedBalance - conservativeShock);

  const goalImpact: any = totalOutflow > 0
    ? await assessFinancialGoalImpact({ amount: totalOutflow, category, item: args?.item || args?.product || category, necessity: args?.necessity || '', period: args?.period || 'salary_cycle', goalLimit: 5, persistAlert: false }, userId, token).catch((e: any) => ({ success: false, error: e?.message || String(e) }))
    : null;

  let decision = 'SCENARIO_SAFE';
  let severity = 'info';
  if (scenarioType === 'income' && afterScenarioSafeToSpend > safeUntilHorizon) {
    decision = 'SCENARIO_IMPROVES';
    severity = 'info';
  }
  if (afterScenarioSafeToSpend < 0 || reserveGapAfterScenario > 0 || cashFlowGapAfterScenario > 0 || goalImpact?.decision === 'GOAL_AT_RISK') {
    decision = 'SCENARIO_CRITICAL';
    severity = 'critical';
  } else if (afterScenarioSafeToSpend < Math.max(20, safeToday) || conservativeProjectedBalance < 0 || goalImpact?.severity === 'warning' || ['critical', 'danger', 'warning'].includes(String((safe as any).decision || ''))) {
    decision = 'SCENARIO_WARNING';
    severity = 'warning';
  }

  const gapToRecover = roundMoney(Math.max(0, -afterScenarioSafeToSpend, reserveGapAfterScenario, cashFlowGapAfterScenario, goalImpact?.goalImpact?.amountAboveSafe || 0));
  const recoveryPlan = buildScenarioRecoveryPlan({ gap: gapToRecover, days: horizonDays, weeklyGap: 0, dailyExpenseAverage, category, scenarioType });
  const warnings: string[] = [];
  if (afterScenarioSafeToSpend < 0) warnings.push(`السيناريو يكسر الهامش الآمن بـ ${Math.abs(afterScenarioSafeToSpend)} ₪.`);
  if (reserveGapAfterScenario > 0) warnings.push(`بعد السيناريو يوجد نقص ${reserveGapAfterScenario} ₪ مقابل الحدود المحمية.`);
  if (cashFlowGapAfterScenario > 0) warnings.push(`بعد الصرف المعتاد والالتزامات يظهر عجز ${cashFlowGapAfterScenario} ₪.`);
  if (goalImpact?.severity === 'critical') warnings.push(`الأهداف: ${goalImpact.message}`);
  else if (goalImpact?.severity === 'warning') warnings.push(`تنبيه أهداف: ${goalImpact.message}`);

  const result: any = {
    success: true,
    decision,
    severity,
    needsConfirmation: decision === 'SCENARIO_CRITICAL' && !parseBooleanLike(args?.riskConfirmed),
    message: buildScenarioMessage({ decision, scenarioLabel, amount: totalScenarioAmount, safeDelta: afterScenarioSafeToSpend, projectedAfter: afterScenarioProjectedBalance, horizonLabel: horizon.label }),
    scenario: {
      label: scenarioLabel,
      type: scenarioType,
      category,
      amount,
      frequency,
      occurrenceCount,
      totalScenarioAmount,
      horizon: { ...horizon, daysRemaining: horizonDays },
    },
    baseline: {
      currentLiquid,
      safeToSpendToday: safeToday,
      safeToSpendUntilHorizon: safeUntilHorizon,
      projectedBalance: baselineProjectedBalance,
      expectedRoutineSpend,
      expectedRoutineIncome,
      dueCommitments,
      protectedTotal,
    },
    afterScenario: {
      liquid: afterScenarioLiquid,
      projectedBalance: afterScenarioProjectedBalance,
      safeToSpendUntilHorizon: afterScenarioSafeToSpend,
      reserveGap: reserveGapAfterScenario,
      cashFlowGap: cashFlowGapAfterScenario,
      conservativeProjectedBalance,
      conservativeShock,
    },
    calculationTrace: {
      formula: 'currentLiquid + expectedRoutineIncome - expectedRoutineSpend - dueCommitments +/- totalScenarioAmount',
      currentLiquid,
      expectedRoutineIncome,
      expectedRoutineSpend,
      dueCommitments,
      protectedTotal,
      safeUntilHorizon,
      totalScenarioAmount,
      afterScenarioSafeToSpend,
      horizonDays,
      dailyExpenseAverage,
      dailyIncomeAverage,
    },
    recoveryPlan,
    goalImpact,
    warnings,
    recommendations: severity === 'critical'
      ? ['لا تنفذ السيناريو قبل تعويض الفجوة أو تخفيض المبلغ.', ...recoveryPlan.recommendations]
      : severity === 'warning'
        ? ['يمكن التفكير بالسيناريو بحذر إذا التزمت بخطة التعويض.', ...recoveryPlan.recommendations]
        : ['السيناريو مقبول حالياً؛ حافظ على السقف اليومي وراجع الالتزامات قبل التنفيذ.'],
    profileCompleteness: (profileResult as any).completeness,
    partial: Boolean((ctx as any).partial || (safe as any).partial || goalImpact?.partial),
    readEfficiency: { financialContextPartial: Boolean((ctx as any).partial), safeSpendingPartial: Boolean((safe as any).partial), goalImpactPartial: Boolean(goalImpact?.partial) },
  };

  if (parseBooleanLike(args?.save)) {
    const scenarioId = stableDocId(`scenario:${userId}:${scenarioType}:${category}:${totalScenarioAmount}:${horizon.period}:${safeNow.toISOString().slice(0, 10)}`);
    await adminDb.collection('users').doc(userId).collection('advisorScenarios').doc(scenarioId).set({
      userId,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      ...result,
    }, { merge: true });
    result.savedScenarioId = scenarioId;
  }

  if (parseBooleanLike(args?.persistAlert) && ['critical', 'warning'].includes(severity)) {
    await addNotification(userId, `📈 سيناريو مالي: ${result.message}`, 'warning', adminDb, {
      idempotencyKey: `advisor-scenario:${stableDocId(`${userId}:${scenarioType}:${category}:${totalScenarioAmount}:${decision}`)}`,
      advisorAlert: true,
      advisorStatus: 'open',
      severity,
      priority: severity === 'critical' ? 'high' : 'medium',
      category: 'financial_scenario',
      source: 'simulateFinancialScenario',
      metadata: { scenario: result.scenario, afterScenario: result.afterScenario, recoveryPlan: result.recoveryPlan },
      actions: [
        { id: 'reduce_amount', label: 'خفّض المبلغ', type: 'behavior' },
        { id: 'recovery_plan', label: 'خطة تعويض', type: 'review' },
        { id: 'snooze', label: 'ذكرني لاحقاً', type: 'snooze' },
      ],
    });
  }

  return result;
}

export async function getFinancialScenarios(args: any, userId: string, token: string) {
  const adminDb = getDb(token);
  const limit = Math.max(1, Math.min(50, Number(args?.limit) || 10));
  const snap = await adminDb.collection('users').doc(userId).collection('advisorScenarios')
    .orderBy('createdAt', 'desc')
    .limit(limit)
    .get();
  const scenarios = snap.docs.map((d: any) => ({ id: d.id, ...d.data() }));
  return { success: true, scenarios, count: scenarios.length, limit, partial: Boolean((snap as any).partial || scenarios.length >= limit), readEfficiency: { advisorScenarioLimit: limit, docsRead: snap.docs.length } };
}

function resolveHabitAnalysisWindow(args: any, now: Date) {
  const raw = normalizeArabicText(String(args?.window || args?.period || 'last_30_days')).toLowerCase();
  let days = Math.max(7, Math.min(180, Number(args?.days || args?.windowDays) || 30));
  if (/7|week|اسبوع|أسبوع/.test(raw)) days = 7;
  if (/14|اسبوعين|أسبوعين/.test(raw)) days = 14;
  if (/90|quarter|ربع/.test(raw)) days = 90;
  if (/salary|راتب|دورة/.test(raw)) {
    const cycle = getCurrentSalaryCycle(now);
    const start = new Date(cycle.startIso);
    const end = new Date(Math.min(now.getTime(), new Date(cycle.endExclusiveIso).getTime()));
    const spanDays = Math.max(7, Math.ceil((end.getTime() - start.getTime()) / 86400000));
    const prevEnd = start;
    const prevStart = new Date(prevEnd.getTime() - spanDays * 86400000);
    return { key: 'salary_cycle', label: cycle.name || 'دورة الراتب الحالية', start, end, days: spanDays, previousStart: prevStart, previousEnd: prevEnd };
  }
  const end = new Date(now.getTime());
  const start = new Date(end.getTime() - days * 86400000);
  const previousEnd = start;
  const previousStart = new Date(previousEnd.getTime() - days * 86400000);
  return { key: `last_${days}_days`, label: `آخر ${days} يوم`, start, end, days, previousStart, previousEnd };
}

function habitDayName(date: Date) {
  return ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'][date.getUTCDay()] || 'غير محدد';
}

function habitBucketKey(value: any, fallback = 'غير محدد') {
  const text = String(value || '').trim();
  return text || fallback;
}

function incrementHabitBucket(map: Record<string, any>, key: string, amount: number, tx: any) {
  const bucketKey = habitBucketKey(key);
  const bucket = map[bucketKey] || { key: bucketKey, total: 0, count: 0, sampleIds: [] as string[] };
  bucket.total = roundMoney(bucket.total + amount);
  bucket.count += 1;
  if (tx?.id && bucket.sampleIds.length < 8) bucket.sampleIds.push(tx.id);
  map[bucketKey] = bucket;
}

function transactionAnalysisDate(tx: any): Date | null {
  const candidates = [tx?.date, tx?.localDay, tx?.localDate, tx?.dateKey, tx?.localDayKey, tx?.transactionDate, tx?.createdAt];
  for (const candidate of candidates) {
    const parsed = auditAsDate(candidate) || parseDateLike(candidate);
    if (parsed && Number.isFinite(parsed.getTime())) return parsed;
  }
  const fallbackKey = transactionDateKey(tx);
  const fallback = parseDateLike(fallbackKey) || auditAsDate(fallbackKey);
  return fallback && Number.isFinite(fallback.getTime()) ? fallback : null;
}

function habitTransactionKind(tx: any): 'expense' | 'income' | 'other' {
  const type = normalizeArabicText(String(tx?.type || '')).toLowerCase();
  const transactionType = String(tx?.transactionType || tx?.kind || '').toUpperCase();
  if (['income', 'دخل', 'ايراد', 'إيراد'].includes(type) || transactionType === 'INCOME' || transactionType === 'DEBT_BORROWING') return 'income';
  if (['expense', 'مصروف', 'صرف', 'مشتريات'].includes(type) || transactionType === 'EXPENSE' || transactionType === 'CREDIT_PURCHASE') return 'expense';
  return 'other';
}

function mergeHabitTransactions(primary: any[], extra: any[]) {
  const map = new Map<string, any>();
  for (const tx of [...(primary || []), ...(extra || [])]) {
    const id = String(tx?.id || tx?.operationId || `${tx?.date || tx?.localDay || tx?.createdAt || ''}:${tx?.amount || ''}:${tx?.category || ''}:${tx?.merchant || ''}:${map.size}`);
    if (!map.has(id)) map.set(id, tx);
  }
  return Array.from(map.values());
}

function summarizeHabitTransactions(transactions: any[], start: Date, end: Date) {
  const summary: any = {
    startIso: start.toISOString(),
    endIso: end.toISOString(),
    expenseTotal: 0,
    incomeTotal: 0,
    expenseCount: 0,
    incomeCount: 0,
    byCategory: {},
    byMerchant: {},
    byDay: {},
    byAccount: {},
    smallPurchases: { total: 0, count: 0, sampleIds: [] as string[] },
  };
  for (const tx of transactions) {
    const date = transactionAnalysisDate(tx);
    if (!date || date < start || date >= end) continue;
    const amount = parsePositiveFinancialAmount(tx.amount);
    if (amount <= 0) continue;
    const kind = habitTransactionKind(tx);
    if (kind === 'income') {
      summary.incomeTotal = roundMoney(summary.incomeTotal + amount);
      summary.incomeCount += 1;
      continue;
    }
    if (kind !== 'expense') continue;
    summary.expenseTotal = roundMoney(summary.expenseTotal + amount);
    summary.expenseCount += 1;
    incrementHabitBucket(summary.byCategory, habitBucketKey(tx.category), amount, tx);
    incrementHabitBucket(summary.byMerchant, habitBucketKey(tx.merchant || tx.beneficiary || tx.purchaseItem || tx.notes), amount, tx);
    incrementHabitBucket(summary.byDay, habitDayName(date), amount, tx);
    incrementHabitBucket(summary.byAccount, habitBucketKey(tx.account), amount, tx);
    if (amount <= 50) {
      summary.smallPurchases.total = roundMoney(summary.smallPurchases.total + amount);
      summary.smallPurchases.count += 1;
      if (tx.id && summary.smallPurchases.sampleIds.length < 12) summary.smallPurchases.sampleIds.push(tx.id);
    }
  }
  for (const field of ['byCategory', 'byMerchant', 'byDay', 'byAccount']) {
    summary[field] = Object.values(summary[field]).sort((a: any, b: any) => b.total - a.total || b.count - a.count).slice(0, 20);
  }
  return summary;
}

function habitBucketTotal(summary: any, field: string, key: string) {
  const arr = Array.isArray(summary?.[field]) ? summary[field] : [];
  const found = arr.find((item: any) => item.key === key);
  return found ? parsePositiveFinancialAmount(found.total) : 0;
}

function addHabitInsight(insights: any[], insight: any) {
  const exists = insights.some((i: any) => i.key === insight.key);
  if (!exists) insights.push({ ...insight, createdAt: new Date().toISOString() });
}

function buildFinancialHabitInsights(current: any, previous: any, profile: any, args: any) {
  const insights: any[] = [];
  const minAmount = Math.max(50, parsePositiveFinancialAmount(args?.minInsightAmount) || 100);
  const spikePct = Math.max(20, Math.min(300, Number(args?.spikePct) || 35));
  const restricted = normalizeTreasurerStringList(profile.restrictedCategories || []).map((c: string) => normalizeArabicText(c).toLowerCase());

  for (const cat of (current.byCategory || []).slice(0, 8)) {
    const prev = habitBucketTotal(previous, 'byCategory', cat.key);
    const increase = roundMoney(cat.total - prev);
    const pct = prev > 0 ? Math.round((increase / prev) * 100) : (cat.total >= minAmount ? 100 : 0);
    const isRestricted = restricted.some((r: string) => r && normalizeArabicText(cat.key).toLowerCase().includes(r));
    if (cat.total >= minAmount && (pct >= spikePct || isRestricted)) {
      addHabitInsight(insights, {
        key: `category_spike:${cat.key}`,
        type: 'category_spike',
        severity: pct >= 100 || isRestricted ? 'warning' : 'info',
        title: `ارتفاع بند ${cat.key}`,
        message: prev > 0 ? `صرفك على ${cat.key} زاد ${pct}% مقارنة بالفترة السابقة.` : `ظهر صرف واضح على ${cat.key} بقيمة ${cat.total} ₪ بدون نمط سابق كافٍ.`,
        evidence: { currentTotal: cat.total, previousTotal: prev, increase, pct, count: cat.count, sampleIds: cat.sampleIds },
        recommendations: [`ضع سقفاً مؤقتاً لبند ${cat.key}.`, 'راجع آخر العمليات الصغيرة داخل هذا البند قبل آخر الأسبوع.'],
      });
    }
  }

  for (const merchant of (current.byMerchant || []).filter((m: any) => m.key !== 'غير محدد').slice(0, 8)) {
    const prev = habitBucketTotal(previous, 'byMerchant', merchant.key);
    const increase = roundMoney(merchant.total - prev);
    const pct = prev > 0 ? Math.round((increase / prev) * 100) : (merchant.total >= minAmount ? 100 : 0);
    if (merchant.total >= minAmount && pct >= spikePct && merchant.count >= 2) {
      addHabitInsight(insights, {
        key: `merchant_spike:${merchant.key}`,
        type: 'merchant_spike',
        severity: merchant.total >= 250 || pct >= 100 ? 'warning' : 'info',
        title: `زيادة عند ${merchant.key}`,
        message: `الصرف المرتبط بـ ${merchant.key} وصل ${merchant.total} ₪ (${merchant.count} مرات)، بزيادة ${pct}% عن الفترة السابقة.`,
        evidence: { currentTotal: merchant.total, previousTotal: prev, increase, pct, count: merchant.count, sampleIds: merchant.sampleIds },
        recommendations: ['حدد هل هذا تكرار ضروري أم عادة صرف يمكن تخفيفها.', 'لو كان اشتراكاً، حوّله إلى التزام متكرر.'],
      });
    }
  }

  const smallShare = current.expenseTotal > 0 ? Math.round((current.smallPurchases.total / current.expenseTotal) * 100) : 0;
  const previousSmallTotal = parsePositiveFinancialAmount(previous.smallPurchases?.total);
  const smallIncreasePct = previousSmallTotal > 0 ? Math.round(((current.smallPurchases.total - previousSmallTotal) / previousSmallTotal) * 100) : 0;
  if (current.smallPurchases.count >= 6 && current.smallPurchases.total >= minAmount && (smallShare >= 20 || smallIncreasePct >= spikePct)) {
    addHabitInsight(insights, {
      key: 'small_purchase_accumulation',
      type: 'small_purchase_accumulation',
      severity: smallShare >= 35 || current.smallPurchases.total >= 300 ? 'warning' : 'info',
      title: 'المصاريف الصغيرة تتراكم',
      message: `لديك ${current.smallPurchases.count} مصروف صغير بإجمالي ${current.smallPurchases.total} ₪، وهذا يمثل ${smallShare}% من صرف الفترة.`,
      evidence: { smallPurchases: current.smallPurchases, previousSmallTotal, smallShare, smallIncreasePct },
      recommendations: ['اجمع المصاريف الصغيرة في سقف يومي واحد.', 'أوقف المصروفات الصغيرة غير الضرورية يومين لاختبار الفرق.'],
    });
  }

  const topDay = (current.byDay || [])[0];
  if (topDay && current.expenseTotal > 0) {
    const dayShare = Math.round((topDay.total / current.expenseTotal) * 100);
    const prevDayTotal = habitBucketTotal(previous, 'byDay', topDay.key);
    const dayIncreasePct = prevDayTotal > 0 ? Math.round(((topDay.total - prevDayTotal) / prevDayTotal) * 100) : 0;
    if (topDay.total >= minAmount && (dayShare >= 30 || dayIncreasePct >= 50)) {
      addHabitInsight(insights, {
        key: `day_risk:${topDay.key}`,
        type: 'day_risk',
        severity: dayShare >= 45 ? 'warning' : 'info',
        title: `${topDay.key} يوم صرف مرتفع`,
        message: `${topDay.key} وحده أخذ ${dayShare}% من صرف الفترة (${topDay.total} ₪).`,
        evidence: { day: topDay.key, total: topDay.total, count: topDay.count, share: dayShare, previousTotal: prevDayTotal, dayIncreasePct },
        recommendations: [`ضع حد صرف خاص ليوم ${topDay.key}.`, 'راجع هل هذا اليوم مرتبط بمشتريات أسبوعية أو خروج متكرر.'],
      });
    }
  }

  const debtTotal = habitBucketTotal(current, 'byAccount', 'debt');
  const previousDebtTotal = habitBucketTotal(previous, 'byAccount', 'debt');
  const debtPct = previousDebtTotal > 0 ? Math.round(((debtTotal - previousDebtTotal) / previousDebtTotal) * 100) : (debtTotal > 0 ? 100 : 0);
  if (debtTotal >= minAmount && (debtPct >= spikePct || debtTotal >= Math.max(200, minAmount))) {
    addHabitInsight(insights, {
      key: 'debt_usage_drift',
      type: 'debt_usage_drift',
      severity: debtTotal >= 500 || debtPct >= 100 ? 'warning' : 'info',
      title: 'زيادة استخدام الدين',
      message: `الصرف على الدين في الفترة الحالية وصل ${debtTotal} ₪، بزيادة ${debtPct}% عن الفترة السابقة.`,
      evidence: { currentDebtSpend: debtTotal, previousDebtSpend: previousDebtTotal, debtPct },
      recommendations: ['أوقف الشراء بالدين مؤقتاً إلا للضرورة.', 'حوّل جزءاً من أي فائض لسداد الدين قبل الكماليات.'],
    });
  }

  if (!insights.length && current.expenseCount > 0) {
    addHabitInsight(insights, {
      key: 'habits_stable',
      type: 'stable',
      severity: 'info',
      title: 'النمط مستقر نسبياً',
      message: 'لم يظهر ارتفاع حاد في بند أو تاجر أو يوم محدد ضمن القراءة الحالية.',
      evidence: { currentExpenseTotal: current.expenseTotal, previousExpenseTotal: previous.expenseTotal, currentExpenseCount: current.expenseCount },
      recommendations: ['استمر بمتابعة الحد الآمن اليومي.', 'أعد التحليل بعد عدة عمليات جديدة.'],
    });
  }
  return insights.sort((a: any, b: any) => ({ critical: 3, warning: 2, info: 1 } as any)[b.severity] - ({ critical: 3, warning: 2, info: 1 } as any)[a.severity]);
}

export async function analyzeFinancialHabits(args: any, userId: string, token: string) {
  const adminDb = getDb(token);
  const now = args?.now ? new Date(String(args.now)) : new Date();
  const safeNow = Number.isFinite(now.getTime()) ? now : new Date();
  const window = resolveHabitAnalysisWindow(args || {}, safeNow);
  const limit = Math.max(100, Math.min(1500, Number(args?.limit) || 800));
  let transactions: any[] = [];
  let readSource = 'salary_cycle_plus_date_desc';
  let partial = false;
  try {
    const [cycleResult, previousCycleResult, dateSnap] = await Promise.all([
      queryTransactions({ period: 'current_salary_cycle', includeTransactions: true, limit }, userId, token)
        .catch((err: any) => ({ success: false, transactions: [], partial: true, error: err?.message || String(err) })),
      queryTransactions({ period: 'previous_salary_cycle', includeTransactions: true, limit }, userId, token)
        .catch((err: any) => ({ success: false, transactions: [], partial: true, error: err?.message || String(err) })),
      adminDb.collection('transactions')
        .where('userId', '==', userId)
        .orderBy('date', 'desc')
        .limit(limit)
        .get()
        .catch((err: any) => ({ docs: [], partial: true, error: err })),
    ]);
    const cycleTransactions = Array.isArray((cycleResult as any).transactions) ? (cycleResult as any).transactions : [];
    const previousCycleTransactions = Array.isArray((previousCycleResult as any).transactions) ? (previousCycleResult as any).transactions : [];
    const dateTransactions = ((dateSnap as any).docs || []).map((d: any) => ({ id: d.id, ...d.data() }));
    transactions = mergeHabitTransactions(mergeHabitTransactions(cycleTransactions, previousCycleTransactions), dateTransactions);
    partial = Boolean((cycleResult as any).partial || (previousCycleResult as any).partial || (dateSnap as any).partial || transactions.length >= limit);
    if (transactions.length === 0) throw new Error('NO_HABIT_TRANSACTIONS_FROM_PRIMARY_READS');
  } catch (err: any) {
    readSource = 'userId_bounded_fallback';
    const snap = await adminDb.collection('transactions')
      .where('userId', '==', userId)
      .limit(limit)
      .get();
    transactions = snap.docs.map((d: any) => ({ id: d.id, ...d.data() }));
    partial = true;
  }
  const profileResult: any = await getTreasurerProfile({}, userId, token).catch(() => ({ profile: normalizeTreasurerProfile({}), completeness: buildTreasurerProfileCompleteness(normalizeTreasurerProfile({})) }));
  const profile = normalizeTreasurerProfile(profileResult.profile || {});
  const current = summarizeHabitTransactions(transactions, window.start, window.end);
  const previous = summarizeHabitTransactions(transactions, window.previousStart, window.previousEnd);
  const readDiagnostics = {
    loadedTransactions: transactions.length,
    readableDateTransactions: transactions.filter((tx: any) => Boolean(transactionAnalysisDate(tx))).length,
    expenseLikeTransactions: transactions.filter((tx: any) => habitTransactionKind(tx) === 'expense').length,
    currentWindowExpenseCount: current.expenseCount,
    previousWindowExpenseCount: previous.expenseCount,
    windowStartIso: window.start.toISOString(),
    windowEndIso: window.end.toISOString(),
    readSource,
  };
  const insights = buildFinancialHabitInsights(current, previous, profile, args || {}).slice(0, Math.max(1, Math.min(20, Number(args?.insightLimit) || 8)));
  const warningCount = insights.filter((i: any) => i.severity === 'warning').length;
  const infoPatternCount = insights.filter((i: any) => i.severity === 'info' && i.type !== 'stable').length;
  const noCurrentExpenses = current.expenseCount === 0 || current.expenseTotal <= 0;
  const score = noCurrentExpenses
    ? Math.max(25, Math.min(60, 55 - (partial ? 10 : 0)))
    : Math.max(0, Math.min(100, 100 - warningCount * 18 - infoPatternCount * 6 - (partial ? 5 : 0)));
  const status = noCurrentExpenses ? 'insufficient_data' : warningCount >= 3 ? 'habit_risk' : warningCount > 0 || infoPatternCount >= 2 ? 'watch' : 'stable';
  const delta = roundMoney(current.expenseTotal - previous.expenseTotal);
  const deltaPct = previous.expenseTotal > 0 ? Math.round((delta / previous.expenseTotal) * 100) : (current.expenseTotal > 0 ? 100 : 0);
  const result: any = {
    success: true,
    score,
    status,
    message: status === 'insufficient_data'
      ? 'لا توجد مصروفات مقروءة في هذه الفترة، لذلك لا أستطيع الحكم على العادات بعد. جرّب فترة أطول أو راجع تواريخ العمليات.'
      : status === 'habit_risk'
        ? 'هناك أكثر من نمط صرف يحتاج ضبطاً هذا الأسبوع/الشهر.'
        : status === 'watch'
          ? 'يوجد نمط أو أكثر يستحق المتابعة قبل أن يتحول لمشكلة.'
          : 'عادات الصرف مستقرة نسبياً ضمن البيانات الحالية.',
    window: { key: window.key, label: window.label, days: window.days, startIso: window.start.toISOString(), endIso: window.end.toISOString(), previousStartIso: window.previousStart.toISOString(), previousEndIso: window.previousEnd.toISOString() },
    totals: { currentExpense: current.expenseTotal, previousExpense: previous.expenseTotal, delta, deltaPct, currentIncome: current.incomeTotal, previousIncome: previous.incomeTotal },
    current,
    previous,
    insights,
    recommendations: insights.slice(0, 3).flatMap((i: any) => i.recommendations || []).slice(0, 5),
    profileCompleteness: profileResult.completeness,
    partial,
    readEfficiency: { transactionDocsRead: transactions.length, transactionLimit: limit, readSource },
  };

  if (parseBooleanLike(args?.save)) {
    const reportId = stableDocId(`habit-report:${userId}:${window.key}:${safeNow.toISOString().slice(0, 10)}`);
    await adminDb.collection('users').doc(userId).collection('advisorHabitReports').doc(reportId).set({ userId, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), ...result }, { merge: true });
    result.savedReportId = reportId;
  }

  if (parseBooleanLike(args?.persistAlerts)) {
    for (const insight of insights.filter((i: any) => i.severity === 'warning').slice(0, 5)) {
      await addNotification(userId, `📊 نمط مالي: ${insight.message}`, 'warning', adminDb, {
        idempotencyKey: `advisor-habit-pattern:${window.key}:${insight.key}`,
        advisorAlert: true,
        advisorStatus: 'open',
        severity: 'warning',
        priority: 'medium',
        category: 'habit_pattern',
        source: 'analyzeFinancialHabits',
        metadata: { window: result.window, insight },
        actions: [
          { id: 'set_limit', label: 'ضع سقفاً', type: 'behavior' },
          { id: 'review_transactions', label: 'راجع العمليات', type: 'review' },
          { id: 'snooze', label: 'ذكرني لاحقاً', type: 'snooze' },
        ],
      });
    }
  }

  return result;
}

export async function getFinancialHabitReports(args: any, userId: string, token: string) {
  const adminDb = getDb(token);
  const limit = Math.max(1, Math.min(50, Number(args?.limit) || 10));
  const snap = await adminDb.collection('users').doc(userId).collection('advisorHabitReports')
    .orderBy('createdAt', 'desc')
    .limit(limit)
    .get();
  const reports = snap.docs.map((d: any) => ({ id: d.id, ...d.data() }));
  return { success: true, reports, count: reports.length, limit, partial: Boolean((snap as any).partial || reports.length >= limit), readEfficiency: { advisorHabitReportLimit: limit, docsRead: snap.docs.length } };
}

function normalizeWeeklyRecommendationType(value: any) {
  const raw = normalizeArabicText(String(value || 'weekly')).toLowerCase();
  if (/recovery|انقاذ|إنقاذ|تعويض/.test(raw)) return 'recovery';
  if (/saving|ادخار|توفير|هدف/.test(raw)) return 'savings_growth';
  if (/debt|دين|ديون/.test(raw)) return 'debt_control';
  return 'weekly';
}

function weeklyRecommendationPriorityRank(value: any) {
  const raw = String(value || 'medium').toLowerCase();
  if (raw === 'critical') return 4;
  if (raw === 'high') return 3;
  if (raw === 'medium') return 2;
  if (raw === 'low') return 1;
  return 0;
}

function addWeeklyRecommendation(actions: any[], action: any) {
  const id = action.id || stableDocId(`weekly-action:${action.type}:${action.title}:${action.suggestedAmount || 0}`);
  if (actions.some((item: any) => item.id === id)) return;
  actions.push({
    id,
    type: action.type || 'review',
    title: action.title || 'توصية أسبوعية',
    message: action.message || '',
    suggestedAmount: roundMoney(parsePositiveFinancialAmount(action.suggestedAmount)),
    priority: action.priority || 'medium',
    severity: action.severity || 'info',
    source: action.source || 'weekly_recommendation_engine',
    relatedIds: Array.isArray(action.relatedIds) ? action.relatedIds.slice(0, 20) : [],
    evidence: action.evidence || {},
    createdAt: new Date().toISOString(),
  });
}

function extractWeeklyActionBuckets(actions: any[]) {
  const sorted = [...actions].sort((a: any, b: any) => weeklyRecommendationPriorityRank(b.priority) - weeklyRecommendationPriorityRank(a.priority) || parsePositiveFinancialAmount(b.suggestedAmount) - parsePositiveFinancialAmount(a.suggestedAmount));
  return {
    stop: sorted.filter((a: any) => a.type === 'stop').slice(0, 3),
    reduce: sorted.filter((a: any) => a.type === 'reduce').slice(0, 5),
    payDebt: sorted.filter((a: any) => a.type === 'pay_debt').slice(0, 3),
    saveGoals: sorted.filter((a: any) => a.type === 'save_goal').slice(0, 3),
    commitments: sorted.filter((a: any) => a.type === 'pay_commitment' || a.type === 'schedule_commitment').slice(0, 5),
    review: sorted.filter((a: any) => !['stop', 'reduce', 'pay_debt', 'save_goal', 'pay_commitment', 'schedule_commitment'].includes(a.type)).slice(0, 5),
    all: sorted,
  };
}

function buildWeeklyRecommendationMessage(status: string, summary: any) {
  if (status === 'weekly_recovery') return `هذا الأسبوع يحتاج ضبط قوي: أولوية الخطة تعويض ${summary.requiredRecovery || 0} ₪ وحماية الالتزامات والأهداف.`;
  if (status === 'weekly_watch') return `هذا الأسبوع يحتاج مراقبة: يوجد ${summary.warningActions || 0} توصية تحذيرية لتخفيف الضغط قبل نهاية الأسبوع.`;
  if (status === 'weekly_growth') return `هذا الأسبوع مناسب لتحسين الوضع: يمكن توجيه مبلغ مدروس للأهداف أو الدين بدون ضغط واضح.`;
  return 'خطة الأسبوع مستقرة: حافظ على السقف اليومي وراجع الالتزامات القريبة.';
}

export async function generateWeeklyFinancialRecommendations(args: any, userId: string, token: string) {
  const adminDb = getDb(token);
  const now = args?.now ? new Date(String(args.now)) : new Date();
  const safeNow = Number.isFinite(now.getTime()) ? now : new Date();
  const planType = normalizeWeeklyRecommendationType(args?.type || args?.focus);
  const weekHorizon = resolveSafeSpendingHorizon({ period: 'week' }, safeNow);
  const planKey = `${safeNow.toISOString().slice(0, 10)}:${weekHorizon.endIso.slice(0, 10)}:${planType}`;

  const [profileResult, safe, habits, goalsResult, recurringReview, recurringDetection, alertsResult] = await Promise.all([
    getTreasurerProfile({}, userId, token).catch(() => ({ profile: normalizeTreasurerProfile({}), completeness: buildTreasurerProfileCompleteness(normalizeTreasurerProfile({})) })),
    getSafeSpendingLimit({ period: 'week' }, userId, token).catch((e: any) => ({ success: false, error: e?.message || String(e), safeSpending: {}, breakdown: {} })),
    analyzeFinancialHabits({ period: args?.habitPeriod || 'last_14_days', insightLimit: 8, limit: Math.max(200, Math.min(1000, Number(args?.transactionLimit) || 600)) }, userId, token).catch((e: any) => ({ success: false, insights: [], error: e?.message || String(e) })),
    getSavingsGoals({ now: safeNow.toISOString() }, userId, token).catch((e: any) => ({ success: false, goals: [], error: e?.message || String(e) })),
    reviewRecurringCommitments({ lookAheadDays: 7, limit: 150 }, userId, token).catch((e: any) => ({ success: false, dueSoon: [], overdue: [], error: e?.message || String(e) })),
    detectRecurringCommitments({ limit: Math.max(100, Math.min(700, Number(args?.transactionLimit) || 500)), candidateLimit: 5, minOccurrences: 2 }, userId, token).catch((e: any) => ({ success: false, candidates: [], error: e?.message || String(e) })),
    getAdvisorAlerts({ limit: 25 }, userId, token).catch((e: any) => ({ success: false, alerts: [], error: e?.message || String(e) })),
  ]);

  const profile = normalizeTreasurerProfile((profileResult as any).profile || {});
  const profileCompleteness = (profileResult as any).completeness || buildTreasurerProfileCompleteness(profile);
  const actions: any[] = [];
  const safeDecision = String((safe as any).decision || '').toLowerCase();
  const safeSpending = (safe as any).safeSpending || {};
  const safeBreakdown = (safe as any).breakdown || {};
  const safeThisWeek = roundMoney(parsePositiveFinancialAmount(safeSpending.safeToSpendThisWeek ?? safeSpending.safeToSpendUntilHorizon));
  const safeToday = roundMoney(parsePositiveFinancialAmount(safeSpending.safeToSpendToday));
  const liquidTotalForWeekly = roundMoney(parsePositiveFinancialAmount(safeBreakdown.liquidTotal));
  const protectedTotalForWeekly = roundMoney(parsePositiveFinancialAmount(safeBreakdown.protectedTotal));
  const reserveTargetForWeekly = roundMoney(parsePositiveFinancialAmount(safeBreakdown.reserveTarget));
  const hardWeeklyDeficit = liquidTotalForWeekly > 0 && protectedTotalForWeekly > 0
    ? Math.max(0, protectedTotalForWeekly - liquidTotalForWeekly)
    : 0;
  const hardRecoveryCandidates = [
    parsePositiveFinancialAmount(safeSpending.deficitToProtected),
    parsePositiveFinancialAmount(safeBreakdown.deficitToProtected),
  ];
  const spendingPressureGap = roundMoney(Math.max(0,
    parsePositiveFinancialAmount(safeSpending.cashFlowGap),
    parsePositiveFinancialAmount(safeBreakdown.cashFlowGap)
  ));
  // Recovery is a real shortage below protected obligations. Cash-flow pressure
  // from expected spending is shown separately as a spending reduction target.
  const requiredRecovery = roundMoney(Math.max(0, hardWeeklyDeficit, ...hardRecoveryCandidates));
  const dailyCap = roundMoney(safeToday > 0 ? safeToday : Math.max(0, safeThisWeek / 7));

  if (spendingPressureGap > 0 && requiredRecovery === 0) {
    addWeeklyRecommendation(actions, {
      id: 'reduce_expected_spending_pressure',
      type: 'reduce',
      priority: 'high',
      severity: 'warning',
      title: 'خفّض ضغط الصرف المتوقع',
      message: `إذا استمر نمط الصرف الحالي قد تحتاج تخفيض حوالي ${spendingPressureGap} ₪ خلال الفترة، وهذا ليس تعويضاً نقدياً بل ضبط صرف.`,
      suggestedAmount: spendingPressureGap,
      source: 'safe_spending_limit',
      evidence: { spendingPressureGap, safeSpending, safeBreakdown },
    });
  }

  if (['critical', 'danger'].includes(safeDecision) || requiredRecovery > 0) {
    addWeeklyRecommendation(actions, {
      id: 'stop_discretionary_until_recovered',
      type: 'stop',
      priority: 'critical',
      severity: 'critical',
      title: 'أوقف الكماليات حتى تغطي الفجوة',
      message: `الهامش الآمن مضغوط. المطلوب تعويض ${requiredRecovery} ₪ قبل أي صرف غير ضروري.`,
      suggestedAmount: requiredRecovery,
      source: 'safe_spending_limit',
      evidence: { safeDecision, requiredRecovery, safeThisWeek, safeToday },
    });
  } else if (safeDecision === 'warning' || safeThisWeek < Math.max(100, dailyCap * 3)) {
    addWeeklyRecommendation(actions, {
      id: 'tighten_weekly_spending',
      type: 'reduce',
      priority: 'high',
      severity: 'warning',
      title: 'خفّض الصرف الأسبوعي مؤقتاً',
      message: `الهامش الأسبوعي محدود (${safeThisWeek} ₪). التزم بسقف يومي قريب من ${dailyCap} ₪.`,
      suggestedAmount: Math.max(20, roundMoney(safeThisWeek * 0.2)),
      source: 'safe_spending_limit',
      evidence: { safeDecision, safeThisWeek, safeToday, dailyCap },
    });
  }

  for (const insight of ((habits as any).insights || []).filter((i: any) => i.severity === 'warning').slice(0, 4)) {
    const evidence = insight.evidence || {};
    const currentTotal = parsePositiveFinancialAmount(evidence.currentTotal || evidence.smallPurchases?.total || evidence.currentDebtSpend || evidence.total);
    const suggestedAmount = roundMoney(Math.max(20, Math.min(currentTotal * 0.35, currentTotal - parsePositiveFinancialAmount(evidence.previousTotal))));
    addWeeklyRecommendation(actions, {
      id: `habit_${insight.key}`,
      type: insight.type === 'debt_usage_drift' ? 'pay_debt' : insight.type === 'small_purchase_accumulation' ? 'stop' : 'reduce',
      priority: insight.type === 'debt_usage_drift' ? 'high' : 'medium',
      severity: 'warning',
      title: insight.type === 'small_purchase_accumulation' ? 'جمّد المصاريف الصغيرة يومين' : insight.title,
      message: insight.message,
      suggestedAmount,
      source: 'financial_habits',
      relatedIds: evidence.sampleIds || evidence.smallPurchases?.sampleIds || [],
      evidence: insight,
    });
  }

  const overdue = Array.isArray((recurringReview as any).overdue) ? (recurringReview as any).overdue : [];
  const dueSoon = Array.isArray((recurringReview as any).dueSoon) ? (recurringReview as any).dueSoon : [];
  for (const commitment of [...overdue, ...dueSoon].slice(0, 5)) {
    const dueKey = auditDateKey(commitment.dueDate);
    const isOverdue = dueKey && dueKey < safeNow.toISOString().slice(0, 10);
    addWeeklyRecommendation(actions, {
      id: `commitment_${commitment.id || stableDocId(`${commitment.title}:${dueKey}`)}`,
      type: 'pay_commitment',
      priority: isOverdue ? 'critical' : 'high',
      severity: isOverdue ? 'critical' : 'warning',
      title: isOverdue ? `سدّد المتأخر: ${commitment.title || 'التزام'}` : `جهّز استحقاق ${commitment.title || 'التزام'}`,
      message: `موعده ${dueKey || 'قريب'} وقيمته ${commitment.amount || 0} ₪.`,
      suggestedAmount: parsePositiveFinancialAmount(commitment.amount),
      source: 'recurring_commitments',
      relatedIds: [commitment.id].filter(Boolean),
      evidence: { commitment },
    });
  }

  const activeGoals = Array.isArray((goalsResult as any).goals) ? (goalsResult as any).goals : [];
  const riskyGoals = activeGoals
    .filter((goal: any) => ['critical', 'warning'].includes(String(goal.alertLevel || '')) || parsePositiveFinancialAmount(goal.monthlyGap) > 0)
    .sort((a: any, b: any) => normalizeGoalPriorityScore(b.priority) - normalizeGoalPriorityScore(a.priority) || parsePositiveFinancialAmount(b.monthlyGap) - parsePositiveFinancialAmount(a.monthlyGap))
    .slice(0, 3);
  const availableForGoals = roundMoney(Math.max(0, safeThisWeek - requiredRecovery));
  for (const goal of riskyGoals) {
    const monthlyGap = roundMoney(Math.max(parsePositiveFinancialAmount(goal.monthlyGap), parsePositiveFinancialAmount(goal.monthlyRequired) - parsePositiveFinancialAmount(goal.monthlySavedAmount)));
    const suggested = roundMoney(Math.min(Math.max(20, monthlyGap / 4), Math.max(0, availableForGoals * 0.35)));
    if (suggested > 0) {
      addWeeklyRecommendation(actions, {
        id: `goal_${goal.id}`,
        type: 'save_goal',
        priority: goal.alertLevel === 'critical' ? 'high' : 'medium',
        severity: goal.alertLevel === 'critical' ? 'warning' : 'info',
        title: `حوّل للأهداف: ${goal.name || 'هدف ادخار'}`,
        message: `الهدف يحتاج تقريباً ${monthlyGap} ₪ هذا الشهر للبقاء على المسار.`,
        suggestedAmount: suggested,
        source: 'savings_goals',
        relatedIds: [goal.id].filter(Boolean),
        evidence: { goalId: goal.id, monthlyGap, monthlyRequired: goal.monthlyRequired, monthlySavedAmount: goal.monthlySavedAmount, alertLevel: goal.alertLevel },
      });
    }
  }

  const debtBalance = parsePositiveFinancialAmount(safeBreakdown?.balances?.debt);
  const debtLimit = parsePositiveFinancialAmount(safeBreakdown?.profileLimits?.effectiveDebtLimit);
  if (debtBalance > 0 && (debtLimit === 0 || debtBalance >= debtLimit * 0.5 || planType === 'debt_control')) {
    const suggestedDebtPayment = roundMoney(Math.min(debtBalance, Math.max(20, Math.max(0, safeThisWeek - requiredRecovery) * 0.25)));
    if (suggestedDebtPayment > 0) {
      addWeeklyRecommendation(actions, {
        id: 'weekly_debt_payment',
        type: 'pay_debt',
        priority: debtLimit > 0 && debtBalance > debtLimit ? 'critical' : 'high',
        severity: debtLimit > 0 && debtBalance > debtLimit ? 'critical' : 'warning',
        title: 'سدّد جزءاً من الدين هذا الأسبوع',
        message: `رصيد الدين الحالي ${debtBalance} ₪${debtLimit > 0 ? ` وحدك الشخصي ${debtLimit} ₪` : ''}.`,
        suggestedAmount: suggestedDebtPayment,
        source: 'safe_spending_debt_limits',
        evidence: { debtBalance, debtLimit, safeThisWeek },
      });
    }
  }

  const recurringCandidates = Array.isArray((recurringDetection as any).candidates) ? (recurringDetection as any).candidates : [];
  for (const candidate of recurringCandidates.filter((c: any) => Number(c.confidence || 0) >= 0.7).slice(0, 3)) {
    addWeeklyRecommendation(actions, {
      id: `schedule_${candidate.detectionKey}`,
      type: 'schedule_commitment',
      priority: Number(candidate.confidence || 0) >= 0.85 ? 'medium' : 'low',
      severity: 'info',
      title: `راجع اشتراك ${candidate.title || 'متكرر'}`,
      message: `ظهر ${candidate.occurrenceCount || 0} مرات بقيمة تقريبية ${candidate.amount || 0} ₪. تحويله لالتزام يحسن توقعاتك.`,
      suggestedAmount: parsePositiveFinancialAmount(candidate.amount),
      source: 'recurring_detection',
      relatedIds: candidate.sourceTransactionIds || [],
      evidence: { candidate },
    });
  }

  const openCriticalAlerts = ((alertsResult as any).alerts || []).filter((a: any) => String(a.severity || '').toLowerCase() === 'critical' && normalizeAdvisorAlertStatus(a.advisorStatus) === 'open');
  if (openCriticalAlerts.length) {
    addWeeklyRecommendation(actions, {
      id: 'review_critical_alerts',
      type: 'review_alerts',
      priority: 'critical',
      severity: 'critical',
      title: 'راجع التنبيهات الحرجة أولاً',
      message: `يوجد ${openCriticalAlerts.length} تنبيه حرج مفتوح يحتاج قراراً قبل أي صرف جديد.`,
      suggestedAmount: 0,
      source: 'advisor_alerts',
      relatedIds: openCriticalAlerts.map((a: any) => a.id).filter(Boolean),
      evidence: { alerts: openCriticalAlerts.slice(0, 5) },
    });
  }

  if (profileCompleteness?.status !== 'ready') {
    addWeeklyRecommendation(actions, {
      id: 'complete_treasurer_profile',
      type: 'complete_profile',
      priority: 'low',
      severity: 'info',
      title: 'استكمل ملف أمين الصندوق',
      message: profileCompleteness.nextPrompt || 'استكمال الملف يزيد دقة التوصيات الأسبوعية.',
      suggestedAmount: 0,
      source: 'treasurer_profile',
      evidence: { completeness: profileCompleteness },
    });
  }

  if (!actions.length) {
    addWeeklyRecommendation(actions, {
      id: 'maintain_weekly_plan',
      type: 'maintain',
      priority: 'low',
      severity: 'info',
      title: 'حافظ على الخطة الحالية',
      message: `الهامش الأسبوعي الحالي ${safeThisWeek} ₪. لا توجد توصية ضغط واضحة ضمن البيانات الحالية.`,
      suggestedAmount: 0,
      source: 'weekly_recommendation_engine',
      evidence: { safeThisWeek, safeToday, habitStatus: (habits as any).status },
    });
  }

  const buckets = extractWeeklyActionBuckets(actions);
  const warningActions = actions.filter((a: any) => ['critical', 'warning'].includes(a.severity)).length;
  const totalPotentialSavings = roundMoney(actions.filter((a: any) => ['stop', 'reduce'].includes(a.type)).reduce((sum: number, a: any) => sum + parsePositiveFinancialAmount(a.suggestedAmount), 0));
  const suggestedGoalTransfer = roundMoney(actions.filter((a: any) => a.type === 'save_goal').reduce((sum: number, a: any) => sum + parsePositiveFinancialAmount(a.suggestedAmount), 0));
  const suggestedDebtPayment = roundMoney(actions.filter((a: any) => a.type === 'pay_debt').reduce((sum: number, a: any) => sum + parsePositiveFinancialAmount(a.suggestedAmount), 0));
  const requiredCommitments = roundMoney(actions.filter((a: any) => a.type === 'pay_commitment').reduce((sum: number, a: any) => sum + parsePositiveFinancialAmount(a.suggestedAmount), 0));
  let status = 'weekly_stable';
  if (actions.some((a: any) => a.severity === 'critical') || requiredRecovery > 0) status = 'weekly_recovery';
  else if (warningActions > 0 || spendingPressureGap > 0) status = 'weekly_watch';
  else if (suggestedGoalTransfer > 0 || suggestedDebtPayment > 0) status = 'weekly_growth';

  const summary = {
    safeThisWeek,
    safeToday,
    dailyCap,
    requiredRecovery,
    spendingPressureGap,
    totalPotentialSavings,
    suggestedGoalTransfer,
    suggestedDebtPayment,
    requiredCommitments,
    warningActions,
    actionCount: actions.length,
  };
  const result: any = {
    success: true,
    status,
    planType,
    message: buildWeeklyRecommendationMessage(status, summary),
    week: { key: planKey, startIso: weekHorizon.startIso, endIso: weekHorizon.endIso, label: weekHorizon.label, days: weekHorizon.daysRemaining },
    summary,
    plan: buckets,
    actions: buckets.all,
    sources: {
      safeSpending: { decision: (safe as any).decision, safeSpending: (safe as any).safeSpending, partial: Boolean((safe as any).partial) },
      habits: { status: (habits as any).status, score: (habits as any).score, insightCount: ((habits as any).insights || []).length, partial: Boolean((habits as any).partial) },
      goals: { count: activeGoals.length, riskyCount: riskyGoals.length, partial: Boolean((goalsResult as any).partial) },
      recurring: { dueSoon: dueSoon.length, overdue: overdue.length, candidates: recurringCandidates.length, partial: Boolean((recurringReview as any).partial || (recurringDetection as any).partial) },
      alerts: { criticalOpen: openCriticalAlerts.length, partial: Boolean((alertsResult as any).partial) },
    },
    profileCompleteness,
    partial: Boolean((safe as any).partial || (habits as any).partial || (goalsResult as any).partial || (recurringReview as any).partial || (recurringDetection as any).partial || (alertsResult as any).partial),
    readEfficiency: {
      safeSpendingPartial: Boolean((safe as any).partial),
      habitDocsRead: (habits as any).readEfficiency?.transactionDocsRead,
      goalDocsRead: (goalsResult as any).readEfficiency?.savingsGoalLimit,
      recurringCommitmentDocsRead: (recurringReview as any).readEfficiency?.commitmentDocsRead,
      recurringTransactionDocsRead: (recurringDetection as any).readEfficiency?.transactionDocsRead,
    },
  };

  if (parseBooleanLike(args?.save)) {
    const reportId = stableDocId(`weekly-plan:${userId}:${planKey}`);
    await adminDb.collection('users').doc(userId).collection('advisorWeeklyPlans').doc(reportId).set({ userId, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), ...result }, { merge: true });
    result.savedPlanId = reportId;
  }

  if (parseBooleanLike(args?.persistAlerts) && status !== 'weekly_stable') {
    await addNotification(userId, `🧭 خطة الأسبوع: ${result.message}`, 'warning', adminDb, {
      idempotencyKey: `advisor-weekly-plan:${stableDocId(`${userId}:${planKey}:${status}`)}`,
      advisorAlert: true,
      advisorStatus: 'open',
      severity: status === 'weekly_recovery' ? 'critical' : 'warning',
      priority: status === 'weekly_recovery' ? 'high' : 'medium',
      category: 'weekly_recommendation_plan',
      source: 'generateWeeklyFinancialRecommendations',
      metadata: { week: result.week, summary, topActions: buckets.all.slice(0, 5) },
      actions: [
        { id: 'apply_weekly_plan', label: 'اتبع الخطة', type: 'behavior' },
        { id: 'review_actions', label: 'راجع التوصيات', type: 'review' },
        { id: 'snooze', label: 'ذكرني لاحقاً', type: 'snooze' },
      ],
    });
  }

  return result;
}

export async function getWeeklyFinancialRecommendations(args: any, userId: string, token: string) {
  const adminDb = getDb(token);
  const limit = Math.max(1, Math.min(50, Number(args?.limit) || 10));
  const snap = await adminDb.collection('users').doc(userId).collection('advisorWeeklyPlans')
    .orderBy('createdAt', 'desc')
    .limit(limit)
    .get();
  const plans = snap.docs.map((d: any) => ({ id: d.id, ...d.data() }));
  return { success: true, plans, count: plans.length, limit, partial: Boolean((snap as any).partial || plans.length >= limit), readEfficiency: { advisorWeeklyPlanLimit: limit, docsRead: snap.docs.length } };
}

function normalizeAdaptiveBudgetMode(value: any) {
  const raw = normalizeArabicText(String(value || 'balanced')).toLowerCase();
  if (/tight|شد|تقشف|انقاذ|إنقاذ|recovery/.test(raw)) return 'tighten';
  if (/growth|ادخار|توفير|هدف/.test(raw)) return 'growth';
  if (/relaxed|مرن|خفيف/.test(raw)) return 'relaxed';
  return 'balanced';
}

function roundBudgetLimit(value: number) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  if (n < 100) return Math.max(10, Math.round(n / 10) * 10);
  return Math.max(10, Math.round(n / 25) * 25);
}

function adaptiveBudgetCategoryKind(category: string, profile: any) {
  const normalized = normalizeArabicText(category).toLowerCase();
  const protectedCategories = normalizeTreasurerStringList(profile.protectedCategories || [])
    .map((c: string) => normalizeArabicText(c).toLowerCase());
  const restrictedCategories = normalizeTreasurerStringList(profile.restrictedCategories || [])
    .map((c: string) => normalizeArabicText(c).toLowerCase());
  if (protectedCategories.some((c: string) => c && normalized.includes(c))) return 'protected';
  if (/طعام|منزل|اولاد|أولاد|ابناء|أبناء|صحة|علاج|تعليم|تدريب|مواصلات|فواتير|التزامات|ايجار|إيجار|دواء/.test(normalized)) return 'essential';
  if (restrictedCategories.some((c: string) => c && normalized.includes(c))) return 'restricted';
  if (/ترفيه|مطاعم|قهوة|كافيه|حلويات|زيارات|ضيافة|هدايا|ملابس|كماليات|تجميل|العاب|ألعاب/.test(normalized)) return 'discretionary';
  return 'flexible';
}

function monthlyCommitmentAmount(commitment: any) {
  const amount = parsePositiveFinancialAmount(commitment.amount);
  const frequency = normalizeRecurringCommitmentFrequency(commitment.recurringFrequency || commitment.frequency);
  if (commitment.recurring || commitment.recurringFrequency || commitment.recurringDetectionKey) {
    if (frequency === 'weekly') return roundMoney(amount * 4.33);
    if (frequency === 'biweekly') return roundMoney(amount * 2.17);
    if (frequency === 'quarterly') return roundMoney(amount / 3);
    if (frequency === 'yearly') return roundMoney(amount / 12);
    return amount;
  }
  return amount;
}

function findBudgetCategoryInsight(habits: any, category: string) {
  const normalized = normalizeArabicText(category).toLowerCase();
  return ((habits?.insights || []) as any[]).find((insight: any) => {
    const evidenceCategory = normalizeArabicText(String(insight?.evidence?.category || insight?.evidence?.key || insight?.title || '')).toLowerCase();
    const message = normalizeArabicText(String(insight?.message || '')).toLowerCase();
    return insight?.type === 'category_spike' && (evidenceCategory.includes(normalized) || message.includes(normalized));
  });
}

function buildAdaptiveBudgetReason(input: any) {
  const parts: string[] = [];
  if (input.kind === 'protected' || input.kind === 'essential') parts.push('بند محمي/أساسي لذلك لا يتم ضغطه بقوة.');
  if (input.kind === 'restricted' || input.kind === 'discretionary') parts.push('بند مرن أو مقيد ويمكن تخفيضه لحماية الأهداف.');
  if (input.spikeInsight) parts.push('ظهر ارتفاع في هذا البند مقارنة بالفترة السابقة.');
  if (input.ratio >= 1) parts.push('تم تجاوز السقف الحالي هذا الشهر.');
  else if (input.ratio >= 0.8) parts.push('البند قريب من السقف الحالي.');
  if (input.envelopeScale < 1) parts.push('تم تخفيضه ضمن إعادة توزيع السقف الشهري العام.');
  return parts.join(' ') || 'اقتراح مبني على الصرف الحالي والحد الآمن والأهداف.';
}

function adaptiveBudgetStatus(proposals: any[], totalCurrent: number, totalProposed: number, envelope: number, incomeGuard?: any) {
  const reduced = proposals.filter((p: any) => p.change < 0).length;
  const increased = proposals.filter((p: any) => p.change > 0).length;
  if (incomeGuard?.missingIncome && incomeGuard?.usingDefaultBudgetTemplate) return 'needs_income_profile';
  if (incomeGuard?.unableToFitIncome) return 'income_conflict';
  if (incomeGuard?.initialBudgetSetup) return 'initial_setup';
  if (totalProposed > envelope) return 'needs_manual_review';
  if (reduced > increased) return 'tightened';
  if (increased > reduced) return 'rebalanced_growth';
  return 'balanced';
}

function fitAdaptiveBudgetProposalsToIncomeEnvelope(proposals: any[], targetEnvelope: number, referenceMonthlyIncome: number) {
  const preCapTotal = roundMoney(proposals.reduce((sum: number, p: any) => sum + parsePositiveFinancialAmount(p.proposedLimit), 0));
  const envelope = roundMoney(parsePositiveFinancialAmount(targetEnvelope));
  if (referenceMonthlyIncome <= 0 || preCapTotal <= envelope) {
    return { proposals, capApplied: false, preCapTotal, fittedTotal: preCapTotal, unableToFitIncome: false };
  }
  if (envelope <= 0) {
    const fitted = proposals.map((p: any) => ({
      ...p,
      proposedLimit: 0,
      change: roundMoney(0 - parsePositiveFinancialAmount(p.currentLimit)),
      changePct: parsePositiveFinancialAmount(p.currentLimit) > 0 ? -100 : 0,
      incomeEnvelopeScale: 0,
      action: parsePositiveFinancialAmount(p.currentLimit) > 0 ? 'decrease' : 'keep',
      reason: `${p.reason || ''} لا يوجد هامش دخل متاح بعد الالتزامات/الأهداف/التعويض، لذلك لا يجوز اقتراح سقوف صرف إضافية.`.trim(),
    }));
    return { proposals: fitted, capApplied: true, preCapTotal, fittedTotal: 0, unableToFitIncome: false };
  }

  const scale = Math.max(0, Math.min(1, envelope / Math.max(1, preCapTotal)));
  let fitted = proposals.map((p: any) => {
    const proposedLimit = roundBudgetLimit(parsePositiveFinancialAmount(p.proposedLimit) * scale);
    const change = roundMoney(proposedLimit - parsePositiveFinancialAmount(p.currentLimit));
    const changePct = parsePositiveFinancialAmount(p.currentLimit) > 0 ? Math.round((change / parsePositiveFinancialAmount(p.currentLimit)) * 100) : 100;
    return {
      ...p,
      proposedLimit,
      change,
      changePct,
      incomeEnvelopeScale: scale,
      action: change < -5 ? 'decrease' : change > 5 ? 'increase' : 'keep',
      reason: `${p.reason || ''} تم ضبط هذا البند ضمن سقف الدخل المتاح حتى لا تتحول الميزانية إلى رقم أعلى من دخلك.`.trim(),
    };
  });

  let fittedTotal = roundMoney(fitted.reduce((sum: number, p: any) => sum + parsePositiveFinancialAmount(p.proposedLimit), 0));
  if (fittedTotal > envelope) {
    const reduceOrder = fitted
      .map((p: any, index: number) => ({ index, p }))
      .sort((a: any, b: any) => {
        const rank: any = { flexible: 0, discretionary: 1, restricted: 2, essential: 3, protected: 4 };
        return (rank[a.p.kind] ?? 0) - (rank[b.p.kind] ?? 0) || parsePositiveFinancialAmount(b.p.proposedLimit) - parsePositiveFinancialAmount(a.p.proposedLimit);
      });
    let over = roundMoney(fittedTotal - envelope);
    for (const item of reduceOrder) {
      if (over <= 0) break;
      const current = parsePositiveFinancialAmount(fitted[item.index].proposedLimit);
      const reduction = Math.min(current, over);
      const nextLimit = roundMoney(Math.max(0, current - reduction));
      const currentLimit = parsePositiveFinancialAmount(fitted[item.index].currentLimit);
      const change = roundMoney(nextLimit - currentLimit);
      fitted[item.index] = {
        ...fitted[item.index],
        proposedLimit: nextLimit,
        change,
        changePct: currentLimit > 0 ? Math.round((change / currentLimit) * 100) : 100,
        action: change < -5 ? 'decrease' : change > 5 ? 'increase' : 'keep',
      };
      over = roundMoney(over - reduction);
    }
    fittedTotal = roundMoney(fitted.reduce((sum: number, p: any) => sum + parsePositiveFinancialAmount(p.proposedLimit), 0));
  }

  return { proposals: fitted, capApplied: true, preCapTotal, fittedTotal, unableToFitIncome: fittedTotal > envelope };
}

export async function generateAdaptiveBudgetPlan(args: any, userId: string, token: string) {
  const adminDb = getDb(token);
  const now = args?.now ? new Date(String(args.now)) : new Date();
  const safeNow = Number.isFinite(now.getTime()) ? now : new Date();
  const mode = normalizeAdaptiveBudgetMode(args?.mode || args?.focus);
  const [profileResult, budgetOverview, currentSalaryCycleResult, safe, habits, goalsResult, commitmentsResult, weeklyPlan] = await Promise.all([
    getTreasurerProfile({}, userId, token).catch(() => ({ profile: normalizeTreasurerProfile({}), completeness: buildTreasurerProfileCompleteness(normalizeTreasurerProfile({})) })),
    getBudgetsOverview({}, userId, token).catch((e: any) => ({ success: false, budgets: [], totalBudget: 0, totalSpent: 0, partial: true, error: e?.message || String(e) })),
    queryTransactions({ period: 'current_salary_cycle', includeTransactions: false, limit: 500 }, userId, token).catch((e: any) => ({ success: false, salaryCycle: {}, partial: true, error: e?.message || String(e) })),
    getSafeSpendingLimit({ period: 'salary_cycle' }, userId, token).catch((e: any) => ({ success: false, decision: 'unknown', safeSpending: {}, breakdown: {}, partial: true, error: e?.message || String(e) })),
    analyzeFinancialHabits({ period: args?.habitPeriod || 'last_30_days', insightLimit: 10, limit: Math.max(200, Math.min(1000, Number(args?.transactionLimit) || 700)) }, userId, token).catch((e: any) => ({ success: false, insights: [], current: {}, partial: true, error: e?.message || String(e) })),
    getSavingsGoals({ now: safeNow.toISOString() }, userId, token).catch((e: any) => ({ success: false, goals: [], partial: true, error: e?.message || String(e) })),
    getCommitments({ limit: 200 }, userId, token).catch((e: any) => ({ success: false, commitments: [], partial: true, error: e?.message || String(e) })),
    generateWeeklyFinancialRecommendations({ focus: mode === 'tighten' ? 'recovery' : mode === 'growth' ? 'savings_growth' : 'weekly', habitPeriod: args?.habitPeriod || 'last_14_days' }, userId, token).catch((e: any) => ({ success: false, actions: [], summary: {}, partial: true, error: e?.message || String(e) })),
  ]);

  const profile = normalizeTreasurerProfile((profileResult as any).profile || {});
  const currentBudgetRows = Array.isArray((budgetOverview as any).budgets) ? (budgetOverview as any).budgets : [];
  const currentBudgetMap = new Map(currentBudgetRows.map((b: any) => [String(b.category), b]));
  const customBudgetCount = Number((budgetOverview as any).customBudgetCount || 0);
  const hasExplicitBudgets = customBudgetCount > 0 || currentBudgetRows.some((b: any) => parsePositiveFinancialAmount(b.limit) > 0);
  const defaultBudgetTemplateTotal = Object.values(DEFAULT_BUDGETS).reduce((a, b) => a + b, 0);
  const currentTotalBudgetRaw = hasExplicitBudgets
    ? roundMoney(parsePositiveFinancialAmount((budgetOverview as any).totalBudget) || currentBudgetRows.reduce((sum: number, b: any) => sum + parsePositiveFinancialAmount(b.limit), 0))
    : 0;
  const usingDefaultBudgetTemplate = !hasExplicitBudgets;
  const categorySet = new Set<string>([
    ...Object.keys(DEFAULT_BUDGETS),
    ...currentBudgetRows.map((b: any) => String(b.category || '')).filter(Boolean),
  ]);
  if (categorySet.size === 0) Object.keys(DEFAULT_BUDGETS).forEach((category) => categorySet.add(category));
  const salaryFromProfile = parsePositiveFinancialAmount(profile.monthlySalary);
  const incomeFromCurrentSalaryCycle = roundMoney(parsePositiveFinancialAmount((currentSalaryCycleResult as any).salaryCycle?.totalIncome));
  const referenceMonthlyIncome = salaryFromProfile > 0 ? salaryFromProfile : incomeFromCurrentSalaryCycle;
  const salary = referenceMonthlyIncome;
  const missingIncomeProfile = salaryFromProfile <= 0 && incomeFromCurrentSalaryCycle <= 0;
  const activeGoals = Array.isArray((goalsResult as any).goals) ? (goalsResult as any).goals : [];
  const monthlyGoalNeed = roundMoney(activeGoals
    .filter((g: any) => !['completed', 'cancelled', 'archived'].includes(String(g.status || 'active').toLowerCase()))
    .reduce((sum: number, g: any) => sum + Math.max(parsePositiveFinancialAmount(g.monthlyRequired), parsePositiveFinancialAmount(g.monthlyGap)), 0));
  const activeCommitments = Array.isArray((commitmentsResult as any).commitments) ? (commitmentsResult as any).commitments.filter((c: any) => !['paid', 'cancelled'].includes(String(c.status || '').toLowerCase())) : [];
  const monthlyCommitments = roundMoney(activeCommitments.reduce((sum: number, c: any) => sum + monthlyCommitmentAmount(c), 0));
  const currentTotalBudget = currentTotalBudgetRaw;
  const currentTotalSpent = roundMoney(parsePositiveFinancialAmount((budgetOverview as any).totalSpent));
  const safeDecision = String((safe as any).decision || '').toLowerCase();
  const requiredRecovery = roundMoney(Math.max(
    parsePositiveFinancialAmount((safe as any).safeSpending?.deficitToProtected),
    parsePositiveFinancialAmount((weeklyPlan as any).summary?.requiredRecovery)
  ));
  const spendingPressureGap = roundMoney(Math.max(
    0,
    parsePositiveFinancialAmount((safe as any).safeSpending?.cashFlowGap) - requiredRecovery,
    parsePositiveFinancialAmount((weeklyPlan as any).summary?.spendingPressureGap)
  ));
  const protectedClaims = roundMoney(monthlyCommitments + monthlyGoalNeed + requiredRecovery);
  const salaryEnvelope = salary > 0 ? Math.max(0, salary - protectedClaims) : 0;
  const fallbackEnvelope = usingDefaultBudgetTemplate
    ? (salary > 0 ? salaryEnvelope : Math.max(0, currentTotalSpent))
    : currentTotalBudget;
  let targetEnvelope = roundBudgetLimit(salary > 0 ? salaryEnvelope : fallbackEnvelope);
  if (mode === 'tighten' || requiredRecovery > 0 || ['critical', 'danger'].includes(safeDecision)) targetEnvelope = roundBudgetLimit(targetEnvelope * 0.9);
  if (mode === 'relaxed' && requiredRecovery === 0 && safeDecision !== 'warning' && salary > 0) targetEnvelope = roundBudgetLimit(targetEnvelope * 1.05);
  const essentialFloor = parsePositiveFinancialAmount(profile.essentialMonthlyEstimate);
  if (essentialFloor > 0 && salary > 0) targetEnvelope = Math.max(targetEnvelope, Math.min(roundBudgetLimit(essentialFloor), roundBudgetLimit(salary * 0.95)));
  if (salary > 0) targetEnvelope = Math.min(targetEnvelope, roundBudgetLimit(salary * 0.95));

  const rawProposals = Array.from(categorySet).map((category) => {
    const row: any = currentBudgetMap.get(category) || { category, limit: 0, spent: 0, percentage: 0 };
    const templateLimit = parsePositiveFinancialAmount(DEFAULT_BUDGETS[category] || 0);
    const currentLimit = roundMoney(hasExplicitBudgets ? parsePositiveFinancialAmount(row.limit) : 0);
    const spent = roundMoney(parsePositiveFinancialAmount(row.spent));
    const ratio = currentLimit > 0 ? spent / currentLimit : 0;
    const kind = adaptiveBudgetCategoryKind(category, profile);
    const spikeInsight = findBudgetCategoryInsight(habits, category);
    // When this is the user's first budget setup, use the default template only
    // as category weights/base distribution, not as an existing 7300 ₪ budget.
    let proposed = currentLimit || templateLimit || Math.max(100, spent * 1.1);
    if (kind === 'protected' || kind === 'essential') {
      proposed = Math.max(proposed, spent * 1.05, kind === 'protected' ? 250 : 150);
      if (ratio >= 0.9 && mode !== 'tighten') proposed *= 1.08;
    } else {
      if (spikeInsight || kind === 'restricted' || mode === 'tighten' || requiredRecovery > 0) proposed *= kind === 'restricted' ? 0.75 : 0.85;
      else if (ratio < 0.5 && spent > 0) proposed = Math.max(spent * 1.25, proposed * 0.9);
      else if (mode === 'growth') proposed *= 0.95;
      proposed = Math.max(50, proposed);
    }
    if (spent > 0 && (kind === 'protected' || kind === 'essential')) proposed = Math.max(proposed, spent);
    return {
      category,
      kind,
      currentLimit: roundBudgetLimit(currentLimit),
      currentSpent: spent,
      currentUsagePct: currentLimit > 0 ? Math.round((spent / currentLimit) * 100) : 0,
      proposedLimit: roundBudgetLimit(proposed),
      envelopeScale: 1,
      spikeInsight: Boolean(spikeInsight),
      reason: '',
    };
  });

  const protectedKinds = new Set(['protected', 'essential']);
  const protectedSum = rawProposals.filter((p: any) => protectedKinds.has(p.kind)).reduce((sum: number, p: any) => sum + p.proposedLimit, 0);
  const adjustable = rawProposals.filter((p: any) => !protectedKinds.has(p.kind));
  const adjustableSum = adjustable.reduce((sum: number, p: any) => sum + p.proposedLimit, 0);
  const adjustableEnvelope = Math.max(0, targetEnvelope - protectedSum);
  const envelopeScale = adjustableSum > 0 && adjustableEnvelope > 0 && protectedSum + adjustableSum > targetEnvelope ? Math.max(0.35, Math.min(1, adjustableEnvelope / adjustableSum)) : 1;
  const preliminaryProposals = rawProposals.map((p: any) => {
    const scaledLimit = protectedKinds.has(p.kind) ? p.proposedLimit : roundBudgetLimit(p.proposedLimit * envelopeScale);
    const proposedLimit = Math.max(p.kind === 'restricted' || p.kind === 'discretionary' ? 30 : 50, scaledLimit);
    const change = roundMoney(proposedLimit - p.currentLimit);
    const changePct = p.currentLimit > 0 ? Math.round((change / p.currentLimit) * 100) : 100;
    return {
      ...p,
      proposedLimit,
      change,
      changePct,
      envelopeScale,
      action: change < -5 ? 'decrease' : change > 5 ? 'increase' : 'keep',
      reason: buildAdaptiveBudgetReason({ ...p, proposedLimit, change, ratio: p.currentLimit > 0 ? p.currentSpent / p.currentLimit : 0, envelopeScale }),
    };
  }).sort((a: any, b: any) => {
    const rank: any = { protected: 4, essential: 3, restricted: 2, discretionary: 1, flexible: 0 };
    return rank[b.kind] - rank[a.kind] || Math.abs(b.change) - Math.abs(a.change);
  });
  const incomeFitReference = referenceMonthlyIncome > 0 ? referenceMonthlyIncome : usingDefaultBudgetTemplate ? 1 : 0;
  const incomeFit = fitAdaptiveBudgetProposalsToIncomeEnvelope(preliminaryProposals, targetEnvelope, incomeFitReference);
  const proposals = incomeFit.proposals;
  const totalProposed = roundMoney(proposals.reduce((sum: number, p: any) => sum + p.proposedLimit, 0));
  const totalChange = roundMoney(totalProposed - currentTotalBudget);
  const decreasedCategories = proposals.filter((p: any) => p.action === 'decrease');
  const increasedCategories = proposals.filter((p: any) => p.action === 'increase');
  const incomeGuard = {
    salaryFromProfile,
    incomeFromCurrentSalaryCycle,
    referenceMonthlyIncome,
    missingIncome: missingIncomeProfile,
    usingDefaultBudgetTemplate,
    hasExplicitBudgets,
    initialBudgetSetup: !hasExplicitBudgets,
    defaultBudgetTemplateTotal,
    protectedClaims,
    spendingPressureGap,
    salaryEnvelope,
    capApplied: incomeFit.capApplied,
    preCapTotal: incomeFit.preCapTotal,
    fittedTotal: incomeFit.fittedTotal,
    unableToFitIncome: incomeFit.unableToFitIncome || (salary > 0 && protectedClaims > salary),
  };
  const result: any = {
    success: true,
    mode,
    status: adaptiveBudgetStatus(proposals, currentTotalBudget, totalProposed, targetEnvelope, incomeGuard),
    message: missingIncomeProfile
      ? 'لا أملك دخلاً شهرياً مؤكداً، لذلك لن أعتبر قالب 7300 ₪ ميزانية مقترحة. اضبط دخلك في ملف أمين الصندوق ليتم اقتراح حدود دقيقة.'
      : incomeGuard.unableToFitIncome
        ? `دخلك/هامشك المتاح غير كافٍ بعد الالتزامات والأهداف (${protectedClaims} ₪)، لذلك تحتاج مراجعة يدوية قبل اعتماد أي ميزانية.`
        : !hasExplicitBudgets
          ? `هذه خطة ميزانية أولية بسقف ${totalProposed} ₪ مبنية على دخلك المتاح ${targetEnvelope} ₪. قالب ${defaultBudgetTemplateTotal} ₪ استخدم فقط كأوزان توزيع للفئات وليس كميزانية سابقة.`
          : totalChange < 0
            ? `اقترحت ميزانية أضيق بـ ${Math.abs(totalChange)} ₪ ومقيدة بسقف الدخل المتاح ${targetEnvelope} ₪.`
            : totalChange > 0
              ? `اقترحت إعادة توزيع مع زيادة صافية ${totalChange} ₪، لكنها مقيدة بسقف الدخل المتاح ${targetEnvelope} ₪.`
              : 'اقترحت إعادة توزيع متوازنة بدون تغيير كبير في إجمالي الميزانية، ومقيدة بالدخل المتاح.',
    month: (budgetOverview as any).month || safeNow.toISOString().slice(0, 7),
    envelope: {
      targetEnvelope,
      salary,
      salaryFromProfile,
      incomeFromCurrentSalaryCycle,
      referenceMonthlyIncome,
      incomeGuard,
      currentTotalBudget,
      currentTotalSpent,
      monthlyCommitments,
      monthlyGoalNeed,
      requiredRecovery,
      safeDecision,
      essentialFloor,
      envelopeScale,
    },
    proposals,
    summary: {
      totalCurrentBudget: currentTotalBudget,
      totalProposedBudget: totalProposed,
      totalChange,
      decreasedCount: decreasedCategories.length,
      increasedCount: increasedCategories.length,
      unchangedCount: proposals.length - decreasedCategories.length - increasedCategories.length,
      topDecreases: decreasedCategories.slice(0, 5),
      topIncreases: increasedCategories.slice(0, 5),
    },
    recommendations: [
      decreasedCategories[0] ? `خفّض ${decreasedCategories[0].category} إلى ${decreasedCategories[0].proposedLimit} ₪.` : '',
      increasedCategories[0] ? `ارفع/ثبّت ${increasedCategories[0].category} إلى ${increasedCategories[0].proposedLimit} ₪ لأنه مهم أو قريب من السقف.` : '',
      requiredRecovery > 0 ? `قبل توسيع أي بند، عوّض ${requiredRecovery} ₪ من الفجوة الحالية.` : 'راجع الخطة بعد أسبوع من العمليات الجديدة.',
    ].filter(Boolean),
    profileCompleteness: (profileResult as any).completeness,
    sources: {
      incomeSource: salaryFromProfile > 0 ? 'treasurer_profile' : incomeFromCurrentSalaryCycle > 0 ? 'current_salary_cycle' : 'missing',
      currentSalaryCyclePartial: Boolean((currentSalaryCycleResult as any).partial),
      budgetsPartial: Boolean((budgetOverview as any).partial),
      safePartial: Boolean((safe as any).partial),
      habitsPartial: Boolean((habits as any).partial),
      goalsPartial: Boolean((goalsResult as any).partial),
      commitmentsPartial: Boolean((commitmentsResult as any).partial),
      weeklyPlanPartial: Boolean((weeklyPlan as any).partial),
    },
    partial: Boolean((budgetOverview as any).partial || (currentSalaryCycleResult as any).partial || (safe as any).partial || (habits as any).partial || (goalsResult as any).partial || (commitmentsResult as any).partial || (weeklyPlan as any).partial),
    readEfficiency: {
      budgetDocsRead: currentBudgetRows.length,
      habitDocsRead: (habits as any).readEfficiency?.transactionDocsRead,
      commitmentDocsRead: (commitmentsResult as any).readEfficiency?.commitmentDocsRead,
    },
  };

  if (parseBooleanLike(args?.save)) {
    const planId = stableDocId(`adaptive-budget:${userId}:${result.month}:${mode}`);
    await adminDb.collection('users').doc(userId).collection('advisorBudgetPlans').doc(planId).set({ userId, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), applied: false, ...result }, { merge: true });
    result.savedPlanId = planId;
  }

  if (parseBooleanLike(args?.persistAlert) && (decreasedCategories.length || requiredRecovery > 0 || ['needs_manual_review', 'needs_income_profile', 'income_conflict'].includes(result.status))) {
    await addNotification(userId, `🧮 ميزانية متكيّفة: ${result.message}`, 'warning', adminDb, {
      idempotencyKey: `advisor-adaptive-budget:${stableDocId(`${userId}:${result.month}:${mode}:${result.status}`)}`,
      advisorAlert: true,
      advisorStatus: 'open',
      severity: ['needs_manual_review', 'needs_income_profile', 'income_conflict'].includes(result.status) || requiredRecovery > 0 ? 'warning' : 'info',
      priority: requiredRecovery > 0 || result.status === 'income_conflict' ? 'high' : 'medium',
      category: 'adaptive_budget_plan',
      source: 'generateAdaptiveBudgetPlan',
      metadata: { month: result.month, envelope: result.envelope, summary: result.summary },
      actions: [
        { id: 'review_budget_plan', label: 'راجع الخطة', type: 'review' },
        { id: 'apply_budget_plan', label: 'طبّق الحدود', type: 'confirm' },
        { id: 'snooze', label: 'ذكرني لاحقاً', type: 'snooze' },
      ],
    });
  }

  return result;
}

export async function getAdaptiveBudgetPlans(args: any, userId: string, token: string) {
  const adminDb = getDb(token);
  const limit = Math.max(1, Math.min(50, Number(args?.limit) || 10));
  const snap = await adminDb.collection('users').doc(userId).collection('advisorBudgetPlans')
    .orderBy('createdAt', 'desc')
    .limit(limit)
    .get();
  const plans = snap.docs.map((d: any) => ({ id: d.id, ...d.data() }));
  return { success: true, plans, count: plans.length, limit, partial: Boolean((snap as any).partial || plans.length >= limit), readEfficiency: { advisorBudgetPlanLimit: limit, docsRead: snap.docs.length } };
}

export async function applyAdaptiveBudgetPlan(args: any, userId: string, token: string) {
  const adminDb = getDb(token);
  if (!parseBooleanLike(args?.applyConfirmed || args?.confirmed || args?.riskConfirmed)) {
    return { success: false, needsConfirmation: true, reason: 'CONFIRM_ADAPTIVE_BUDGET_APPLY', message: 'تطبيق الخطة سيغيّر حدود الميزانية المحفوظة. قل: أكد تطبيق خطة الميزانية.' };
  }
  let plan = args?.plan && typeof args.plan === 'object' ? args.plan : null;
  let planId = args?.planId || args?.id || plan?.savedPlanId || plan?.id;
  if (!plan && planId) {
    const snap = await adminDb.collection('users').doc(userId).collection('advisorBudgetPlans').doc(String(planId)).get();
    if (!snap.exists) return { success: false, reason: 'ADAPTIVE_BUDGET_PLAN_NOT_FOUND', message: 'لم أجد خطة الميزانية المطلوبة.' };
    plan = { id: snap.id, ...snap.data() };
  }
  if (!plan && Array.isArray(args?.proposals)) plan = { proposals: args.proposals, month: new Date().toISOString().slice(0, 7) };
  if (!plan || !Array.isArray(plan.proposals) || !plan.proposals.length) {
    return { success: false, needsClarification: true, reason: 'MISSING_ADAPTIVE_BUDGET_PROPOSALS', message: 'أحتاج خطة ميزانية أو قائمة حدود مقترحة لتطبيقها.' };
  }
  const proposals = plan.proposals
    .filter((p: any) => p?.category && parsePositiveFinancialAmount(p.proposedLimit) > 0)
    .slice(0, 50);
  if (!proposals.length) return { success: false, reason: 'NO_VALID_BUDGET_PROPOSALS', message: 'لا توجد حدود ميزانية صالحة للتطبيق.' };
  const batch = adminDb.batch();
  const nowIso = new Date().toISOString();
  for (const proposal of proposals) {
    const category = String(proposal.category);
    batch.set(adminDb.collection('users').doc(userId).collection('budgets').doc(category), {
      category,
      limit: roundBudgetLimit(parsePositiveFinancialAmount(proposal.proposedLimit)),
      adaptiveBudget: true,
      adaptiveBudgetPlanId: planId || null,
      adaptiveBudgetReason: proposal.reason || '',
      previousLimit: parsePositiveFinancialAmount(proposal.currentLimit),
      updatedAt: nowIso,
    }, { merge: true });
  }
  if (planId) {
    batch.set(adminDb.collection('users').doc(userId).collection('advisorBudgetPlans').doc(String(planId)), {
      applied: true,
      appliedAt: nowIso,
      appliedBudgetCount: proposals.length,
      updatedAt: nowIso,
    }, { merge: true });
  }
  await batch.commit();
  const message = `تم تطبيق خطة الميزانية المتكيّفة على ${proposals.length} بند.`;
  await addNotification(userId, message, 'success', adminDb);
  return { success: true, appliedCount: proposals.length, planId: planId || null, message, appliedBudgets: proposals.map((p: any) => ({ category: p.category, limit: roundBudgetLimit(parsePositiveFinancialAmount(p.proposedLimit)) })) };
}

function resolveMonthEndForecastWindow(args: any, now: Date) {
  const raw = normalizeArabicText(String(args?.mode || args?.period || args?.horizon || 'salary_cycle')).toLowerCase();
  if (/calendar|تقويم|الشهر الميلادي|نهاية الشهر الميلادي/.test(raw)) {
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
    const elapsedDays = Math.max(1, Math.ceil((now.getTime() - start.getTime()) / 86400000));
    const daysRemaining = Math.max(1, Math.ceil((end.getTime() - now.getTime()) / 86400000));
    const totalDays = Math.max(1, Math.ceil((end.getTime() - start.getTime()) / 86400000));
    return { key: `calendar_${now.toISOString().slice(0, 7)}`, mode: 'calendar_month', label: 'نهاية الشهر الميلادي', start, end, elapsedDays, daysRemaining, totalDays };
  }
  const cycle = getCurrentSalaryCycle(now);
  const start = new Date(cycle.startIso);
  const end = new Date(cycle.endExclusiveIso);
  const safeStart = Number.isFinite(start.getTime()) ? start : new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const safeEnd = Number.isFinite(end.getTime()) && end.getTime() > now.getTime() ? end : new Date(now.getTime() + 86400000);
  const elapsedDays = Math.max(1, Math.ceil((now.getTime() - safeStart.getTime()) / 86400000));
  const daysRemaining = Math.max(1, Math.ceil((safeEnd.getTime() - now.getTime()) / 86400000));
  const totalDays = Math.max(1, Math.ceil((safeEnd.getTime() - safeStart.getTime()) / 86400000));
  return { key: `salary_cycle_${cycle.id || cycle.name || safeStart.toISOString().slice(0, 7)}`, mode: 'salary_cycle', label: cycle.name || 'نهاية دورة الراتب', start: safeStart, end: safeEnd, elapsedDays, daysRemaining, totalDays, salaryCycle: cycle };
}

function normalizeMonthEndForecastStatus(projectedFreeCash: number, projectedNetCash: number, requiredRecovery: number, dailyCap: number, dailyAverage: number, safeDecision: string) {
  if (projectedNetCash < 0 || requiredRecovery > 0 || ['critical', 'danger'].includes(safeDecision)) return 'month_end_deficit';
  if (dailyAverage <= 0) return projectedFreeCash > 0 ? 'month_end_balanced' : 'month_end_pressure';
  if (projectedFreeCash < Math.max(100, dailyAverage * 2) || safeDecision === 'warning' || dailyCap < Math.max(20, dailyAverage * 0.6)) return 'month_end_pressure';
  if (projectedFreeCash >= Math.max(250, dailyAverage * 5)) return 'month_end_surplus';
  return 'month_end_balanced';
}

function buildMonthEndForecastMessage(status: string, forecast: any) {
  if (status === 'month_end_deficit') return `التوقع الحالي يشير إلى عجز/فجوة بنهاية الفترة بقيمة تقريبية ${forecast.requiredRecovery || forecast.projectedGap || 0} ₪ إذا استمر نفس النمط.`;
  if (status === 'month_end_pressure') return `التوقع يشير إلى ضغط بنهاية الفترة: الهامش الحر المتوقع ${forecast.projectedFreeCashAfterReserve || 0} ₪ فقط، والسقف اليومي المقترح ${forecast.dailyCorrectionCap || 0} ₪.`;
  if (status === 'month_end_surplus') return `التوقع جيد: قد تنهي الفترة بفائض حر يقارب ${forecast.projectedFreeCashAfterReserve || 0} ₪ بعد الالتزامات والاحتياطي والأهداف والصرف المتوقع.`;
  return `التوقع متوازن: نهاية الفترة قريبة من الصفر الآمن مع هامش يقارب ${forecast.projectedFreeCashAfterReserve || 0} ₪.`;
}

function buildMonthEndCorrectionPlan(input: any) {
  const actions: any[] = [];
  const recoveryNeeded = roundMoney(Math.max(0, input.requiredRecovery || input.projectedGap || 0));
  const dailyCap = roundMoney(Math.max(0, input.dailyCorrectionCap || 0));
  if (recoveryNeeded > 0) {
    actions.push({
      id: 'recover_projected_gap',
      type: 'recover_gap',
      priority: 'critical',
      title: 'عوّض الفجوة قبل نهاية الفترة',
      message: `خفّض الصرف أو وفّر دخل إضافي بقيمة ${recoveryNeeded} ₪ تقريباً لحماية نهاية الشهر.`,
      suggestedAmount: recoveryNeeded,
    });
  }
  if (dailyCap > 0) {
    actions.push({
      id: 'daily_cap_until_month_end',
      type: 'daily_cap',
      priority: recoveryNeeded > 0 ? 'high' : 'medium',
      title: 'التزم بسقف يومي حتى نهاية الفترة',
      message: `السقف اليومي الآمن المقترح حتى نهاية الفترة هو ${dailyCap} ₪.`,
      suggestedAmount: dailyCap,
    });
  }
  for (const commitment of (input.overdueCommitments || []).slice(0, 3)) {
    actions.push({
      id: `pay_overdue_${commitment.id || stableDocId(commitment.title || 'commitment')}`,
      type: 'pay_commitment',
      priority: 'critical',
      title: `سدّد الالتزام المتأخر: ${commitment.title || 'التزام'}`,
      message: `متأخر بقيمة ${commitment.amount || 0} ₪، ويضغط توقع نهاية الشهر.`,
      suggestedAmount: parsePositiveFinancialAmount(commitment.amount),
    });
  }
  for (const insight of (input.habitWarnings || []).slice(0, 3)) {
    actions.push({
      id: `reduce_habit_${insight.key || stableDocId(insight.title || 'habit')}`,
      type: insight.type === 'small_purchase_accumulation' ? 'stop_small_purchases' : 'reduce_category',
      priority: 'medium',
      title: insight.type === 'small_purchase_accumulation' ? 'جمّد المصاريف الصغيرة' : insight.title,
      message: insight.message,
      suggestedAmount: parsePositiveFinancialAmount(insight.evidence?.currentTotal || insight.evidence?.smallPurchases?.total) * 0.25,
    });
  }
  if (input.goalNeed > 0) {
    actions.push({
      id: 'protect_savings_goals',
      type: 'protect_goals',
      priority: 'medium',
      title: 'احمِ أهداف الادخار من التأخير',
      message: `الأهداف تحتاج تقريباً ${input.goalNeed} ₪ ضمن هذه الفترة للبقاء على المسار.`,
      suggestedAmount: input.goalNeed,
    });
  }
  return {
    dailyCap,
    recoveryNeeded,
    actions: actions.map((a: any) => ({ ...a, suggestedAmount: roundMoney(parsePositiveFinancialAmount(a.suggestedAmount)) })).slice(0, 8),
  };
}

export async function forecastMonthEndFinancialPosition(args: any, userId: string, token: string) {
  const adminDb = getDb(token);
  const now = args?.now ? new Date(String(args.now)) : new Date();
  const safeNow = Number.isFinite(now.getTime()) ? now : new Date();
  const window = resolveMonthEndForecastWindow(args || {}, safeNow);
  const [profileResult, safe, habits, goalsResult, commitmentsResult, recurringReview, adaptivePlansResult] = await Promise.all([
    getTreasurerProfile({}, userId, token).catch(() => ({ profile: normalizeTreasurerProfile({}), completeness: buildTreasurerProfileCompleteness(normalizeTreasurerProfile({})) })),
    getSafeSpendingLimit({ untilDate: new Date(window.end.getTime() - 1).toISOString().slice(0, 10) }, userId, token).catch((e: any) => ({ success: false, decision: 'unknown', safeSpending: {}, breakdown: {}, partial: true, error: e?.message || String(e) })),
    analyzeFinancialHabits({ period: window.mode === 'salary_cycle' ? 'salary_cycle' : 'last_30_days', insightLimit: 10, limit: Math.max(200, Math.min(1200, Number(args?.transactionLimit) || 800)) }, userId, token).catch((e: any) => ({ success: false, current: {}, insights: [], totals: {}, partial: true, error: e?.message || String(e) })),
    getSavingsGoals({ now: safeNow.toISOString() }, userId, token).catch((e: any) => ({ success: false, goals: [], partial: true, error: e?.message || String(e) })),
    getCommitments({ limit: 250 }, userId, token).catch((e: any) => ({ success: false, commitments: [], partial: true, error: e?.message || String(e) })),
    reviewRecurringCommitments({ lookAheadDays: window.daysRemaining, limit: 250 }, userId, token).catch((e: any) => ({ success: false, dueSoon: [], overdue: [], partial: true, error: e?.message || String(e) })),
    getAdaptiveBudgetPlans({ limit: 3 }, userId, token).catch((e: any) => ({ success: false, plans: [], partial: true, error: e?.message || String(e) })),
  ]);

  const safeBreakdown = (safe as any).breakdown || {};
  const safeSpending = (safe as any).safeSpending || {};
  const balances = safeBreakdown.balances || { cash: 0, palPay: 0, debt: 0, vault: 0, total: 0 };
  const liquidTotal = roundMoney(parsePositiveFinancialAmount(balances.total));
  const currentExpenseTotal = roundMoney(parsePositiveFinancialAmount((habits as any).current?.expenseTotal || (habits as any).totals?.currentExpense));
  const habitDailyAverage = currentExpenseTotal > 0 ? roundMoney(currentExpenseTotal / Math.max(1, window.elapsedDays)) : 0;
  const safeDailyAverage = roundMoney(parsePositiveFinancialAmount(safeBreakdown.dailyExpenseAverage));
  const dailyAverage = roundMoney(Math.max(habitDailyAverage, safeDailyAverage));
  const dueCommitments = roundMoney(parsePositiveFinancialAmount(safeBreakdown.dueCommitments));
  const reserveTarget = roundMoney(parsePositiveFinancialAmount(safeBreakdown.reserveTarget));
  const goalNeedFromSafe = roundMoney(parsePositiveFinancialAmount(safeBreakdown.savingsRequiredThisPeriod));
  const activeGoals = Array.isArray((goalsResult as any).goals) ? (goalsResult as any).goals : [];
  const goalNeedFromGoals = roundMoney(activeGoals
    .filter((g: any) => !['completed', 'cancelled', 'archived'].includes(String(g.status || 'active').toLowerCase()))
    .reduce((sum: number, g: any) => sum + Math.max(parsePositiveFinancialAmount(g.monthlyGap), parsePositiveFinancialAmount(g.monthlyRequired) - parsePositiveFinancialAmount(g.monthlySavedAmount)), 0));
  const goalNeed = roundMoney(Math.max(goalNeedFromSafe, goalNeedFromGoals));
  const projectedRoutineSpend = roundMoney(dailyAverage * window.daysRemaining);
  const projectedNetCash = roundMoney(liquidTotal - dueCommitments - goalNeed - projectedRoutineSpend);
  const projectedFreeCashAfterReserve = roundMoney(projectedNetCash - reserveTarget);
  const projectedGap = roundMoney(Math.max(0, -projectedFreeCashAfterReserve));
  const hardForecastDeficit = liquidTotal > 0 && reserveTarget + dueCommitments + goalNeed > 0
    ? Math.max(0, reserveTarget + dueCommitments + goalNeed - liquidTotal)
    : 0;
  const requiredRecovery = roundMoney(Math.max(
    0,
    hardForecastDeficit,
    parsePositiveFinancialAmount(safeSpending.deficitToProtected)
  ));
  const spendingReductionNeeded = roundMoney(Math.max(
    0,
    projectedGap,
    parsePositiveFinancialAmount(safeSpending.cashFlowGap) - requiredRecovery
  ));
  const availableForRoutineAfterProtected = roundMoney(Math.max(0, liquidTotal - dueCommitments - goalNeed - reserveTarget));
  const dailyCorrectionCap = roundMoney(Math.max(0, availableForRoutineAfterProtected / Math.max(1, window.daysRemaining)));
  const safeDecision = String((safe as any).decision || '').toLowerCase();
  const status = normalizeMonthEndForecastStatus(projectedFreeCashAfterReserve, projectedNetCash, requiredRecovery, dailyCorrectionCap, dailyAverage, safeDecision);
  const habitWarnings = Array.isArray((habits as any).insights) ? (habits as any).insights.filter((i: any) => i.severity === 'warning') : [];
  const overdueCommitments = Array.isArray((recurringReview as any).overdue) ? (recurringReview as any).overdue : [];
  const dueSoonCommitments = Array.isArray((recurringReview as any).dueSoon) ? (recurringReview as any).dueSoon : [];
  const correctionPlan = buildMonthEndCorrectionPlan({ requiredRecovery, projectedGap: spendingReductionNeeded, dailyCorrectionCap, overdueCommitments, habitWarnings, goalNeed });
  const confidencePenalty = [safe, habits, goalsResult, commitmentsResult, recurringReview, adaptivePlansResult].filter((r: any) => Boolean(r?.partial || !r?.success)).length * 8;
  const confidence = Math.max(35, Math.min(95, 88 - confidencePenalty - ((profileResult as any).completeness?.status === 'ready' ? 0 : 8)));
  const forecast = {
    liquidTotal,
    projectedRoutineSpend,
    dueCommitments,
    goalNeed,
    reserveTarget,
    projectedNetCash,
    projectedFreeCashAfterReserve,
    projectedGap,
    requiredRecovery,
    spendingReductionNeeded,
    hardForecastDeficit,
    dailyAverage,
    dailyCorrectionCap,
  };
  const warnings: string[] = [];
  if (dailyAverage <= 0) warnings.push('لا يوجد متوسط صرف يومي كافٍ، لذلك لا أعتبر المبلغ المتبقي كله فائضاً مؤكداً. حدّث/راجع تواريخ العمليات ثم أعد التوقع.');
  if (requiredRecovery > 0) warnings.push(`يوجد عجز فعلي ${requiredRecovery} ₪ مقابل الالتزامات/الحد الحرج/الأهداف.`);
  if (spendingReductionNeeded > 0) warnings.push(`يوجد ضغط صرف متوقع ${spendingReductionNeeded} ₪ إذا استمر نفس نمط الصرف؛ هذا تخفيض صرف مطلوب وليس تعويضاً نقدياً.`);
  if (dailyAverage > dailyCorrectionCap && dailyCorrectionCap > 0) warnings.push(`متوسط صرفك الحالي ${dailyAverage} ₪ أعلى من السقف التصحيحي ${dailyCorrectionCap} ₪.`);
  if (overdueCommitments.length) warnings.push(`يوجد ${overdueCommitments.length} التزام متكرر متأخر يضغط التوقع.`);
  if (dueSoonCommitments.length) warnings.push(`يوجد ${dueSoonCommitments.length} التزام متكرر قريب قبل نهاية الفترة.`);
  if (habitWarnings.length) warnings.push(`وجدت ${habitWarnings.length} نمط صرف تحذيري قد يرفع الصرف المتوقع.`);

  const result: any = {
    success: true,
    status,
    confidence,
    message: buildMonthEndForecastMessage(status, forecast),
    window: { key: window.key, mode: window.mode, label: window.label, startIso: window.start.toISOString(), endIso: window.end.toISOString(), elapsedDays: window.elapsedDays, daysRemaining: window.daysRemaining, totalDays: window.totalDays },
    forecast,
    correctionPlan,
    drivers: {
      topHabitWarnings: habitWarnings.slice(0, 5),
      overdueCommitments: overdueCommitments.slice(0, 5),
      dueSoonCommitments: dueSoonCommitments.slice(0, 5),
      activeGoalCount: activeGoals.length,
      latestAdaptiveBudgetPlan: Array.isArray((adaptivePlansResult as any).plans) ? (adaptivePlansResult as any).plans[0] || null : null,
    },
    warnings,
    recommendations: correctionPlan.actions.slice(0, 5).map((a: any) => a.message),
    profileCompleteness: (profileResult as any).completeness,
    sources: {
      safeSpending: { decision: (safe as any).decision, partial: Boolean((safe as any).partial) },
      habits: { status: (habits as any).status, score: (habits as any).score, partial: Boolean((habits as any).partial) },
      goals: { count: activeGoals.length, partial: Boolean((goalsResult as any).partial) },
      commitments: { count: Array.isArray((commitmentsResult as any).commitments) ? (commitmentsResult as any).commitments.length : 0, partial: Boolean((commitmentsResult as any).partial) },
      recurring: { overdue: overdueCommitments.length, dueSoon: dueSoonCommitments.length, partial: Boolean((recurringReview as any).partial) },
      adaptiveBudget: { count: Array.isArray((adaptivePlansResult as any).plans) ? (adaptivePlansResult as any).plans.length : 0, partial: Boolean((adaptivePlansResult as any).partial) },
    },
    partial: Boolean((safe as any).partial || (habits as any).partial || (goalsResult as any).partial || (commitmentsResult as any).partial || (recurringReview as any).partial || (adaptivePlansResult as any).partial),
    readEfficiency: {
      habitDocsRead: (habits as any).readEfficiency?.transactionDocsRead,
      commitmentDocsRead: (commitmentsResult as any).readEfficiency?.commitmentDocsRead,
      adaptivePlanDocsRead: (adaptivePlansResult as any).readEfficiency?.docsRead,
    },
  };

  if (parseBooleanLike(args?.save)) {
    const reportId = stableDocId(`month-end-forecast:${userId}:${window.key}:${safeNow.toISOString().slice(0, 10)}`);
    await adminDb.collection('users').doc(userId).collection('advisorMonthEndForecasts').doc(reportId).set({ userId, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), ...result }, { merge: true });
    result.savedForecastId = reportId;
  }

  if (parseBooleanLike(args?.persistAlerts) && ['month_end_deficit', 'month_end_pressure'].includes(status)) {
    await addNotification(userId, `🔮 توقع نهاية الشهر: ${result.message}`, 'warning', adminDb, {
      idempotencyKey: `advisor-month-end-forecast:${stableDocId(`${userId}:${window.key}:${status}`)}`,
      advisorAlert: true,
      advisorStatus: 'open',
      severity: status === 'month_end_deficit' ? 'critical' : 'warning',
      priority: status === 'month_end_deficit' ? 'high' : 'medium',
      category: 'month_end_forecast',
      source: 'forecastMonthEndFinancialPosition',
      metadata: { window: result.window, forecast, correctionPlan },
      actions: [
        { id: 'follow_correction_plan', label: 'اتبع خطة التصحيح', type: 'behavior' },
        { id: 'review_drivers', label: 'راجع الأسباب', type: 'review' },
        { id: 'snooze', label: 'ذكرني لاحقاً', type: 'snooze' },
      ],
    });
  }

  return result;
}

export async function getMonthEndForecasts(args: any, userId: string, token: string) {
  const adminDb = getDb(token);
  const limit = Math.max(1, Math.min(50, Number(args?.limit) || 10));
  const snap = await adminDb.collection('users').doc(userId).collection('advisorMonthEndForecasts')
    .orderBy('createdAt', 'desc')
    .limit(limit)
    .get();
  const forecasts = snap.docs.map((d: any) => ({ id: d.id, ...d.data() }));
  return { success: true, forecasts, count: forecasts.length, limit, partial: Boolean((snap as any).partial || forecasts.length >= limit), readEfficiency: { advisorMonthEndForecastLimit: limit, docsRead: snap.docs.length } };
}

function normalizeDailyPulseMode(value: any) {
  const raw = normalizeArabicText(String(value || 'morning')).toLowerCase();
  if (/evening|مساء|ليل|نهاية اليوم/.test(raw)) return 'evening';
  if (/quick|مختصر|سريع/.test(raw)) return 'quick';
  return 'morning';
}

function dailyPulsePriorityRank(value: any) {
  const raw = String(value || 'medium').toLowerCase();
  if (raw === 'critical') return 4;
  if (raw === 'high') return 3;
  if (raw === 'medium') return 2;
  if (raw === 'low') return 1;
  return 0;
}

function addDailyPulseTask(tasks: any[], task: any) {
  const id = task.id || stableDocId(`daily-pulse-task:${task.type}:${task.title}:${task.suggestedAmount || 0}`);
  if (tasks.some((item: any) => item.id === id)) return;
  tasks.push({
    id,
    type: task.type || 'review',
    title: task.title || 'مهمة مالية لليوم',
    message: task.message || '',
    priority: task.priority || 'medium',
    severity: task.severity || 'info',
    suggestedAmount: roundMoney(parsePositiveFinancialAmount(task.suggestedAmount)),
    source: task.source || 'daily_financial_pulse',
    relatedIds: Array.isArray(task.relatedIds) ? task.relatedIds.slice(0, 20) : [],
    evidence: task.evidence || {},
    createdAt: new Date().toISOString(),
  });
}

function normalizeDailyPulseStatus(input: any) {
  const safeDecision = String(input.safeDecision || '').toLowerCase();
  const forecastStatus = String(input.forecastStatus || '').toLowerCase();
  const criticalAlertCount = Number(input.criticalAlertCount || 0);
  if (input.safeCalculationOk === false) return 'daily_partial';
  if (criticalAlertCount > 0 || ['critical', 'danger'].includes(safeDecision) || forecastStatus === 'month_end_deficit') return 'daily_block';
  if (safeDecision === 'warning' || forecastStatus === 'month_end_pressure' || Number(input.warningTaskCount || 0) >= 2) return 'daily_caution';
  if (forecastStatus === 'month_end_surplus' && Number(input.safeToSpendToday || 0) >= 50) return 'daily_growth';
  return 'daily_ok';
}

function buildDailyPulseHeadline(status: string, data: any) {
  if (status === 'daily_partial') return 'قراءة نبض اليوم جزئية: لم يتم حساب سقف اليوم بنجاح، أعد المحاولة بعد تحديث البيانات.';
  if (status === 'daily_block') return `اليوم ممنوع الصرف الكمالي. ابدأ بتغطية الخطر الأعلى قبل أي شراء.`;
  if (status === 'daily_caution') return `اليوم يحتاج ضبط: سقفك الآمن ${data.safeToSpendToday || 0} ₪ ولا تتجاوز خطة التصحيح.`;
  if (status === 'daily_growth') return `اليوم وضعك يسمح بتحسين صغير: حافظ على السقف وحوّل جزءاً مناسباً لهدف أو دين.`;
  return `اليوم مستقر: سقفك الآمن ${data.safeToSpendToday || 0} ₪ مع متابعة الالتزامات القريبة.`;
}

function buildDailyDoNotSpendList(habitWarnings: any[], weeklyActions: any[], profile: any) {
  const restricted = normalizeTreasurerStringList(profile.restrictedCategories || []).map((c: string) => ({ category: c, reason: 'هذا بند مقيّد في ملف أمين الصندوق.' }));
  const fromHabits = habitWarnings.slice(0, 4).map((insight: any) => {
    const title = String(insight.title || insight.type || 'مصروف مرتفع');
    return { category: title.replace(/^ارتفاع بند\s*/i, '').trim(), reason: insight.message || 'ظهر نمط صرف مرتفع في هذا البند.' };
  });
  const fromWeekly = weeklyActions
    .filter((a: any) => ['stop', 'reduce'].includes(a.type))
    .slice(0, 4)
    .map((a: any) => ({ category: a.title || 'صرف كمالي', reason: a.message || 'الخطة الأسبوعية تقترح إيقافه أو تخفيضه.' }));
  const merged: any[] = [];
  for (const item of [...restricted, ...fromHabits, ...fromWeekly]) {
    const category = String(item.category || '').trim();
    if (!category || merged.some((m: any) => normalizeArabicText(m.category).toLowerCase() === normalizeArabicText(category).toLowerCase())) continue;
    merged.push({ category, reason: item.reason });
  }
  return merged.slice(0, 6);
}

export async function generateDailyFinancialPulse(args: any, userId: string, token: string) {
  const adminDb = getDb(token);
  const now = args?.now ? new Date(String(args.now)) : new Date();
  const safeNow = Number.isFinite(now.getTime()) ? now : new Date();
  const pulseMode = normalizeDailyPulseMode(args?.mode || args?.tone);
  const todayKey = safeNow.toISOString().slice(0, 10);
  const [profileResult, safe, habits, weeklyPlan, monthEndForecast, recurringReview, alertsResult] = await Promise.all([
    getTreasurerProfile({}, userId, token).catch(() => ({ profile: normalizeTreasurerProfile({}), completeness: buildTreasurerProfileCompleteness(normalizeTreasurerProfile({})) })),
    getSafeSpendingLimit({ period: 'today', now: safeNow.toISOString() }, userId, token).catch((e: any) => ({ success: false, decision: 'unknown', safeSpending: {}, breakdown: {}, partial: true, error: e?.message || String(e) })),
    analyzeFinancialHabits({ period: 'last_7_days', insightLimit: 6, limit: Math.max(150, Math.min(700, Number(args?.transactionLimit) || 500)) }, userId, token).catch((e: any) => ({ success: false, insights: [], current: {}, partial: true, error: e?.message || String(e) })),
    generateWeeklyFinancialRecommendations({ focus: 'weekly', habitPeriod: 'last_14_days', transactionLimit: Math.max(150, Math.min(700, Number(args?.transactionLimit) || 500)) }, userId, token).catch((e: any) => ({ success: false, actions: [], summary: {}, partial: true, error: e?.message || String(e) })),
    forecastMonthEndFinancialPosition({ horizon: 'salary_cycle', transactionLimit: Math.max(150, Math.min(900, Number(args?.transactionLimit) || 700)) }, userId, token).catch((e: any) => ({ success: false, status: 'unknown', forecast: {}, correctionPlan: { actions: [] }, partial: true, error: e?.message || String(e) })),
    reviewRecurringCommitments({ lookAheadDays: 2, limit: 150 }, userId, token).catch((e: any) => ({ success: false, dueSoon: [], overdue: [], partial: true, error: e?.message || String(e) })),
    getAdvisorAlerts({ limit: 20 }, userId, token).catch((e: any) => ({ success: false, alerts: [], partial: true, error: e?.message || String(e) })),
  ]);

  const profile = normalizeTreasurerProfile((profileResult as any).profile || {});
  const safeSpending = (safe as any).safeSpending || {};
  const safeBreakdown = (safe as any).breakdown || {};
  const safeCalculationOk = (safe as any).success !== false && Object.prototype.hasOwnProperty.call(safeSpending, 'safeToSpendToday');
  const safeToSpendToday = safeCalculationOk ? roundMoney(parsePositiveFinancialAmount(safeSpending.safeToSpendToday)) : 0;
  const safeToSpendThisWeek = safeCalculationOk ? roundMoney(parsePositiveFinancialAmount(safeSpending.safeToSpendThisWeek)) : 0;
  const liquidTotalForPulse = roundMoney(parsePositiveFinancialAmount(safeBreakdown.liquidTotal));
  const protectedTotalForPulse = roundMoney(parsePositiveFinancialAmount(safeBreakdown.protectedTotal));
  const reserveTargetForPulse = roundMoney(parsePositiveFinancialAmount(safeBreakdown.reserveTarget));
  const hardDeficitToProtected = liquidTotalForPulse > 0 && protectedTotalForPulse > 0
    ? Math.max(0, protectedTotalForPulse - liquidTotalForPulse)
    : 0;
  const hardRecoveryCandidates = [
    parsePositiveFinancialAmount(safeSpending.deficitToProtected),
    parsePositiveFinancialAmount((monthEndForecast as any).forecast?.requiredRecovery),
    parsePositiveFinancialAmount((weeklyPlan as any).summary?.requiredRecovery),
  ];
  // A configured critical floor/reserve (مثلاً 200 ₪) is not itself a recovery
  // amount when current liquidity is already above it. Recovery means an actual
  // shortage below protected obligations, not "keep 200 untouched".
  const requiredRecovery = roundMoney(Math.max(0, hardDeficitToProtected, ...hardRecoveryCandidates));
  const spendingPressureGap = roundMoney(Math.max(
    0,
    parsePositiveFinancialAmount(safeSpending.cashFlowGap) - requiredRecovery,
    parsePositiveFinancialAmount((monthEndForecast as any).forecast?.spendingReductionNeeded),
    parsePositiveFinancialAmount((weeklyPlan as any).summary?.spendingPressureGap)
  ));
  const recurringDueSoon = Array.isArray((recurringReview as any).dueSoon) ? (recurringReview as any).dueSoon : [];
  const recurringOverdue = Array.isArray((recurringReview as any).overdue) ? (recurringReview as any).overdue : [];
  const habitWarnings = Array.isArray((habits as any).insights) ? (habits as any).insights.filter((i: any) => i.severity === 'warning') : [];
  const weeklyActions = Array.isArray((weeklyPlan as any).actions) ? (weeklyPlan as any).actions : [];
  const monthEndActions = Array.isArray((monthEndForecast as any).correctionPlan?.actions) ? (monthEndForecast as any).correctionPlan.actions : [];
  const openAlerts = Array.isArray((alertsResult as any).alerts) ? (alertsResult as any).alerts.filter((a: any) => normalizeAdvisorAlertStatus(a.advisorStatus) === 'open') : [];
  const criticalAlerts = openAlerts.filter((a: any) => String(a.severity || '').toLowerCase() === 'critical');
  const tasks: any[] = [];

  if (requiredRecovery > 0) {
    addDailyPulseTask(tasks, {
      id: 'daily_recover_gap',
      type: 'recover_gap',
      priority: 'critical',
      severity: 'critical',
      title: 'لا تصرف كماليات قبل تغطية العجز',
      message: `تحتاج تعويض فعلي ${requiredRecovery} ₪ تقريباً لأن السيولة أقل من الالتزامات/الحد الحرج/الأهداف.`,
      suggestedAmount: requiredRecovery,
      source: 'safe_spending_and_forecast',
      evidence: { safeDecision: (safe as any).decision, forecastStatus: (monthEndForecast as any).status },
    });
  } else if (spendingPressureGap > 0) {
    addDailyPulseTask(tasks, {
      id: 'daily_reduce_spending_pressure',
      type: 'reduce_spending_pressure',
      priority: 'high',
      severity: 'warning',
      title: 'خفّض الصرف المتوقع',
      message: `يوجد ضغط صرف متوقع ${spendingPressureGap} ₪ إذا استمر نفس النمط. هذا ليس تعويضاً نقدياً؛ هو مقدار تخفيض مطلوب في الصرف.`,
      suggestedAmount: spendingPressureGap,
      source: 'safe_spending_and_forecast',
      evidence: { spendingPressureGap, safeDecision: (safe as any).decision, forecastStatus: (monthEndForecast as any).status },
    });
  }
  if (!safeCalculationOk) {
    addDailyPulseTask(tasks, {
      id: 'daily_safe_spending_unavailable',
      type: 'refresh_safe_spending',
      priority: 'high',
      severity: 'warning',
      title: 'أعد حساب السقف الآمن',
      message: 'لم أستطع حساب سقف اليوم من البيانات الحالية، لذلك لن أعرض صفرًا كأنه سقف مالي حقيقي.',
      suggestedAmount: 0,
      source: 'safe_spending_limit',
      evidence: { error: (safe as any).error || null, safe },
    });
  } else if (safeToSpendToday >= 0) {
    addDailyPulseTask(tasks, {
      id: 'daily_safe_spending_cap',
      type: 'daily_cap',
      priority: safeToSpendToday <= 20 ? 'high' : 'medium',
      severity: safeToSpendToday <= 20 ? 'warning' : 'info',
      title: 'التزم بسقف اليوم',
      message: `سقفك الآمن اليوم ${safeToSpendToday} ₪${safeToSpendThisWeek ? `، والأسبوع ${safeToSpendThisWeek} ₪` : ''}.`,
      suggestedAmount: safeToSpendToday,
      source: 'safe_spending_limit',
      evidence: { safeSpending, safeBreakdown },
    });
  }
  for (const commitment of [...recurringOverdue, ...recurringDueSoon].slice(0, 4)) {
    const dueKey = auditDateKey(commitment.dueDate);
    const isOverdue = dueKey && dueKey < todayKey;
    addDailyPulseTask(tasks, {
      id: `daily_commitment_${commitment.id || stableDocId(`${commitment.title}:${dueKey}`)}`,
      type: 'commitment_reminder',
      priority: isOverdue ? 'critical' : 'high',
      severity: isOverdue ? 'critical' : 'warning',
      title: isOverdue ? `التزام متأخر: ${commitment.title || 'التزام'}` : `استحقاق قريب: ${commitment.title || 'التزام'}`,
      message: `قيمته ${commitment.amount || 0} ₪ وموعده ${dueKey || 'قريب'}.`,
      suggestedAmount: parsePositiveFinancialAmount(commitment.amount),
      source: 'recurring_commitments',
      relatedIds: [commitment.id].filter(Boolean),
      evidence: { commitment },
    });
  }
  for (const action of [...monthEndActions, ...weeklyActions].filter((a: any) => ['critical', 'high'].includes(String(a.priority || '').toLowerCase())).slice(0, 5)) {
    const actionType = String(action.type || '').toLowerCase();
    const actionId = String(action.id || '').toLowerCase();
    const alreadyCoveredByPulse =
      (actionType === 'daily_cap' && tasks.some((t: any) => t.type === 'daily_cap')) ||
      (actionType === 'recover_gap' && tasks.some((t: any) => t.type === 'recover_gap')) ||
      ((actionType === 'reduce' || actionId.includes('spending_pressure')) && tasks.some((t: any) => t.type === 'reduce_spending_pressure'));
    if (alreadyCoveredByPulse) continue;
    addDailyPulseTask(tasks, {
      id: `daily_action_${action.id || stableDocId(action.title || action.message || 'action')}`,
      type: action.type || 'advisor_action',
      priority: action.priority || 'high',
      severity: action.severity || (action.priority === 'critical' ? 'critical' : 'warning'),
      title: action.title || 'نفّذ توصية الخبير',
      message: action.message || '',
      suggestedAmount: action.suggestedAmount,
      source: action.source || 'weekly_or_month_end_plan',
      relatedIds: action.relatedIds || [],
      evidence: action.evidence || action,
    });
  }
  for (const insight of habitWarnings.slice(0, 3)) {
    addDailyPulseTask(tasks, {
      id: `daily_habit_${insight.key || stableDocId(insight.title || insight.message || 'habit')}`,
      type: 'habit_guardrail',
      priority: 'medium',
      severity: 'warning',
      title: insight.type === 'small_purchase_accumulation' ? 'امنع المصاريف الصغيرة اليوم' : insight.title,
      message: insight.message,
      suggestedAmount: parsePositiveFinancialAmount(insight.evidence?.currentTotal || insight.evidence?.smallPurchases?.total) * 0.2,
      source: 'financial_habits',
      relatedIds: insight.evidence?.sampleIds || insight.evidence?.smallPurchases?.sampleIds || [],
      evidence: insight,
    });
  }
  if (criticalAlerts.length) {
    addDailyPulseTask(tasks, {
      id: 'daily_review_critical_alerts',
      type: 'review_alerts',
      priority: 'critical',
      severity: 'critical',
      title: 'راجع التنبيهات الحرجة قبل أي صرف',
      message: `يوجد ${criticalAlerts.length} تنبيه حرج مفتوح يحتاج قراراً اليوم.`,
      source: 'advisor_alerts',
      relatedIds: criticalAlerts.map((a: any) => a.id).filter(Boolean),
      evidence: { alerts: criticalAlerts.slice(0, 5) },
    });
  }

  const sortedTasks = tasks.sort((a: any, b: any) => dailyPulsePriorityRank(b.priority) - dailyPulsePriorityRank(a.priority) || parsePositiveFinancialAmount(b.suggestedAmount) - parsePositiveFinancialAmount(a.suggestedAmount)).slice(0, 10);
  const warningTaskCount = sortedTasks.filter((t: any) => ['critical', 'warning'].includes(t.severity)).length;
  const status = normalizeDailyPulseStatus({
    safeCalculationOk,
    safeDecision: (safe as any).decision,
    forecastStatus: (monthEndForecast as any).status,
    criticalAlertCount: criticalAlerts.length,
    warningTaskCount,
    safeToSpendToday,
  });
  const score = Math.max(0, Math.min(100, 100 - criticalAlerts.length * 20 - sortedTasks.filter((t: any) => t.severity === 'critical').length * 18 - sortedTasks.filter((t: any) => t.severity === 'warning').length * 8 - (requiredRecovery > 0 ? 15 : 0)));
  const doNotSpend = buildDailyDoNotSpendList(habitWarnings, weeklyActions, profile);
  const biggestRisk = sortedTasks.find((t: any) => t.severity === 'critical') || sortedTasks.find((t: any) => t.severity === 'warning') || sortedTasks[0] || null;
  const topReminder = recurringOverdue[0]
    ? `لديك التزام متأخر: ${recurringOverdue[0].title || 'التزام'} بقيمة ${recurringOverdue[0].amount || 0} ₪.`
    : recurringDueSoon[0]
      ? `استحقاق قريب: ${recurringDueSoon[0].title || 'التزام'} بقيمة ${recurringDueSoon[0].amount || 0} ₪.`
      : (profileResult as any).completeness?.nextPrompt || 'راجع سقف اليوم قبل أي شراء جديد.';
  const result: any = {
    success: true,
    date: todayKey,
    mode: pulseMode,
    status,
    score,
    headline: buildDailyPulseHeadline(status, { safeCalculationOk, safeToSpendToday }),
    summary: {
      safeCalculationOk,
      safeToSpendToday,
      safeToSpendThisWeek,
      requiredRecovery,
      spendingPressureGap,
      monthEndStatus: (monthEndForecast as any).status,
      monthEndFreeCash: (monthEndForecast as any).forecast?.projectedFreeCashAfterReserve,
      weeklyStatus: (weeklyPlan as any).status,
      habitStatus: (habits as any).status,
      criticalAlertCount: criticalAlerts.length,
      dueSoonCount: recurringDueSoon.length,
      overdueCount: recurringOverdue.length,
    },
    biggestRisk,
    topReminder,
    doNotSpend,
    tasks: sortedTasks,
    recommendations: sortedTasks.slice(0, 5).map((t: any) => t.message || t.title).filter(Boolean),
    profileCompleteness: (profileResult as any).completeness,
    sources: {
      safeSpending: { success: (safe as any).success !== false, decision: (safe as any).decision, partial: Boolean((safe as any).partial), error: (safe as any).error || null },
      habits: { status: (habits as any).status, score: (habits as any).score, partial: Boolean((habits as any).partial) },
      weeklyPlan: { status: (weeklyPlan as any).status, actionCount: weeklyActions.length, partial: Boolean((weeklyPlan as any).partial) },
      monthEndForecast: { status: (monthEndForecast as any).status, confidence: (monthEndForecast as any).confidence, partial: Boolean((monthEndForecast as any).partial) },
      recurring: { dueSoon: recurringDueSoon.length, overdue: recurringOverdue.length, partial: Boolean((recurringReview as any).partial) },
      alerts: { open: openAlerts.length, critical: criticalAlerts.length, partial: Boolean((alertsResult as any).partial) },
    },
    partial: Boolean((safe as any).partial || (habits as any).partial || (weeklyPlan as any).partial || (monthEndForecast as any).partial || (recurringReview as any).partial || (alertsResult as any).partial),
    readEfficiency: {
      habitDocsRead: (habits as any).readEfficiency?.transactionDocsRead,
      weeklyPlanHabitDocsRead: (weeklyPlan as any).readEfficiency?.habitDocsRead,
      forecastHabitDocsRead: (monthEndForecast as any).readEfficiency?.habitDocsRead,
      recurringCommitmentDocsRead: (recurringReview as any).readEfficiency?.commitmentDocsRead,
    },
  };

  if (parseBooleanLike(args?.save)) {
    const pulseId = stableDocId(`daily-pulse:${userId}:${todayKey}:${pulseMode}`);
    await adminDb.collection('users').doc(userId).collection('advisorDailyPulses').doc(pulseId).set({ userId, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), ...result }, { merge: true });
    result.savedPulseId = pulseId;
  }

  if (parseBooleanLike(args?.persistAlerts) && ['daily_block', 'daily_caution'].includes(status)) {
    await addNotification(userId, `☀️ نبض اليوم: ${result.headline}`, 'warning', adminDb, {
      idempotencyKey: `advisor-daily-pulse:${stableDocId(`${userId}:${todayKey}:${pulseMode}:${status}`)}`,
      advisorAlert: true,
      advisorStatus: 'open',
      severity: status === 'daily_block' ? 'critical' : 'warning',
      priority: status === 'daily_block' ? 'high' : 'medium',
      category: 'daily_financial_pulse',
      source: 'generateDailyFinancialPulse',
      metadata: { date: todayKey, status, summary: result.summary, biggestRisk },
      actions: [
        { id: 'follow_daily_tasks', label: 'اتبع أوامر اليوم', type: 'behavior' },
        { id: 'review_daily_risk', label: 'راجع الخطر الأكبر', type: 'review' },
        { id: 'snooze', label: 'ذكرني لاحقاً', type: 'snooze' },
      ],
    });
  }

  return result;
}

export async function getDailyFinancialPulses(args: any, userId: string, token: string) {
  const adminDb = getDb(token);
  const limit = Math.max(1, Math.min(50, Number(args?.limit) || 10));
  const snap = await adminDb.collection('users').doc(userId).collection('advisorDailyPulses')
    .orderBy('createdAt', 'desc')
    .limit(limit)
    .get();
  const pulses = snap.docs.map((d: any) => ({ id: d.id, ...d.data() }));
  return { success: true, pulses, count: pulses.length, limit, partial: Boolean((snap as any).partial || pulses.length >= limit), readEfficiency: { advisorDailyPulseLimit: limit, docsRead: snap.docs.length } };
}

export async function getFinancialDecisionContext(args: any, userId: string, token: string) {
  const adminDb = getDb(token);
  const now = new Date();
  const nowIso = now.toISOString();
  const horizon90Iso = new Date(now.getTime() - 90 * 86400000).toISOString();
  const thisMonth = nowIso.slice(0,7);
  const monthStart = `${thisMonth}-01T00:00:00.000Z`;
  const nextMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  const nextMonthStart = `${nextMonth.toISOString().slice(0, 10)}T00:00:00.000Z`;
  const next30Iso = new Date(now.getTime() + 30 * 86400000).toISOString();

  const [balanceResult, recentSnap, monthExpenseSnap, budgets, commitmentSnap, cycleTxResult] = await Promise.all([
    getBalance({}, userId, token),
    adminDb.collection('transactions')
      .where('userId', '==', userId)
      .where('date', '>=', horizon90Iso)
      .where('date', '<', nowIso)
      .limit(500)
      .get(),
    adminDb.collection('transactions')
      .where('userId', '==', userId)
      .where('date', '>=', monthStart)
      .where('date', '<', nextMonthStart)
      .where('type', '==', 'expense')
      .limit(1000)
      .get(),
    getUserBudgets(userId, adminDb),
    adminDb.collection('commitments')
      .where('userId', '==', userId)
      .where('dueDate', '<=', next30Iso)
      .limit(200)
      .get(),
    queryTransactions({ period: 'current_salary_cycle', includeTransactions: true, limit: 500 }, userId, token).catch(() => ({ transactions: [], partial: true })),
  ]);

  const balances = balanceResult.balances;
  let recent = recentSnap.docs.map((d: any) => ({ id: d.id, ...d.data() }));
  const commitments = commitmentSnap.docs.map((d: any) => ({ id: d.id, ...d.data() }));
  let monthExpenses = monthExpenseSnap.docs.map((d: any) => ({ id: d.id, ...d.data() }));
  const cycleTransactions = Array.isArray((cycleTxResult as any).transactions) ? (cycleTxResult as any).transactions : [];
  const cycleExpenses = cycleTransactions.filter((t: any) => String(t.type || '').toLowerCase() === 'expense');
  if (cycleTransactions.length > recent.length) recent = cycleTransactions;
  if (cycleExpenses.length > monthExpenses.length) monthExpenses = cycleExpenses;
  const realExpenseTxs = recent.filter((t: any) => t.type === 'expense' && t.transactionType !== 'CREDIT_PURCHASE');
  const incomeTxs = recent.filter((t: any) => t.type === 'income' && t.transactionType !== 'DEBT_BORROWING');
  const txTimes = recent.map((t: any) => transactionAnalysisDate(t)?.getTime() || 0).filter(Number.isFinite).filter((n: number) => n > 0);
  const firstTs = txTimes.length ? Math.min(...txTimes) : now.getTime();
  const historyDays = recent.length ? Math.max(7, Math.min(90, Math.ceil((now.getTime() - firstTs) / 86400000) + 1)) : 7;
  const expenseTotal = realExpenseTxs.reduce((a: number, t: any) => a + parsePositiveFinancialAmount(t.amount), 0);
  const incomeTotal = incomeTxs.reduce((a: number, t: any) => a + parsePositiveFinancialAmount(t.amount), 0);
  const dailyExpense = expenseTotal / historyDays;
  const dailyIncome = incomeTotal / historyDays;
  const due30 = commitments.filter((c: any) => c.status !== 'paid' && c.status !== 'cancelled')
    .reduce((a: number, c: any) => a + (Number(c.amount) || 0), 0);
  const projected30 = Math.round((balances.total || 0) + dailyIncome * 30 - dailyExpense * 30 - due30);
  const budgetStatus = Object.entries(budgets).map(([category, limitRaw]) => {
    const limit = Number(limitRaw) || 0;
    const spent = monthExpenses.filter((t:any)=>t.category===category).reduce((a:number,t:any)=>a+parsePositiveFinancialAmount(t.amount),0);
    return { category, limit, spent, remaining: limit-spent, percentage: limit>0?Math.round(spent/limit*100):0 };
  });
  const saturated = recent.length >= 500 || monthExpenses.length >= 1000 || commitments.length >= 200;
  return {
    success: true,
    balances,
    dailyExpenseAverage: Math.round(dailyExpense * 100) / 100,
    dailyIncomeAverage: Math.round(dailyIncome * 100) / 100,
    projected30DayBalance: projected30,
    dueCommitments30Days: due30,
    historyDays,
    confidence: saturated ? 'partial' : recent.length >= 30 ? 'good' : recent.length >= 10 ? 'medium' : 'initial',
    budgetStatus,
    commitments: commitments.filter((c:any)=>c.status!=='paid' && c.status!=='cancelled').map((c:any)=>({id:c.id,title:c.title,amount:c.amount,dueDate:c.dueDate,category:c.category,status:c.status||'pending'})),
    partial: Boolean(balanceResult.partial || (recentSnap as any).partial || (monthExpenseSnap as any).partial || (commitmentSnap as any).partial || saturated),
    readEfficiency: { accountBalanceDocsRead: 1, recentTransactionLimit: 500, monthExpenseLimit: 1000, commitmentsLimit: 200 }
  };
}

function normalizeMarketSearchText(value: any): string {
  return normalizeArabicText(value).replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
}

function marketOfferToResult(offer: any, item: string): MarketResult {
  const scope = classifyMarketScope(offer.seller || '', offer.sourceUrl || '', `${offer.location || ''} ${offer.address || ''}`);
  const normalized = normalizeCurrencyToIls(Number(offer.price || 0), offer.currency || 'ILS');
  const fxMetadata = normalized ? getFxConversionMetadata(offer.currency || 'ILS') : {};
  return {
    product: offer.product || item,
    brand: offer.brand || undefined,
    model: offer.model || undefined,
    variant: offer.variant || undefined,
    condition: offer.condition || 'unknown',
    seller: offer.seller || 'محل محفوظ في دفتر السوق',
    location: offer.location || offer.address || (scope === 'gaza' ? 'غزة' : scope === 'palestine' ? 'فلسطين' : scope === 'global' ? 'عالمي' : 'غير محدد'),
    price: Number(offer.price || 0),
    currency: offer.currency || 'ILS',
    originalPrice: Number(offer.price || 0),
    originalCurrency: offer.currency || 'ILS',
    normalizedPriceIls: normalized || undefined,
    ...fxMetadata,
    marketScope: scope,
    availability: offer.availability || 'unknown',
    source: offer.source || offer.seller || 'دفتر سوق مصروفي',
    sourceUrl: offer.sourceUrl || undefined,
    fetchedAt: offer.checkedAt || offer.createdAt || new Date().toISOString(),
    isLocalGaza: scope === 'gaza',
    confidence: offer.confidence || 'medium',
    notes: offer.notes || 'عرض محفوظ في دفتر السوق المحلي.'
  };
}

async function searchSavedMarketOffers(adminDb: any, userId: string, item: string, model?: string): Promise<MarketResult[]> {
  try {
    await refreshExchangeRatesToIls();
    const snap = await adminDb.collection('users').doc(userId).collection('marketDirectory')
      .orderBy('checkedAt', 'desc')
      .limit(300)
      .get();
    const q = normalizeMarketSearchText(`${item} ${model || ''}`);
    const terms = q.split(' ').filter(Boolean);
    return snap.docs
      .map((d: any) => ({ id: d.id, ...d.data() }))
      .filter((offer: any) => {
        const haystack = normalizeMarketSearchText(`${offer.product || ''} ${offer.brand || ''} ${offer.model || ''} ${offer.variant || ''} ${offer.seller || ''} ${offer.location || ''}`);
        if (!terms.length) return false;
        return terms.every(term => haystack.includes(term)) || haystack.includes(q) || q.includes(haystack);
      })
      .map((offer: any) => marketOfferToResult(offer, item))
      .filter((r: MarketResult) => Number(r.price) > 0)
      .sort((a: MarketResult, b: MarketResult) => {
        const scopeScore = (r: MarketResult) => r.marketScope === 'gaza' ? 0 : r.marketScope === 'palestine' ? 1 : r.marketScope === 'global' ? 2 : 3;
        const comparableIls = (r: MarketResult) => Number(r.normalizedPriceIls || (String(r.currency || 'ILS').toUpperCase() === 'ILS' ? r.price : Number.POSITIVE_INFINITY));
        return scopeScore(a) - scopeScore(b) || comparableIls(a) - comparableIls(b);
      })
      .slice(0, 20);
  } catch (e) {
    console.warn('Saved market directory search failed:', e);
    return [];
  }
}

export async function saveMarketOffer(args: any, userId: string, token: string) {
  const adminDb = getDb(token);
  const product = String(args.product || args.item || '').trim();
  const price = parsePositiveFinancialAmount(args.price);
  const seller = String(args.seller || args.store || args.shop || '').trim();
  if (!product) return { success: false, needsClarification: true, reason: 'MISSING_MARKET_PRODUCT', message: 'ما اسم السلعة التي تريد حفظ سعرها في دفتر السوق؟' };
  if (price <= 0) return { success: false, needsClarification: true, reason: 'INVALID_MARKET_PRICE', message: 'ما السعر الذي تريد حفظه؟' };
  await refreshExchangeRatesToIls();
  const now = new Date().toISOString();
  const scope = classifyMarketScope(seller, args.sourceUrl || '', `${args.location || ''} ${args.address || ''}`);
  const doc = {
    userId,
    product,
    brand: args.brand || '',
    model: args.model || '',
    variant: args.variant || '',
    condition: args.condition || 'unknown',
    seller,
    location: args.location || (scope === 'gaza' ? 'غزة' : ''),
    address: args.address || '',
    phone: args.phone || args.whatsapp || '',
    price,
    currency: args.currency || 'ILS',
    normalizedPriceIls: normalizeCurrencyToIls(price, args.currency || 'ILS') || undefined,
    availability: args.availability || 'unknown',
    source: args.source || 'إدخال المستخدم',
    sourceUrl: args.sourceUrl || '',
    confidence: args.confidence || (seller ? 'medium' : 'low'),
    marketScope: scope,
    notes: args.notes || '',
    checkedAt: args.checkedAt || now,
    createdAt: now,
    updatedAt: now,
    searchKey: normalizeMarketSearchText(`${product} ${args.brand || ''} ${args.model || ''} ${args.variant || ''} ${seller}`)
  };
  const ref = adminDb.collection('users').doc(userId).collection('marketDirectory').doc();
  await ref.set(doc);
  return { success: true, id: ref.id, offer: { id: ref.id, ...doc }, message: `حفظت سعر ${product} في دفتر سوق غزة/فلسطين للمقارنة القادمة.` };
}

export async function getMarketDirectory(args: any, userId: string, token: string) {
  const adminDb = getDb(token);
  const item = String(args.item || args.product || '').trim();
  const results = item ? await searchSavedMarketOffers(adminDb, userId, item, args.model) : [];
  if (item) return { success: true, item, results, count: results.length };
  const limit = Math.max(1, Math.min(300, Number(args.limit) || 100));
  const snap = await adminDb.collection('users').doc(userId).collection('marketDirectory')
    .orderBy('checkedAt', 'desc')
    .limit(limit)
    .get();
  const offers = snap.docs.map((d: any) => ({ id: d.id, ...d.data() }));
  return { success: true, offers, count: offers.length, limit, partial: Boolean((snap as any).partial || offers.length >= limit) };
}

function normalizeMarketWatchStatus(value: any) {
  const raw = String(value || 'watching').toLowerCase();
  return ['watching', 'paused', 'purchased', 'cancelled', 'archived'].includes(raw) ? raw : 'watching';
}

function normalizeMarketWatchPriority(value: any) {
  const raw = String(value || 'medium').toLowerCase();
  if (['high', 'urgent', 'عالي', 'مهم'].includes(raw)) return 'high';
  if (['low', 'منخفض'].includes(raw)) return 'low';
  return 'medium';
}

function marketWatchReferenceRange(market: any) {
  const comparison = market?.marketComparison || {};
  return comparison.gazaRange || comparison.palestineRange || comparison.allRange || comparison.globalRange || market?.priceRange || null;
}

function buildMarketWatchEvaluation(input: { item: any; market?: any; safe?: any; offeredPrice?: number; targetPrice?: number }) {
  const item = input.item || {};
  const offeredPrice = parsePositiveFinancialAmount(input.offeredPrice ?? item.offeredPrice ?? item.price);
  const targetPrice = parsePositiveFinancialAmount(input.targetPrice ?? item.targetPrice ?? item.maxBudget);
  const reference = marketWatchReferenceRange(input.market);
  const referenceMedian = parsePositiveFinancialAmount(reference?.median);
  const safeUntilHorizon = parsePositiveFinancialAmount(input.safe?.safeSpending?.safeToSpendUntilHorizon);
  const safeToday = parsePositiveFinancialAmount(input.safe?.safeSpending?.safeToSpendToday);
  const safeDecision = String(input.safe?.decision || '').toLowerCase();
  const marketWarnings = Array.isArray(input.market?.marketComparison?.warnings) ? input.market.marketComparison.warnings : [];
  const reasons: string[] = [];
  let decision = 'WATCH';
  let severity = 'info';

  if (['critical', 'danger'].includes(safeDecision)) {
    decision = 'WAIT_FINANCIAL_RISK';
    severity = 'critical';
    reasons.push('الوضع المالي الحالي لا يسمح بقرار شراء آمن قبل حماية الالتزامات والاحتياطي.');
  }
  if (offeredPrice > 0 && safeUntilHorizon > 0 && offeredPrice > safeUntilHorizon) {
    decision = 'WAIT_NOT_AFFORDABLE';
    severity = 'critical';
    reasons.push(`السعر المعروض ${offeredPrice} ₪ أعلى من الحد الآمن المتاح حتى نهاية الأفق (${safeUntilHorizon} ₪).`);
  }
  if (targetPrice > 0 && offeredPrice > 0 && offeredPrice > targetPrice) {
    decision = decision.startsWith('WAIT') ? decision : 'NEGOTIATE';
    severity = severity === 'critical' ? severity : 'warning';
    reasons.push(`السعر المعروض أعلى من السعر المستهدف ${targetPrice} ₪.`);
  }
  if (referenceMedian > 0 && offeredPrice > 0) {
    const pct = Math.round((offeredPrice - referenceMedian) / referenceMedian * 100);
    if (pct > 20) {
      decision = decision.startsWith('WAIT') ? decision : 'WAIT_OVERPRICED';
      severity = severity === 'critical' ? severity : 'warning';
      reasons.push(`السعر أعلى من وسيط السوق بحوالي ${pct}%.`);
    } else if (pct < -15) {
      decision = decision.startsWith('WAIT') ? decision : 'VERIFY_TOO_CHEAP';
      severity = severity === 'critical' ? severity : 'warning';
      reasons.push(`السعر أقل من السوق بحوالي ${Math.abs(pct)}%؛ تحقق من الحالة والضمان.`);
    }
  }
  if (marketWarnings.length) reasons.push(...marketWarnings.slice(0, 3));
  if (decision === 'WATCH' && offeredPrice > 0 && !reasons.length && (!targetPrice || offeredPrice <= targetPrice) && (!safeUntilHorizon || offeredPrice <= safeUntilHorizon)) {
    decision = safeDecision === 'warning' ? 'BUY_WITH_CAUTION' : 'BUY_OK';
    severity = safeDecision === 'warning' ? 'warning' : 'info';
    reasons.push('السعر لا يكسر السعر المستهدف أو الحد الآمن الحالي حسب البيانات المتاحة.');
  }
  if (decision === 'WATCH' && referenceMedian > 0 && targetPrice > 0 && referenceMedian <= targetPrice && (!safeUntilHorizon || targetPrice <= safeUntilHorizon)) {
    decision = safeDecision === 'warning' ? 'BUY_WITH_CAUTION' : 'BUY_OK';
    severity = safeDecision === 'warning' ? 'warning' : 'info';
    reasons.push('وسيط السوق قريب من السعر المستهدف والحد الآمن يسمح مبدئياً.');
  }
  if (!reasons.length) reasons.push('لا توجد بيانات كافية لإصدار قرار شراء نهائي؛ استمر بالمراقبة أو أضف سعراً معروضاً.');

  return {
    decision,
    severity,
    reasons,
    referencePrice: reference ? { min: reference.min, max: reference.max, median: reference.median, currency: reference.currency || 'ILS' } : null,
    offeredPrice: offeredPrice || null,
    targetPrice: targetPrice || null,
    safeToSpendToday: safeToday || 0,
    safeToSpendUntilHorizon: safeUntilHorizon || 0,
  };
}

function compactMarketSnapshot(market: any) {
  if (!market?.success) return null;
  const reference = marketWatchReferenceRange(market);
  return {
    item: market.item,
    model: market.model,
    priceRange: market.priceRange || null,
    marketComparison: market.marketComparison || null,
    referencePrice: reference ? { min: reference.min, max: reference.max, median: reference.median, currency: reference.currency || 'ILS' } : null,
    sourceCount: Array.isArray(market.sources) ? market.sources.length : 0,
    resultCount: Array.isArray(market.results) ? market.results.length : 0,
    directoryMatches: market.directoryMatches || 0,
    marketUnavailable: Boolean(market.marketUnavailable),
    partial: Boolean(market.partial),
    checkedAt: new Date().toISOString(),
  };
}

export async function createMarketWatchItem(args: any, userId: string, token: string) {
  const adminDb = getDb(token);
  const product = String(args.product || args.item || '').trim();
  if (!product) return { success: false, needsClarification: true, reason: 'MISSING_WATCH_PRODUCT', message: 'ما السلعة التي تريد مراقبتها؟' };
  const now = new Date().toISOString();
  const targetPrice = parsePositiveFinancialAmount(args.targetPrice || args.maxPrice || args.maxBudget);
  const offeredPrice = parsePositiveFinancialAmount(args.offeredPrice || args.price);
  const watchDoc: any = {
    userId,
    product,
    brand: args.brand || '',
    model: args.model || '',
    variant: args.variant || '',
    condition: args.condition || 'unknown',
    category: args.category || 'مشتريات مراقبة',
    paymentMethod: normalizeAccount(args.paymentMethod || args.account || 'cash'),
    targetPrice: targetPrice || null,
    maxBudget: parsePositiveFinancialAmount(args.maxBudget) || targetPrice || null,
    offeredPrice: offeredPrice || null,
    seller: args.seller || args.store || args.shop || '',
    location: args.location || '',
    priority: normalizeMarketWatchPriority(args.priority),
    desiredBy: args.desiredBy || args.dueDate || '',
    notes: args.notes || '',
    status: normalizeMarketWatchStatus(args.status || 'watching'),
    createdAt: now,
    updatedAt: now,
  };

  const shouldCheckMarket = args.runMarketCheck !== false && shouldSearchMarket(product, offeredPrice || targetPrice || undefined) && !isSmallDailyPurchase(product);
  const market = shouldCheckMarket ? await searchLocalMarket({ item: product, model: watchDoc.model, condition: watchDoc.condition, offeredPrice: offeredPrice || undefined }, userId, token).catch((e: any) => ({ success: false, marketUnavailable: true, message: e?.message || String(e) })) : null;
  const safe = await getSafeSpendingLimit({ period: 'salary_cycle' }, userId, token).catch((e: any) => ({ success: false, message: e?.message || String(e) }));
  const evaluation = buildMarketWatchEvaluation({ item: watchDoc, market, safe, offeredPrice, targetPrice });
  watchDoc.lastMarketSnapshot = compactMarketSnapshot(market);
  watchDoc.lastFinancialSnapshot = safe?.success !== false ? { decision: safe.decision, safeSpending: safe.safeSpending, message: safe.message, checkedAt: now } : null;
  watchDoc.lastEvaluation = evaluation;
  watchDoc.lastCheckedAt = now;

  const idSeed = `${userId}:${product}:${watchDoc.model}:${watchDoc.variant}:${watchDoc.condition}:${watchDoc.seller || ''}`;
  const ref = adminDb.collection('users').doc(userId).collection('marketWatchlist').doc(stableDocId(idSeed));
  const existing = await ref.get().catch(() => null);
  const preservedCreatedAt = existing?.exists ? (existing.data()?.createdAt || now) : now;
  await ref.set({ ...watchDoc, createdAt: preservedCreatedAt }, { merge: true });

  if (['critical', 'warning'].includes(evaluation.severity)) {
    await addNotification(userId, `🛒 مراقب السوق: ${product} — ${evaluation.reasons[0]}`, 'warning', adminDb, {
      idempotencyKey: `advisor-market-watch:${ref.id}:${evaluation.decision}`,
      advisorAlert: true,
      advisorStatus: 'open',
      severity: evaluation.severity,
      priority: evaluation.severity === 'critical' ? 'high' : 'medium',
      category: 'market_watchlist',
      source: 'createMarketWatchItem',
      metadata: { watchItemId: ref.id, product, evaluation },
      actions: [
        { id: 'review_market', label: 'راجع السوق', type: 'review' },
        { id: 'negotiate', label: 'فاوض السعر', type: 'behavior' },
        { id: 'snooze', label: 'ذكرني لاحقاً', type: 'snooze' },
      ],
    });
  }

  return { success: true, id: ref.id, item: { id: ref.id, ...watchDoc }, marketChecked: Boolean(market), evaluation, message: `أضفت ${product} إلى قائمة مراقبة السوق وربطتها بوضعك المالي.` };
}

export async function getMarketWatchlist(args: any, userId: string, token: string) {
  const adminDb = getDb(token);
  const limit = Math.max(1, Math.min(100, Number(args?.limit) || 50));
  const includeClosed = parseBooleanLike(args?.includeClosed);
  const status = args?.status ? normalizeMarketWatchStatus(args.status) : '';
  const snap = await adminDb.collection('users').doc(userId).collection('marketWatchlist')
    .orderBy('updatedAt', 'desc')
    .limit(limit)
    .get();
  let items = snap.docs.map((d: any) => ({ id: d.id, ...d.data() }));
  if (status) items = items.filter((item: any) => normalizeMarketWatchStatus(item.status) === status);
  if (!includeClosed) items = items.filter((item: any) => !['purchased', 'cancelled', 'archived'].includes(normalizeMarketWatchStatus(item.status)));
  const counts = items.reduce((acc: any, item: any) => {
    const decision = String(item.lastEvaluation?.decision || 'WATCH');
    const severity = String(item.lastEvaluation?.severity || 'info');
    acc.total += 1;
    acc.byDecision[decision] = (acc.byDecision[decision] || 0) + 1;
    acc.bySeverity[severity] = (acc.bySeverity[severity] || 0) + 1;
    return acc;
  }, { total: 0, byDecision: {}, bySeverity: {} });
  return { success: true, items, counts, limit, partial: Boolean((snap as any).partial || snap.docs.length >= limit), readEfficiency: { marketWatchLimit: limit, docsRead: snap.docs.length, returned: items.length } };
}

export async function updateMarketWatchItem(args: any, userId: string, token: string) {
  const id = String(args?.id || '').trim();
  if (!id) return { success: false, needsClarification: true, reason: 'MISSING_WATCH_ID', message: 'أي عنصر من قائمة مراقبة السوق تريد تحديثه؟' };
  const adminDb = getDb(token);
  const ref = adminDb.collection('users').doc(userId).collection('marketWatchlist').doc(id);
  const snap = await ref.get();
  if (!snap.exists) return { success: false, reason: 'MARKET_WATCH_ITEM_NOT_FOUND', message: 'لم أجد عنصر المراقبة المطلوب.' };
  const current = snap.data() || {};
  const patch: any = { updatedAt: new Date().toISOString() };
  for (const key of ['product', 'brand', 'model', 'variant', 'condition', 'seller', 'location', 'notes', 'desiredBy', 'category']) {
    if (args[key] !== undefined) patch[key] = args[key];
  }
  if (args.status !== undefined) patch.status = normalizeMarketWatchStatus(args.status);
  if (args.priority !== undefined) patch.priority = normalizeMarketWatchPriority(args.priority);
  if (args.targetPrice !== undefined || args.maxPrice !== undefined) patch.targetPrice = parsePositiveFinancialAmount(args.targetPrice || args.maxPrice) || null;
  if (args.maxBudget !== undefined) patch.maxBudget = parsePositiveFinancialAmount(args.maxBudget) || null;
  if (args.offeredPrice !== undefined || args.price !== undefined) patch.offeredPrice = parsePositiveFinancialAmount(args.offeredPrice || args.price) || null;
  if (args.paymentMethod !== undefined || args.account !== undefined) patch.paymentMethod = normalizeAccount(args.paymentMethod || args.account || current.paymentMethod || 'cash');

  let market: any = null;
  let safe: any = null;
  if (args.runMarketCheck !== false) {
    const next = { ...current, ...patch };
    const offeredPrice = parsePositiveFinancialAmount(next.offeredPrice);
    const targetPrice = parsePositiveFinancialAmount(next.targetPrice || next.maxBudget);
    if (shouldSearchMarket(String(next.product || ''), offeredPrice || targetPrice || undefined) && !isSmallDailyPurchase(String(next.product || ''))) {
      market = await searchLocalMarket({ item: next.product, model: next.model, condition: next.condition, offeredPrice: offeredPrice || undefined }, userId, token).catch((e: any) => ({ success: false, marketUnavailable: true, message: e?.message || String(e) }));
      patch.lastMarketSnapshot = compactMarketSnapshot(market);
    }
    safe = await getSafeSpendingLimit({ period: 'salary_cycle' }, userId, token).catch((e: any) => ({ success: false, message: e?.message || String(e) }));
    patch.lastFinancialSnapshot = safe?.success !== false ? { decision: safe.decision, safeSpending: safe.safeSpending, message: safe.message, checkedAt: patch.updatedAt } : null;
    patch.lastEvaluation = buildMarketWatchEvaluation({ item: next, market, safe, offeredPrice, targetPrice });
    patch.lastCheckedAt = patch.updatedAt;
  }

  await ref.set(patch, { merge: true });
  const updatedSnap = await ref.get();
  return { success: true, id, item: { id, ...updatedSnap.data() }, marketChecked: Boolean(market), evaluation: patch.lastEvaluation || current.lastEvaluation };
}

export async function reviewMarketWatchlist(args: any, userId: string, token: string) {
  const list = await getMarketWatchlist({ limit: args?.limit || 20 }, userId, token);
  const items = Array.isArray(list.items) ? list.items : [];
  const reviewed: any[] = [];
  for (const item of items.slice(0, Math.max(1, Math.min(10, Number(args?.reviewLimit) || 5)))) {
    const updated = await updateMarketWatchItem({ id: item.id, runMarketCheck: true }, userId, token).catch((e: any) => ({ success: false, id: item.id, error: e?.message || String(e) }));
    reviewed.push(updated);
  }
  const actionable = reviewed.filter((r: any) => ['BUY_OK', 'BUY_WITH_CAUTION', 'NEGOTIATE', 'WAIT_OVERPRICED', 'VERIFY_TOO_CHEAP'].includes(String(r.evaluation?.decision || r.item?.lastEvaluation?.decision || '')));
  return { success: true, reviewed, actionable, count: reviewed.length, message: actionable.length ? `راجعت القائمة ووجدت ${actionable.length} عنصر يحتاج قرار شراء/تفاوض.` : 'راجعت قائمة المشتريات ولم أجد قرار شراء واضح الآن.' };
}

// V6.1: real local-market lookup with source-backed result model, freshness,
// Gaza priority, cache, and explicit MARKET_DATA_UNAVAILABLE on failure.
// Never invents prices. Returns structured MarketResult[] with sources + timestamps.
export async function searchLocalMarket(args: any, userId: string, token: string): Promise<MarketSearchResponse | any> {
  const item = String(args?.item || '').trim();
  const model = String(args?.model || '').trim();
  const condition = String(args?.condition || '').trim().toLowerCase();
  if (!item) return { success: false, needsClarification: true, message: 'ما السلعة التي تريد مقارنة سعرها؟' };

  // V6.1 (PHASE 31): refuse small daily purchases — no market search needed.
  if (isSmallDailyPurchase(item)) {
    return {
      success: false,
      marketUnavailable: true,
      message: 'هذه السلعة يومية ولا تحتاج مقارنة أسعار. سجّلها كمصروف مباشرة.',
    };
  }

  const adminDb = getDb(token);
  const savedResults = await searchSavedMarketOffers(adminDb, userId, item, model);

  // V6.1: check cache first (reduces API cost + latency), but blend the user's Gaza market directory first.
  const cached = getCachedMarketResult({ product: item, model, condition });
  if (cached) {
    const merged = [...savedResults, ...(cached.results || [])];
    const marketComparison = buildMarketComparison(merged, Number(args.offeredPrice || args.price || 0) || undefined);
    return { ...cached, results: merged, marketComparison, priceRange: computeNormalizedPriceRange(merged) || cached.priceRange, directoryMatches: savedResults.length };
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    if (savedResults.length) {
      const marketComparison = buildMarketComparison(savedResults, Number(args.offeredPrice || args.price || 0) || undefined);
      return { success: true, item, model: model || undefined, results: savedResults, priceRange: computeNormalizedPriceRange(savedResults) || undefined, marketComparison, sources: [], searchQueries: [], summary: 'اعتمدت على دفتر سوق غزة/فلسطين المحفوظ لديك لأن البحث الحي غير متاح.', directoryMatches: savedResults.length };
    }
    return { success: false, marketUnavailable: true, message: 'البحث الحي في السوق غير متاح حالياً لأن مفتاح Gemini غير مهيأ على الخادم.' };
  }
  try {
    const ai = new GoogleGenAI({ apiKey });
    const q = `أنت باحث أسعار صارم لمستخدم من غزة. ابحث في الويب عن أسعار حديثة ومتاحة فعلياً للسلعة: ${item}${model ? `، الموديل: ${model}` : ''}${condition ? `، الحالة: ${condition}` : ''}.
رتّب البحث والنتيجة بهذا التسلسل الإلزامي:
1) سوق غزة وقطاع غزة أولاً: محلات، صفحات فيسبوك/إنستغرام/مواقع محلية، عناوين وأرقام إن وجدت.
2) السوق الفلسطيني الأوسع ثانياً: الضفة/رام الله/نابلس/الخليل/القدس كمرجع محلي فلسطيني.
3) السوق العالمي ثالثاً: أسعار عالمية مرجعية من مواقع موثوقة أو متاجر عالمية، مع توضيح أن الشحن/الجمارك/التوفر قد تغيّر المقارنة.
أعطِ فقط أسعاراً لها مصدر واضح. لا تخترع متجراً أو سعراً أو عنواناً. لكل سعر اذكر: النطاق (غزة/فلسطين/عالمي)، اسم البائع/المصدر، الموقع/العنوان إن وجد، السعر والعملة، حالة السلعة جديدة/مستعملة إن أمكن، وتاريخ/حداثة المعلومة. إن لم تجد غزة قل ذلك صراحة ولا تستبدلها بالعالمي دون تنبيه.`;
    const response: any = await ai.models.generateContent({ model: 'gemini-2.5-flash', contents: q, config: { tools: [{ googleSearch: {} }] } });
    const meta = response?.candidates?.[0]?.groundingMetadata;
    const groundingChunks = (meta?.groundingChunks || []).map((c: any) => c?.web).filter(Boolean);
    const sources = groundingChunks.map((w: any) => {
      const scope = classifyMarketScope(w.title || '', w.uri || '', '');
      return {
        title: w.title,
        uri: w.uri,
        isLocalGaza: isGazaSource(w.title || '', w.uri || '') || scope === 'gaza',
        marketScope: scope,
      };
    }).slice(0, 12);

    // V6.1: extract structured price results from Gemini's text response.
    const text = String(response.text || '');
    const extractedPrices = extractPricesFromText(text);
    const now = new Date().toISOString();
    const liveResults: MarketResult[] = extractedPrices.map((p, i) => {
      const scope = (sources[i] as any)?.marketScope || classifyMarketScope(sources[i]?.title || '', sources[i]?.uri || '', '');
      const normalized = normalizeCurrencyToIls(p.price, p.currency);
      const fxMetadata = normalized ? getFxConversionMetadata(p.currency) : {};
      return {
        product: item,
        model: model || undefined,
        condition: (condition as any) || 'unknown',
        // Try to associate a source with each price (best-effort).
        seller: sources[i]?.title || 'غير محدد',
        location: scope === 'gaza' ? 'غزة' : scope === 'palestine' ? 'فلسطين' : scope === 'global' ? 'عالمي (مرجعي)' : 'غير محدد',
        price: p.price,
        currency: p.currency,
        originalPrice: p.price,
        originalCurrency: p.currency,
        normalizedPriceIls: normalized || undefined,
        ...fxMetadata,
        marketScope: scope,
        availability: 'unknown',
        source: sources[i]?.title || 'Gemini + Google Search',
        sourceUrl: sources[i]?.uri,
        fetchedAt: now,
        isLocalGaza: sources[i]?.isLocalGaza ?? scope === 'gaza',
        confidence: scope === 'gaza' ? 'high' : scope === 'palestine' ? 'medium' : 'low',
        notes: `Raw: "${p.raw}"`,
      };
    });
    const results: MarketResult[] = [...savedResults, ...liveResults];

    const priceRange = computeNormalizedPriceRange(results) || computePriceRange(results);
    const marketComparison = buildMarketComparison(results, Number(args.offeredPrice || args.price || 0) || undefined);

    const searchResponse: MarketSearchResponse = {
      success: true,
      item,
      model: model || undefined,
      results,
      priceRange: priceRange || undefined,
      marketComparison,
      sources,
      searchQueries: meta?.webSearchQueries || [],
      summary: text,
      partial: results.length === 0,  // partial = we got text but couldn't extract structured prices
      directoryMatches: savedResults.length,
    } as any;

    // Cache the result.
    cacheMarketResult({ product: item, model, condition }, searchResponse);

    return searchResponse;
  } catch (e: any) {
    return { success: false, marketUnavailable: true, message: 'تعذر التحقق من أسعار السوق المحلي الآن، لذلك لن أقدم سعراً غير موثوق.', error: String(e?.message || e) };
  }
}

export async function assessPurchase(args: any, userId: string, token: string) {
  const price = parsePositiveFinancialAmount(args?.price);
  if (!price) return { success:false, needsClarification:true, message:'كم السعر المعروض عليك؟' };
  const ctx:any = await getFinancialDecisionContext({}, userId, token);
  const account = normalizeAccount(args?.paymentMethod || 'cash');
  const available = account === 'palPay' ? Number(ctx.balances.palPay||0) : account === 'cash' ? Number(ctx.balances.cash||0) : Number(ctx.balances.total||0);
  const after = available - price;
  const projectedAfter = Number(ctx.projected30DayBalance||0) - (account === 'debt' ? 0 : price);
  const daysCoverage = ctx.dailyExpenseAverage > 0 ? Math.floor(Math.max(0, after) / ctx.dailyExpenseAverage) : null;
  const categoryBudget = (ctx.budgetStatus||[]).find((b:any)=>b.category===args?.category);
  const projectedBudgetPct = categoryBudget?.limit > 0 ? Math.round((categoryBudget.spent + price)/categoryBudget.limit*100) : null;
  const warnings:string[]=[];
  if (account !== 'debt' && after < 0) warnings.push(`الرصيد في الحساب لا يكفي؛ العجز الفوري ${Math.abs(after)} ₪.`);
  if (projectedAfter < 0) warnings.push(`بعد هذا الشراء يُتوقع عجز خلال 30 يوماً بحوالي ${Math.abs(projectedAfter)} ₪ وفق نمط الصرف والالتزامات الحالية.`);
  if (projectedBudgetPct !== null && projectedBudgetPct >= 100) warnings.push(`الشراء سيرفع بند ${args.category} إلى نحو ${projectedBudgetPct}% من سقفه الشهري.`);
  if (String(args?.necessity||'') === 'كمالي' && daysCoverage !== null && daysCoverage < 14) warnings.push(`بعد الشراء يغطي الرصيد المتبقي قرابة ${daysCoverage} يوماً فقط وفق متوسط صرفك الحالي.`);
  const goalImpact: any = await assessFinancialGoalImpact({
    amount: price,
    category: args?.category || args?.item || 'مشتريات',
    item: args?.item || args?.product || '',
    product: args?.product || args?.item || '',
    necessity: args?.necessity || '',
    period: 'salary_cycle',
    goalLimit: 3,
  }, userId, token).catch((e: any) => ({ success: false, error: e?.message || String(e) }));
  if (goalImpact?.severity === 'critical') warnings.push(`تأثير الأهداف: ${goalImpact.message}`);
  else if (goalImpact?.severity === 'warning') warnings.push(`تنبيه أهداف: ${goalImpact.message}`);
  const decision = goalImpact?.decision === 'GOAL_AT_RISK' ? 'GOAL_RISK' : warnings.length ? 'CAUTION' : 'OK';
  return { success:true, decision, warnings, price, paymentMethod:account, availableBefore:available, availableAfter:after, projected30DayBalanceAfterPurchase:projectedAfter, dailyExpenseAverage:ctx.dailyExpenseAverage, daysCoverage, categoryBudget, projectedBudgetPercentage:projectedBudgetPct, goalImpact, confidence:ctx.confidence };
}

export const DEFAULT_BUDGETS: Record<string, number> = {
  'الأبناء': 1500,
  'طعام ومشتريات منزل': 2000,
  'زيارات وضيافة': 600,
  'مواصلات': 500,
  'فواتير والتزامات': 800,
  'صحة وعلاج': 600,
  'تعليم وتدريب': 800,
  'أخرى': 500
};

export async function getUserCustomBudgetDocs(userId: string, adminDb: any): Promise<Array<{ id: string; category: string; limit: number; data: any }>> {
  const snapshot = await adminDb.collection('users').doc(userId).collection('budgets').get();
  return snapshot.docs.map((d: any) => {
    const data = d.data() || {};
    return { id: d.id, category: data.category || d.id, limit: Number(data.limit) || 0, data };
  });
}

export async function getUserBudgets(userId: string, adminDb: any): Promise<Record<string, number>> {
  // Return only budgets the user explicitly saved. DEFAULT_BUDGETS is a setup
  // template, not real income and not an active monthly budget. Treating the
  // template as active made users with 3k-5k income see a fake 7300 ₪ budget.
  const customDocs = await getUserCustomBudgetDocs(userId, adminDb);
  const userBudgets: Record<string, number> = {};
  customDocs.forEach((b) => {
    if (b.limit) userBudgets[b.category || b.id] = Number(b.limit);
  });
  return userBudgets;
}

type ExpensePaymentSplit = { account: 'cash' | 'palPay' | 'debt'; amount: number; note?: string };

function normalizeSplitPaymentAccount(value: unknown): ExpensePaymentSplit['account'] | null {
  const text = normalizeArabicText(String(value || ''));
  if (/palpay|pal pay|بال\s*باي|بالباي|بال\s*بي|بالبي|بل\s*بي|بالبى|balbea|balbe|محفظ/.test(text)) return 'palPay';
  if (/كاش|نقد|نقدي|نقدا/.test(text)) return 'cash';
  if (/دين|بالدين|اجل|آجل|على الحساب|عال حساب|عالحساب/.test(text)) return 'debt';
  return null;
}

function parseExpensePaymentSplitsFromText(value: unknown): ExpensePaymentSplit[] {
  const text = normalizeArabicText(normalizeDigits(String(value || '')));
  if (!text) return [];
  const amount = '(\\d+(?:[\\.,]\\d+)?|شيكل|واحد|واحدة)';
  const currency = '(?:\\s*(?:ش|شيكل|₪|ils|nis|دولار|دينار|دنانير))?';
  const account = '(palpay|pal pay|بال\\s*باي|بالباي|بال\\s*بي|بالبي|بل\\s*بي|بالبى|balbea|balbe|محفظه|محفظة|كاش|نقد|نقدي|نقدا|دين|بالدين|اجل|آجل|على\\s*الحساب|عال\\s*حساب|عالحساب)';
  const candidates: Array<{ account: ExpensePaymentSplit['account']; amount: number; index: number }> = [];
  const addCandidate = (rawAccount: string, rawAmount: string, index: number) => {
    const normalizedAccount = normalizeSplitPaymentAccount(rawAccount);
    const normalizedAmountText = normalizeArabicText(String(rawAmount || ''));
    const parsedAmount = /^(شيكل|واحد|واحدة)$/.test(normalizedAmountText) ? 1 : Number(String(rawAmount || '').replace(',', '.'));
    if (!normalizedAccount || !Number.isFinite(parsedAmount) || parsedAmount <= 0) return;
    candidates.push({ account: normalizedAccount, amount: Math.round(parsedAmount * 100) / 100, index });
  };
  const amountBeforeAccount = new RegExp(`${amount}${currency}\\s*(?:من\\s+|على\\s+|بال\\s+)?${account}`, 'gi');
  for (const match of text.matchAll(amountBeforeAccount)) {
    addCandidate(match[2], match[1], match.index || 0);
  }
  const accountBeforeAmount = new RegExp(`${account}\\s*(?:ب|بـ|بقيمه|بقيمة|قيمه|قيمة|مبلغ|قدره|من)?\\s*${amount}${currency}`, 'gi');
  for (const match of text.matchAll(accountBeforeAmount)) {
    addCandidate(match[1], match[2], match.index || 0);
  }
  if (candidates.length < 2) return [];
  const byAccount = new Map<ExpensePaymentSplit['account'], ExpensePaymentSplit>();
  for (const candidate of candidates.sort((a, b) => a.index - b.index)) {
    const existing = byAccount.get(candidate.account);
    if (existing) existing.amount = Math.round((existing.amount + candidate.amount) * 100) / 100;
    else byAccount.set(candidate.account, { account: candidate.account, amount: candidate.amount });
  }
  const splits = Array.from(byAccount.values()).filter(s => s.amount > 0);
  return splits.length >= 2 ? splits : [];
}

function normalizeExpensePaymentSplits(args: any): ExpensePaymentSplit[] {
  const raw = Array.isArray(args?.expensePaymentSplits) ? args.expensePaymentSplits
    : Array.isArray(args?.paymentSplits) ? args.paymentSplits
    : Array.isArray(args?.expenseSplit) ? args.expenseSplit
    : [];
  const explicit: ExpensePaymentSplit[] = [];
  for (const rawItem of raw) {
    const item = rawItem && typeof rawItem === 'object' ? rawItem : {};
    const account = normalizeSplitPaymentAccount(item.account || item.paymentMethod || item.wallet || item.method);
    const amount = parseAbsoluteFinancialAmount(item.amount);
    if (account && amount > 0) explicit.push({ account, amount, note: String(item.note || item.notes || '') });
  }
  if (explicit.length >= 2) return explicit;
  if (args?.disableExpenseSplitParsing) return [];
  return parseExpensePaymentSplitsFromText([
    args?.clarificationReplyText,
    args?.currentUserText,
    args?.userText,
  ].map(v => String(v || '').trim()).filter(Boolean).join(' '));
}

export async function addTransaction(args: any, userId: string, token: string) {
  const adminDb = getDb(token);
  console.log("TOOL CALL: addTransaction", args);
  
  const expensePaymentSplits = normalizeExpensePaymentSplits(args);
  const splitPaymentTotalAmount = Math.round(expensePaymentSplits.reduce((sum, split) => sum + Number(split.amount || 0), 0) * 100) / 100;
  const amount = parseAbsoluteFinancialAmount(args.amount) || splitPaymentTotalAmount;

  const originalUtteranceText = normalizeArabicText([
    args.userText,
    args.currentUserText,
    args.clarificationReplyText,
  ].map(v => String(v || '').trim()).filter(Boolean).join(' ')).toLowerCase();
  const hasOriginalUserUtterance = Boolean(originalUtteranceText.trim());
  const modelIntentText = normalizeArabicText(`${args.type || ''} ${args.category || ''} ${args.subcategory || ''} ${args.notes || ''} ${args.description || ''} ${args.item || ''} ${args.purchaseItem || ''} ${args.merchant || ''} ${args.creditor || ''} ${args.seller || ''}`).toLowerCase();
  const textToCheck = `${originalUtteranceText} ${modelIntentText}`;

  if (args.fromAccount && args.toAccount) {
    return await transferMoney(args, userId, token);
  }

  let type = String(args.type || 'expense').toLowerCase();
  if (type.includes('صرف') || type.includes('مصروف') || type.includes('دفع') || type.includes('شراء')) type = 'expense';
  if (type.includes('دخل') || type.includes('قبض') || type.includes('راتب') || type.includes('إيداع') || type.includes('ايداع') || type.includes('مرحل') || type.includes('تحويل لي') || type.includes('income')) type = 'income';
  if (type !== 'income' && type !== 'expense') type = 'expense';

  const explicitDebtInUserText = /(?:^|[^ء-يa-z0-9])(?:دين|دينا|ديناً|كدين|بالدين|اجل|على الحساب|عال حساب|عالحساب|credit_purchase|debt)(?:$|[^ء-يa-z0-9])/.test(originalUtteranceText);
  const explicitPalPayInUserText = /(?:^|[^ء-يa-z0-9])(?:palpay|pal pay|بال باي|البال باي|بال بي|بالبي|بل بي|بالبى|balbea|balbe|محفظه|محفظة)(?:$|[^ء-يa-z0-9])/.test(originalUtteranceText);
  const explicitCashInUserText = /(?:^|[^ء-يa-z0-9])(?:كاش|نقد|نقدا|نقدي)(?:$|[^ء-يa-z0-9])/.test(originalUtteranceText);
  const explicitPaymentMentionCount = [explicitDebtInUserText, explicitPalPayInUserText, explicitCashInUserText].filter(Boolean).length;
  const originalTextHasMixedPaymentMethods = explicitPaymentMentionCount > 1;
  const explicitUserPaymentAccount = explicitPaymentMentionCount === 1
    ? (explicitDebtInUserText ? 'debt' : explicitPalPayInUserText ? 'palPay' : explicitCashInUserText ? 'cash' : '')
    : '';
  const rawStructuredUserPaymentAccount = args.paymentMethod || args.account || '';
  const structuredUserPaymentAccount = rawStructuredUserPaymentAccount ? normalizeAccount(rawStructuredUserPaymentAccount) : '';
  const structuredPaymentProvided = ['cash', 'palPay', 'debt'].includes(structuredUserPaymentAccount)
    && Boolean(args.paymentMethod || args.account);
  const userConfirmedPaymentByClarification = structuredPaymentProvided
    && Boolean(args.paymentMethodClarifiedByUser || args.accountClarifiedByUser || args.creditPurchaseClarifiedByUser);
  const mentionsDebt = hasOriginalUserUtterance
    ? explicitDebtInUserText
    : /دين|بالدين|اجل|آجل|على الحساب|credit_purchase|paymentmethod debt|account debt/.test(textToCheck);
  const mentionsPurchase = /اشتريت|شريت|شراء|مشتريات|مصروف|سجل|سجلي|قيد|قيدي/.test(textToCheck);
  const mentionsDebtRepayment = /سداد|تسديد|سدد|سديت|دفع دين|دفعت دين/.test(textToCheck);
  const mentionsCashBorrowing = (
    /اخذت\s+(?:مبلغ\s+)?(?:دين|دينا|ديناً|كدين|سلفه|سلفة|قرض)/.test(textToCheck)
    || /اخدت\s+(?:مبلغ\s+)?(?:دين|دينا|ديناً|كدين|سلفه|سلفة|قرض)/.test(textToCheck)
    || /استلمت\s+(?:مبلغ\s+)?(?:دين|دينا|ديناً|كدين|سلفه|سلفة|قرض)/.test(textToCheck)
    || /(?:اخذت|اخدت|استلمت)\s+.*(?:من|مِن|عن\s+طريق)\s+.*(?:دين|دينا|ديناً|كدين|سلفه|سلفة|قرض)/.test(textToCheck)
    || /استدنت|اقترضت|سلفني|سلفتني|داينني|دينني|اعطاني\s+دين|اعطتني\s+دين|أعطاني\s+دين|أعطتني\s+دين/.test(textToCheck)
  ) && !/اشتريت|شريت|شراء|مشتريات/.test(textToCheck);
  const structuredCreditPurchaseIntent = String(args.transactionType || '').toUpperCase() === 'CREDIT_PURCHASE'
    || normalizeAccount(args.paymentMethod) === 'debt'
    || normalizeAccount(args.account) === 'debt';
  const forcedCreditPurchaseIntent = type === 'expense'
    && (hasOriginalUserUtterance
      ? ((structuredCreditPurchaseIntent && (explicitDebtInUserText || userConfirmedPaymentByClarification)) || (explicitDebtInUserText && mentionsPurchase))
      : structuredCreditPurchaseIntent || (mentionsDebt && mentionsPurchase))
    && !mentionsDebtRepayment
    && !mentionsCashBorrowing;

  if (mentionsCashBorrowing) {
    const creditor = String(args.creditor || args.person || args.merchant || args.seller || args.store || args.vendor || '').trim();
    if (!creditor) {
      return { success: false, needsClarification: true, reason: 'MISSING_CREDITOR', missingFields: ['creditor'], message: 'من أي شخص أخذت الدين؟' };
    }
    const structuredBorrowDestination = normalizeAccount(args.toAccount || args.account || args.paymentMethod);
    const borrowDestination = explicitPalPayInUserText || structuredBorrowDestination === 'palPay'
      ? 'palPay'
      : explicitCashInUserText || structuredBorrowDestination === 'cash'
        ? 'cash'
        : '';
    if (!borrowDestination) {
      return { success: false, needsClarification: true, reason: 'MISSING_BORROW_DESTINATION', missingFields: ['borrowDestination'], message: 'استلمت الدين كاش أم في محفظة PalPay؟' };
    }
    return await transferMoney({
      ...args,
      amount,
      fromAccount: 'debt',
      toAccount: borrowDestination,
      creditor,
      person: creditor,
      merchant: creditor,
      transactionType: 'DEBT_BORROWING',
      notes: args.notes || `أخذت دين ${amount} ₪ من ${creditor}`,
    }, userId, token);
  }

  const paymentWasProvided = hasOriginalUserUtterance
    ? Boolean(explicitUserPaymentAccount || originalTextHasMixedPaymentMethods || structuredPaymentProvided || forcedCreditPurchaseIntent || userConfirmedPaymentByClarification)
    : Boolean(structuredPaymentProvided || forcedCreditPurchaseIntent);
  const confirmedStructuredPaymentAccount = userConfirmedPaymentByClarification && ['cash', 'palPay', 'debt'].includes(structuredUserPaymentAccount)
    ? structuredUserPaymentAccount
    : '';
  const splitOrMixedStructuredPaymentAccount = structuredPaymentProvided
    && ['cash', 'palPay', 'debt'].includes(structuredUserPaymentAccount)
    && (originalTextHasMixedPaymentMethods || expensePaymentSplits.length >= 2 || args.disableExpenseSplitParsing === true)
      ? structuredUserPaymentAccount
      : '';
  let account = forcedCreditPurchaseIntent ? 'debt' : (splitOrMixedStructuredPaymentAccount || confirmedStructuredPaymentAccount || explicitUserPaymentAccount || (structuredPaymentProvided ? structuredUserPaymentAccount : '') || normalizeAccount(args.paymentMethod || args.account || 'cash'));
  if (args.disableExpenseSplitParsing === true && ['cash', 'palPay', 'debt'].includes(structuredUserPaymentAccount)) {
    account = structuredUserPaymentAccount;
  }
  let category = String(args.category || '').trim();
  let subcategory = String(args.subcategory || '').trim();
  const merchant = String(args.merchant || args.creditor || args.seller || args.store || args.vendor || args.person || '').trim();
  const notes = String(args.notes || '').trim();
  let necessity = String(args.necessity || '').trim();
  const explicitNecessityProvided = Boolean(necessity);
  const explicitCategoryProvided = Boolean(String(args.category || '').trim());
  const explicitSubcategoryProvided = Boolean(String(args.subcategory || '').trim());
  const explicitPurchaseItem = String(args.item || args.description || args.purchaseItem || args.what || '').trim();
  const beneficiary = String(args.beneficiary || args.forWhom || args.forWho || args.person || '').trim();
  const categorySuggestion = inferCategory({ type, category, subcategory, notes, merchant, item: explicitPurchaseItem });
  category = category || categorySuggestion.category;
  subcategory = subcategory || categorySuggestion.subcategory;
  if (type === 'income' && (!args.category || category === 'أخرى')) {
    category = 'دخل';
    subcategory = /راتب|salary|قبض/i.test(`${notes} ${args.category || ''}`) ? 'راتب' : 'دخل عام';
  }
  const originalExpenseText = String(args.userText || '').trim();
  const clarifiedPurchaseItemProvided = Boolean(args.purchaseItemClarifiedByUser || args.itemClarifiedByUser || args.descriptionClarifiedByUser);
  const clarifiedBeneficiaryProvided = Boolean(args.beneficiaryClarifiedByUser || args.purposeClarifiedByUser || args.forWhomClarifiedByUser || args.forWhoClarifiedByUser);
  const expenseIdentitySource = [
    originalExpenseText,
    explicitPurchaseItem,
    beneficiary,
    notes,
    args.currentUserText,
    args.clarificationReplyText,
  ].filter(Boolean).join(' ') || `${explicitPurchaseItem} ${beneficiary} ${notes}`;
  const normalizedExpenseIdentitySource = normalizeArabicText(expenseIdentitySource);
  const beneficiaryPurposeRegex = /(للاولاد|للأولاد|للابناء|للأبناء|للعيال|للاطفال|للأطفال|للبنات|للبيت|للدار|للمنزل|للعيله|للعيلة|للعائله|للعائلة|للزوجة|لزوجتي|للزوج|لزوجي|للام|للأم|لامي|لأمي|للاب|للأب|لابوي|لأبوي|للعمل|للمدرسه|للمدرسة|للجامعه|للجامعة|للعلاج|للدواء|للضيافه|للضيافة|للضيف|للضيوف|للزياره|للزيارة|لنفسى|لنفسي|الي|إلي|الاولاد|الأولاد|الابناء|الأبناء|العيال|الاطفال|الأطفال|البنات|البيت|الدار|المنزل|العيله|العيلة|العائله|العائلة|زوجتي|زوجي|امي|أمي|ابوي|أبوي|العمل|المدرسه|المدرسة|الجامعه|الجامعة|العلاج|الدواء|الضيافه|الضيافة|الضيف|الضيوف|الزياره|الزيارة)/;
  const cleanedExpenseIdentity = normalizedExpenseIdentitySource
    .replace(normalizeArabicText(merchant), ' ')
    .replace(/شراء|اشتريت|شريت|اشتري|اخذت|اخدت|مصروف|دفعت|دفع|سجل|سجلي|تسجيل|قيد|مبلغ|قيمه|قيمة|شيكل|ش|₪|كاش|نقد|محفظه|محفظة|بال باي|palpay|pal pay|دين|بالدين|من|عند|على|ب|بـ/g, ' ')
    .replace(/\d+(\.\d+)?/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const cleanedPurchaseItemIdentity = normalizedExpenseIdentitySource
    .replace(normalizeArabicText(merchant), ' ')
    .replace(beneficiaryPurposeRegex, ' ')
    .replace(/شراء|اشتريت|شريت|اشتري|اخذت|اخدت|مصروف|دفعت|دفع|سجل|سجلي|تسجيل|قيد|مبلغ|قيمه|قيمة|شيكل|ش|₪|كاش|نقد|محفظه|محفظة|بال باي|palpay|pal pay|دين|بالدين|من|عند|على|ب|بـ|لأجل|لاجل|عشان|علشان/g, ' ')
    .replace(/\d+(\.\d+)?/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const userProvidedBeneficiaryPurpose = beneficiaryPurposeRegex.test(normalizedExpenseIdentitySource);
  const purchaseItemForRecord = explicitPurchaseItem || cleanedPurchaseItemIdentity || cleanedExpenseIdentity;
  const beneficiaryForRecord = beneficiary || (userProvidedBeneficiaryPurpose ? (normalizedExpenseIdentitySource.match(beneficiaryPurposeRegex)?.[0] || '') : '');

  const necessitySuggestion = type === 'expense'
    ? inferNecessityForGazaContext({ category, subcategory, notes, merchant, item: purchaseItemForRecord, amount })
    : null;
  if (type === 'expense' && !necessity && necessitySuggestion && necessitySuggestion.necessity !== 'محتاج تأكيد' && necessitySuggestion.confidence !== 'low') {
    necessity = necessitySuggestion.necessity;
  }

  const transactionNow = new Date();
  const dateResult = normalizeHistoricalTransactionDate({
    date: args.date,
    historicalMonth: args.historicalMonth || args.monthContext || args.entryMonth,
    day: args.day || args.transactionDay,
    year: args.year || args.salaryYear,
    now: transactionNow,
  } as any);
  if (dateResult.ok === false) {
    return {
      success: false,
      needsClarification: true,
      reason: dateResult.reason,
      message: dateResult.message,
    };
  }

  // Treasurer Mode: income must not be silently dumped into cash.
  // Salary/income needs an explicit destination or a split between cash and PalPay.
  if (type === 'income') {
    const allocations = normalizeIncomeAllocations(args);
    if (allocations.length > 0) {
      const totalAllocated = allocations.reduce((s, a) => s + a.amount, 0);
      if (Math.abs(totalAllocated - amount) > 0.01) {
        return {
          success: false,
          needsClarification: true,
          reason: 'INCOME_SPLIT_MISMATCH',
          message: `مجموع توزيع الدخل (${totalAllocated} ₪) لا يساوي المبلغ الكلي (${amount} ₪). قل لي كم نقدي وكم PalPay بالضبط.`
        };
      }
      const results: any[] = [];
      for (const alloc of allocations) {
        const r = await addTransaction({ ...args, amount: alloc.amount, account: alloc.account, paymentMethod: alloc.account, incomeDestinationConfirmed: true, destinationConfirmed: true, allocations: [], split: [], incomeSplit: [], notes: [notes, alloc.note].filter(Boolean).join(' - ') }, userId, token);
        results.push(r);
        if (!r?.success) return r;
      }
      return { success: true, splitIncome: true, results, message: `تم توزيع الدخل: ${allocations.map(a => `${a.amount} ₪ ${a.account === 'palPay' ? 'PalPay' : 'كاش'}`).join('، ')}.` };
    }
    // Prefer the user's original words when they are available. Some API/queued
    // calls can still arrive without a transcript, so structured fields remain a fallback.
    const originalUserIncomeText = normalizeArabicText(args.userText || args.currentUserText || '');
    const toolIncomeText = normalizeArabicText(`${category} ${subcategory} ${notes} ${args.source || ''} ${args.description || ''}`);
    const explicitIncomeDestination = paymentWasProvided && (account === 'cash' || account === 'palPay');
    // Nature must be explicit from the user's words, not inferred by the model's generated category/notes.
    // Example: "مبلغ من الغذاء العالمي بال باي" is NOT enough; ask if it is aid/grant/loan.
    const userStatedIncomeNature = [
      'راتب', 'مساعده', 'مساعدة', 'هديه', 'هدية', 'منحه', 'منحة', 'مكافاه', 'مكافأة',
      'عمل اضافي', 'دخل اضافي', 'بيع', 'ربح', 'تحويل وارد', 'ايداع', 'إيداع', 'دعم'
    ].some(word => originalUserIncomeText.includes(normalizeArabicText(word)));
    const userStatedLoanNature = ['سلفه', 'سلفة', 'قرض', 'دين', 'استدنت', 'اقترضت'].some(word => originalUserIncomeText.includes(normalizeArabicText(word)));
    if (userStatedLoanNature && !userStatedIncomeNature) {
      return {
        success: false,
        needsClarification: true,
        reason: 'POSSIBLE_LOAN_NOT_INCOME',
        message: 'هذا يبدو قرضاً/سلفة وليس دخلاً. هل استلمت مالاً يجب تسجيله كدين، أم هو منحة/مساعدة لا تُرد؟'
      };
    }
    const userStatedNonReturnAid = ['لا ترد', 'لا يرد', 'غير مسترده', 'غير مستردة', 'بدون رد', 'مش سلفه', 'مش سلفة', 'مش قرض'].some(word => originalUserIncomeText.includes(normalizeArabicText(word)));
    const incomeDestinationConfirmed = Boolean(args.incomeDestinationConfirmed || args.destinationConfirmed || args.confirmedDestination || args.allocationConfirmed || explicitIncomeDestination);
    const incomeNatureConfirmed = originalUserIncomeText
      ? Boolean(userStatedIncomeNature || userStatedNonReturnAid)
      : Boolean(
          args.incomeNatureConfirmed || args.sourceConfirmed || args.natureConfirmed ||
          /راتب|salary|قبض|مساعده|مساعدة|منحه|منحة|هديه|هدية|مكافاه|مكافأة|دخل اضافي|عمل اضافي|بيع|ربح|تحويل وارد|ايداع|إيداع|دعم/i.test(toolIncomeText)
        );
    if (!incomeNatureConfirmed) {
      return {
        success: false,
        needsClarification: true,
        reason: 'MISSING_INCOME_NATURE_CONFIRMATION',
        message: 'قبل تسجيل الدخل: هل هو راتب، مساعدة/هدية، دخل عمل إضافي، بيع، أم سلفة/دين؟ إذا كان سلفة لا أسجلها كدخل.'
      };
    }
    if (!incomeDestinationConfirmed) {
      return {
        success: false,
        needsClarification: true,
        reason: 'MISSING_INCOME_DESTINATION_CONFIRMATION',
        message: 'تمام، وطبيعة الدخل واضحة. الآن أكد لي أين دخل فعلياً: كاش أم PalPay؟ وإن كان موزعاً قل كم كاش وكم PalPay.'
      };
    }
    // Income must not be committed from model-invented metadata. For non-salary
    // income, identify the real source/person/organization before writing.
    const incomeSource = String(args.source || merchant || '').trim();
    const isSalaryIncome = /راتب|salary|قبض/i.test(`${originalUserIncomeText} ${toolIncomeText}`);
    if (!isSalaryIncome && !incomeSource) {
      return {
        success: false,
        needsClarification: true,
        reason: 'MISSING_INCOME_SOURCE',
        message: 'قبل ما أسجل الدخل: من مين أو من أي جهة وصلك المبلغ؟'
      };
    }
  }

  // Financial writes must never silently invent missing accounting dimensions.
  // The AI is expected to collect these slots conversationally; the backend remains the final guard.
  if (amount <= 0) return { success: false, needsClarification: true, reason: 'INVALID_AMOUNT', missingFields: ['amount'], message: 'ما قيمة العملية بالضبط؟' };
  if (type === 'expense' && !paymentWasProvided) return { success: false, needsClarification: true, reason: 'MISSING_PAYMENT_METHOD', missingFields: ['paymentMethod'], message: 'هل دفعت كاش أم من محفظة PalPay أم سجلتها ديناً؟' };
  if (type === 'expense') {
    const hasOriginalUserContext = Boolean(originalExpenseText);
    const userProvidedPurchaseIdentity = cleanedPurchaseItemIdentity.length >= 3 || (clarifiedPurchaseItemProvided && Boolean(explicitPurchaseItem));
    const userProvidedPurposeIdentity = userProvidedBeneficiaryPurpose || Boolean(beneficiary) || clarifiedBeneficiaryProvided;
    const voiceOrApiProvidedIdentity = !hasOriginalUserContext && Boolean(explicitPurchaseItem || notes);
    const voiceOrApiProvidedPurpose = !hasOriginalUserContext && Boolean(beneficiary);
    if (!userProvidedPurchaseIdentity && !voiceOrApiProvidedIdentity) {
      return {
        success: false,
        needsClarification: true,
        reason: 'MISSING_PURCHASE_ITEM',
        missingFields: ['purchaseItem'],
        message: 'قبل تسجيل أي مصروف لازم أعرف شو اشتريت بالضبط. قل لي مثلاً: خبز، دواء، ملابس، تموين... بعدها أحدد أنا البند وهل هو ضروري أو كمالي وفق واقع غزة.'
      };
    }
    if (!userProvidedPurposeIdentity && !voiceOrApiProvidedPurpose) {
      return {
        success: false,
        needsClarification: true,
        reason: 'MISSING_PURCHASE_BENEFICIARY_OR_PURPOSE',
        missingFields: ['beneficiary'],
        message: 'ولمين أو لأي غرض هذا المصروف؟ للبيت، للأولاد، لزوجتك، للعلاج، للضيافة، للعمل، أو لنفسك؟ لا أسجل القيد بدون الغرض.'
      };
    }
  }
  if (!category) return { success: false, needsClarification: true, reason: 'MISSING_CATEGORY', message: 'ما بند العملية الرئيسي؟' };
  if (type === 'expense' && !subcategory) return { success: false, needsClarification: true, reason: 'MISSING_SUBCATEGORY', message: 'ما البند الفرعي لهذا المصروف؟' };
  if (type === 'expense' && !necessity) return {
    success: false,
    needsClarification: true,
    reason: 'MISSING_NECESSITY_CONTEXT',
    message: `لم أستطع تصنيف هذا المصروف كضروري أو كمالي وفق واقع غزة من الوصف الحالي. ${necessitySuggestion?.reason || ''} قل لي باختصار: ما الحاجة من هذا الشراء؟`
  };
  if (type === 'expense' && account === 'debt' && !merchant) return { success: false, needsClarification: true, reason: 'MISSING_CREDITOR', missingFields: ['creditor'], message: 'لمن سُجّل هذا الدين أو من أي محل/شخص اشتريت بالدين؟' };
  if (type === 'expense' && expensePaymentSplits.some(split => split.account === 'debt') && !merchant) {
    return { success: false, needsClarification: true, reason: 'MISSING_CREDITOR', missingFields: ['creditor'], message: 'جزء من المصروف مسجل دين. لمن أو عند أي محل سُجّل هذا الدين؟' };
  }

  const splitPaymentLooksAlreadyComponentized = structuredPaymentProvided
    && expensePaymentSplits.length >= 2
    && splitPaymentTotalAmount > 0
    && amount > 0
    && Math.abs(amount - splitPaymentTotalAmount) > 0.01;

  if (type === 'expense'
    && expensePaymentSplits.length >= 2
    && !splitPaymentLooksAlreadyComponentized
    && !mentionsDebtRepayment
    && !mentionsCashBorrowing
    && args.disableExpenseSplitParsing !== true) {
    const splitResults: any[] = [];
    const splitBaseOperationId = String(args.operationId || `tx_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`);
    for (const [index, split] of expensePaymentSplits.entries()) {
      const splitResult = await addTransaction({
        ...args,
        amount: split.amount,
        account: split.account,
        paymentMethod: split.account,
        paymentMethodClarifiedByUser: true,
        accountClarifiedByUser: true,
        creditPurchaseClarifiedByUser: split.account === 'debt' ? true : args.creditPurchaseClarifiedByUser,
        disableExpenseSplitParsing: true,
        operationId: `${splitBaseOperationId}|split_expense_payment|${index + 1}|${split.account}|${split.amount}`,
        notes: [notes, split.note].filter(Boolean).join(' - '),
      }, userId, token);
      splitResults.push(splitResult);
      if (!splitResult?.success) {
        return {
          ...splitResult,
          splitExpense: true,
          partialSplitResults: splitResults,
          message: splitResult?.message || 'تعذر حفظ أحد أجزاء المصروف المقسم، لذلك أوقفت العملية قبل إكمال باقي الأجزاء.',
        };
      }
    }
    const splitTotal = Math.round(expensePaymentSplits.reduce((sum, split) => sum + split.amount, 0) * 100) / 100;
    return {
      success: true,
      splitExpense: true,
      transactionCommitted: splitResults.every(result => result?.success === true),
      transactionIds: splitResults.map(result => result?.transactionId).filter(Boolean),
      results: splitResults,
      amount: splitTotal,
      splits: expensePaymentSplits,
      message: `تم حفظ المصروف مقسماً: ${expensePaymentSplits.map(split => `${split.amount} ₪ ${split.account === 'palPay' ? 'PalPay' : split.account === 'cash' ? 'نقدي' : 'دين'}`).join('، ')}.`,
    };
  }

  const explicitDebtSettlementIntent = mentionsDebtRepayment
    || (type === 'expense' && category.includes('سداد'))
    || ((textToCheck.includes('سداد') || textToCheck.includes('سدد') || textToCheck.includes('تسديد')) && (textToCheck.includes('دين') || textToCheck.includes('الديون') || textToCheck.includes('لشخص') || textToCheck.includes('لصديق')));
  if (explicitDebtSettlementIntent) {
    const rawPaymentAccount = args.paymentMethod || args.fromAccount || explicitUserPaymentAccount;
    if (!rawPaymentAccount || normalizeAccount(rawPaymentAccount) === 'debt') {
      return { success: false, needsClarification: true, reason: 'MISSING_DEBT_PAYMENT_ACCOUNT', missingFields: ['debtPaymentAccount'], message: 'هل سددت الدين من الكاش أم من محفظة PalPay؟' };
    }
    const creditorForSettlement = String(args.creditor || args.person || args.merchant || '').trim();
    if (!creditorForSettlement) {
      return { success: false, needsClarification: true, reason: 'MISSING_CREDITOR', missingFields: ['creditor'], message: 'لأي دائن تريد تسجيل السداد؟' };
    }
    return await payDebt({ ...args, amount, paymentMethod: normalizeAccount(rawPaymentAccount), fromAccount: normalizeAccount(rawPaymentAccount), creditor: creditorForSettlement, notes: args.notes }, userId, token);
  }

  if ((textToCheck.includes('تحويل') && (textToCheck.includes('من') || textToCheck.includes('إلى') || textToCheck.includes('لبال') || textToCheck.includes('كاش'))) || args.category === 'تحويل' || args.category === 'تحويل داخلي') {
    const fromAcc = normalizeAccount(args.fromAccount || args.account || (textToCheck.includes('من بال') ? 'palPay' : 'cash'));
    const toAcc = normalizeAccount(args.toAccount || (textToCheck.includes('إلى بال') || textToCheck.includes('لبال') ? 'palPay' : 'cash'));
    return await transferMoney({ amount, fromAccount: fromAcc, toAccount: toAcc, notes: args.notes, date: args.date, historicalMonth: args.historicalMonth || args.monthContext || args.entryMonth, day: args.day || args.transactionDay }, userId, token);
  }

  // V5 pre-execution guard: the same budget/transaction reads that used to happen after the write
  // are performed before it so the assistant can warn before damage, then reused below (no duplicate polling/read loop).
  let preTxSnapshot: any = null;
  let preUserBudgets: Record<string, number> | null = null;
  const advisoryWarnings: string[] = [];

  if (type === 'income') {
    // Income writes must not depend on an index-sensitive date-range preflight query.
    // Duplicate protection is applied below with a fixed guard document inside
    // atomicAddTransaction, so cash and PalPay income follow the same safe path.
  }

  if (type === 'expense' && !args.deferBalanceCheckToAtomicBatch) {
    try {
      const preflightDate = new Date(dateResult.date);
      const safePreflightDate = Number.isNaN(preflightDate.getTime()) ? transactionNow : preflightDate;
      const thisMonth = safePreflightDate.toISOString().slice(0,7);
      const monthStart = `${thisMonth}-01T00:00:00.000Z`;
      const nextMonthDate = new Date(Date.UTC(safePreflightDate.getUTCFullYear(), safePreflightDate.getUTCMonth() + 1, 1));
      const nextMonthStart = `${nextMonthDate.toISOString().slice(0, 10)}T00:00:00.000Z`;
      const last30Start = new Date(safePreflightDate.getTime() - 30 * 86400000).toISOString();
      const last90Start = new Date(safePreflightDate.getTime() - 90 * 86400000).toISOString();

      let balanceResult = await getBalance({}, userId, token);
      if (balanceResult.partial === true) {
        console.warn('[add-transaction] preflight balance read was partial; attempting authoritative repair before write', {
          userIdHash: stableDocId(userId),
          reason: (balanceResult as any).reason || (balanceResult as any).error || 'partial_balance_read',
        });
        const repaired = await repairAccountBalanceSnapshot({ reason: 'add_transaction_preflight_partial_balance' }, userId, token);
        if (repaired.success === true) {
          balanceResult = {
            balances: repaired.balances,
            total: Number(repaired.balances?.cash || 0) + Number(repaired.balances?.palPay || 0),
            partial: false,
            cloudStorageConfirmed: true,
            source: 'preflight_repair_full_ledger',
          } as any;
        } else {
          console.warn('[add-transaction] preflight balance repair failed; deferring safety check to atomic transaction', {
            userIdHash: stableDocId(userId),
            error: repaired.error || repaired.reason || 'repair_failed',
          });
        }
      }
      const balances = balanceResult.partial === true ? null : balanceResult.balances;

      const [budgetMap, categoryMonthSnap, recentExpenseSnap, income90dSnap] = await Promise.all([
        getUserBudgets(userId, adminDb),
        adminDb.collection('transactions')
          .where('userId', '==', userId)
          .where('date', '>=', monthStart)
          .where('date', '<', nextMonthStart)
          .where('category', '==', category)
          .get(),
        adminDb.collection('transactions')
          .where('userId', '==', userId)
          .where('date', '>=', last30Start)
          .where('date', '<', safePreflightDate.toISOString())
          .where('type', '==', 'expense')
          .limit(300)
          .get(),
        account === 'debt'
          ? adminDb.collection('transactions')
              .where('userId', '==', userId)
              .where('date', '>=', last90Start)
              .where('date', '<', safePreflightDate.toISOString())
              .where('type', '==', 'income')
              .limit(300)
              .get()
          : Promise.resolve({ docs: [] } as any),
      ]);
      preUserBudgets = budgetMap;
      preTxSnapshot = categoryMonthSnap;

      const optionalPreflightPartial = (categoryMonthSnap as any).partial === true || (recentExpenseSnap as any).partial === true || (income90dSnap as any).partial === true;
      if (optionalPreflightPartial) {
        console.warn('[add-transaction] optional budget/income preflight was partial; continuing to atomic write path', {
          userIdHash: stableDocId(userId),
          operationId: String(args.operationId || ''),
          categoryMonthPartial: Boolean((categoryMonthSnap as any).partial),
          recentExpensePartial: Boolean((recentExpenseSnap as any).partial),
          income90dPartial: Boolean((income90dSnap as any).partial),
        });
      }

      let preflightTreasurerProfile = normalizeTreasurerProfile({});
      try {
        const profileSnap = await adminDb.collection('users').doc(userId).collection('treasurer').doc('profile').get();
        preflightTreasurerProfile = normalizeTreasurerProfile(profileSnap.exists ? profileSnap.data() : {});
      } catch (profileErr) {
        console.warn('Treasurer profile unavailable for preflight risk gate:', profileErr);
      }

      if (balances && account !== 'debt') {
        const available = account === 'cash' ? Number(balances.cash||0) : account === 'palPay' ? Number(balances.palPay||0) : 0;
        if (amount > available + 0.0001) {
          return { success:false, needsClarification:true, reason:'INSUFFICIENT_FUNDS', message:`المبلغ ${amount} ₪ أكبر من رصيد ${account === 'palPay' ? 'PalPay' : 'الكاش'} المتاح (${available} ₪). لن أنفذ العملية قبل أن تحدد طريقة دفع أخرى أو تعدل المبلغ.` };
        }
      } else if (balances && account === 'debt') {
        const projectedDebt = Number(balances.debt || 0) + amount;
        const income90d = income90dSnap.docs
          .map((d:any) => d.data())
          .filter((t:any) => t.transactionType !== 'DEBT_BORROWING')
          .reduce((s:number, t:any) => s + parsePositiveFinancialAmount(t.amount), 0);
        const monthlyIncome90d = income90d / 3;
        const referenceMonthlyIncome = monthlyIncome90d > 0 ? monthlyIncome90d : parsePositiveFinancialAmount(preflightTreasurerProfile.monthlySalary);
        const debtToIncomeRatio = referenceMonthlyIncome > 0 ? projectedDebt / referenceMonthlyIncome : Infinity;
        const debtRatioLimit = Number(preflightTreasurerProfile.debtLimitRatio || 1) || 1;
        const explicitDebtLimit = parsePositiveFinancialAmount(preflightTreasurerProfile.maxDebtBalance);
        const breaksProfileDebtLimit = (explicitDebtLimit > 0 && projectedDebt > explicitDebtLimit) || (Number.isFinite(debtToIncomeRatio) && debtToIncomeRatio > debtRatioLimit);
        if (!args.riskConfirmed && (breaksProfileDebtLimit || amount > 5000)) {
          await addNotification(
            userId,
            `🚨 خطر دين: الشراء بالدين بقيمة ${amount} ₪ سيرفع إجمالي الدين إلى ${projectedDebt} ₪ قبل الحفظ.`,
            'warning',
            adminDb,
            {
              idempotencyKey: `advisor-debt-risk:${args.operationId || `${dateResult.date}:${amount}:${merchant || category}`}`,
              advisorAlert: true,
              advisorStatus: 'open',
              severity: 'critical',
              priority: 'high',
              category: 'debt_risk',
              source: 'addTransaction.debtPreflight',
              operationId: String(args.operationId || ''),
              metadata: { currentDebt: balances.debt, purchaseAmount: amount, projectedDebt, debtToIncomeRatio: Number.isFinite(debtToIncomeRatio) ? Math.round(debtToIncomeRatio * 100) / 100 : null },
              actions: [
                { id: 'confirm_risk', label: 'أكد المخاطرة', type: 'confirm' },
                { id: 'pay_down_debt', label: 'خفّض الدين أولاً', type: 'behavior' },
                { id: 'dismiss', label: 'تجاهل', type: 'dismiss' },
              ],
            }
          );
          return {
            success:false,
            needsConfirmation:true,
            reason:'DEBT_PURCHASE_RISK',
            message:`هذا الشراء بالدين سيرفع إجمالي ديونك إلى ${projectedDebt} ₪ (نسبة الدين للدخل ${(debtToIncomeRatio * 100).toFixed(0)}%). هل تريد المتابعة رغم هذا الوضع؟`,
            financialImpact: {
              currentDebt: balances.debt,
              purchaseAmount: amount,
              projectedDebt,
              debtToIncomeRatio: Number.isFinite(debtToIncomeRatio) ? Math.round(debtToIncomeRatio * 100) / 100 : null,
            },
          };
        }
      }
      const spent = categoryMonthSnap.docs.map((d:any)=>d.data()).filter((t:any)=>t.type==='expense').reduce((a:number,t:any)=>a+parsePositiveFinancialAmount(t.amount),0);
      const limit = Number((preUserBudgets as any)?.[category] || DEFAULT_BUDGETS[category] || 0);
      const projected = spent + amount;
      const recentExpenses = recentExpenseSnap.docs.map((d:any)=>d.data()).filter((t:any) => t.type === 'expense');
      const dailyExpenseAverage = recentExpenses.reduce((a:number,t:any)=>a+parsePositiveFinancialAmount(t.amount),0) / 30;
      const profileReserveTarget = Math.max(
        Number(args.savingsReserveTarget || 0),
        parsePositiveFinancialAmount(preflightTreasurerProfile.cashReserveTarget),
        parsePositiveFinancialAmount(preflightTreasurerProfile.minimumCashFloor),
        parsePositiveFinancialAmount(preflightTreasurerProfile.criticalLiquidityFloor)
      );
      const risk = evaluateTreasurerRisk({
        amount,
        type,
        account,
        category,
        subcategory,
        necessity,
        merchant,
        balances,
        budgetLimit: limit,
        categorySpent: spent,
        dailyExpenseAverage,
        projected30DayBalance: Number(balances.total || 0) - dailyExpenseAverage * 30,
        savingsReserveTarget: profileReserveTarget,
        riskConfirmed: Boolean(args.riskConfirmed),
      });
      if (risk.needsConfirmation) {
        const confirmationReasons = Array.isArray((risk as any).confirmationReasons) && (risk as any).confirmationReasons.length
          ? (risk as any).confirmationReasons
          : risk.warnings;
        await addNotification(
          userId,
          `🚨 أمين الصندوق أوقف عملية ${amount} ₪ على بند [${category}] قبل الحفظ: ${confirmationReasons.join(' ')}`,
          'warning',
          adminDb,
          {
            idempotencyKey: `advisor-risk-block:${args.operationId || `${dateResult.date}:${amount}:${account}:${category}:${merchant}`}`,
            advisorAlert: true,
            advisorStatus: 'open',
            severity: risk.severity === 'critical' ? 'critical' : 'warning',
            priority: risk.severity === 'critical' ? 'high' : 'medium',
            category: 'treasurer_risk_gate',
            source: 'addTransaction.preflight',
            operationId: String(args.operationId || ''),
            metadata: { amount, account, category, subcategory, merchant, necessity, riskAssessment: risk },
            actions: [
              { id: 'confirm_risk', label: 'أكد المخاطرة', type: 'confirm' },
              { id: 'adjust_amount', label: 'عدّل المبلغ', type: 'edit' },
              { id: 'cancel', label: 'إلغاء العملية', type: 'dismiss' },
            ],
          }
        );
        return {
          success: false,
          needsConfirmation: true,
          reason: risk.severity === 'critical' ? 'TREASURER_CRITICAL_RISK' : 'TREASURER_RISK_CONFIRMATION_REQUIRED',
          message: `أمين الصندوق يوقف العملية مؤقتاً قبل الحفظ. ${confirmationReasons.join(' ')} إذا كنت واعياً للمخاطرة وتريد المتابعة قل بوضوح: أكد المخاطرة وسجّل العملية.`,
          advisoryWarnings: risk.warnings,
          riskAssessment: risk,
          financialImpact: {
            amount,
            account,
            category,
            availableBefore: (risk as any).availableBefore,
            availableAfter: (risk as any).availableAfter,
            budgetPercentageAfter: (risk as any).budgetPercentageAfter,
            coverageDays: (risk as any).coverageDays,
            projected30DayBalanceAfter: (risk as any).projected30DayBalanceAfter,
          },
        };
      }
      if (risk.warnings.length) {
        advisoryWarnings.push(`تحذير أمين الصندوق: ${risk.warnings.join(' ')}`);
      }

      const restrictedCategoryKeys = normalizeTreasurerStringList(preflightTreasurerProfile.restrictedCategories || [])
        .map((c: string) => normalizeArabicText(c).toLowerCase());
      const normalizedCategoryForGoalImpact = normalizeArabicText(category).toLowerCase();
      const isRestrictedForGoalImpact = restrictedCategoryKeys.some((c: string) => c && normalizedCategoryForGoalImpact.includes(c));
      const shouldAssessGoalImpactBeforeWrite = amount >= 100
        || account === 'debt'
        || normalizeArabicText(necessity).includes('كمالي')
        || isRestrictedForGoalImpact
        || parsePositiveFinancialAmount(preflightTreasurerProfile.discretionaryMonthlyLimit) > 0;
      if (shouldAssessGoalImpactBeforeWrite) {
        const goalImpact: any = await assessFinancialGoalImpact({
          amount,
          category,
          item: purchaseItemForRecord || merchant || category,
          necessity,
          period: 'salary_cycle',
          goalLimit: 3,
          riskConfirmed: Boolean(args.riskConfirmed),
        }, userId, token).catch((goalErr: any) => ({ success: false, error: goalErr?.message || String(goalErr) }));
        if (goalImpact?.needsConfirmation) {
          await addNotification(userId, `🎯 أمين الصندوق أوقف العملية قبل الحفظ بسبب أثرها على الأهداف: ${goalImpact.message}`, 'warning', adminDb, {
            idempotencyKey: `advisor-goal-impact-block:${args.operationId || `${dateResult.date}:${amount}:${account}:${category}:${merchant}`}`,
            advisorAlert: true,
            advisorStatus: 'open',
            severity: goalImpact.severity === 'critical' ? 'critical' : 'warning',
            priority: goalImpact.severity === 'critical' ? 'high' : 'medium',
            category: 'goal_impact',
            source: 'addTransaction.goalImpactPreflight',
            operationId: String(args.operationId || ''),
            metadata: { amount, account, category, subcategory, merchant, necessity, goalImpact },
            actions: [
              { id: 'confirm_risk', label: 'أكد المخاطرة', type: 'confirm' },
              { id: 'compensate_goal', label: 'عوّض الهدف', type: 'behavior' },
              { id: 'cancel', label: 'إلغاء العملية', type: 'dismiss' },
            ],
          });
          return {
            success: false,
            needsConfirmation: true,
            reason: 'FINANCIAL_GOAL_IMPACT_RISK',
            message: `${goalImpact.message} إذا كنت واعياً للمخاطرة وتريد المتابعة قل بوضوح: أكد المخاطرة وسجّل العملية.`,
            advisoryWarnings: goalImpact.warnings || [],
            goalImpact,
          };
        }
        if (goalImpact?.severity === 'warning') advisoryWarnings.push(`تأثير على الأهداف: ${goalImpact.message}`);
      }

      if (limit > 0 && projected >= limit) {
        advisoryWarnings.push(`تحذير ميزانية: هذه العملية سترفع مصروف بند [${category}] إلى ${projected} ₪ مقابل سقف ${limit} ₪.`);
      }
    } catch (preErr) {
      console.error('V5 preflight warning check unavailable:', preErr);
      // Do not fabricate a warning when data is unavailable. Existing write/fallback behavior remains intact.
    }
  }

  const operationId = String(args.operationId || `tx_${Date.now()}_${Math.random().toString(36).slice(2,10)}`);
  const tx = {
    userId,
    amount,
    type,
    account,
    category,
    subcategory,
    purchaseItem: type === 'expense' ? purchaseItemForRecord : explicitPurchaseItem,
    beneficiary: type === 'expense' ? beneficiaryForRecord : beneficiary,
    merchant,
    notes,
    necessity: type === 'expense' ? necessity : '',
    necessitySource: type === 'expense' && explicitNecessityProvided ? 'user' : (type === 'expense' ? 'gaza_context_classifier' : ''),
    necessityReason: type === 'expense' ? (necessitySuggestion?.reason || '') : '',
    transactionType: type === 'expense' && account === 'debt' ? 'CREDIT_PURCHASE' : (type === 'income' ? 'INCOME' : 'EXPENSE'),
    creditor: type === 'expense' && account === 'debt' ? merchant : '',
    creditorKey: type === 'expense' && account === 'debt' ? normalizeCreditorName(merchant) : '',
    operationId,
    date: dateResult.date,
    dateSource: dateResult.source,
    createdAt: transactionNow.toISOString()
  };

  const isSalaryIncomeForGuard = type === 'income' && /راتب|salary|قبض/i.test(`${category} ${subcategory} ${notes} ${args.source || ''} ${args.description || ''} ${args.userText || ''}`);
  const salaryCycleForGuard = isSalaryIncomeForGuard ? getSalaryCycleForDate(dateResult.date, transactionNow) : null;
  const incomeGuardDate = dateResult.date.slice(0, 10);
  const incomeGuardCollection = isSalaryIncomeForGuard ? 'salaryIncomeGuards' : 'incomeGuards';
  const incomeGuardKey = isSalaryIncomeForGuard && salaryCycleForGuard
    ? `${salaryCycleForGuard.cycleId}:${account}:${amount}`
    : `income:${incomeGuardDate}:${account}:${amount}:${category}:${subcategory}`;
  const incomeUniqueGuard = type === 'income' ? {
    ref: firebaseAdminDb.collection('users').doc(userId).collection(incomeGuardCollection).doc(stableDocId(incomeGuardKey)),
    reason: isSalaryIncomeForGuard ? 'DUPLICATE_SALARY_INCOME' : 'POSSIBLE_DUPLICATE_INCOME',
    payload: {
      cycleId: salaryCycleForGuard?.cycleId || null,
      cycleStart: salaryCycleForGuard?.startIso || null,
      cycleEnd: salaryCycleForGuard?.cycleEnd || null,
      dateKey: incomeGuardDate,
      account,
      amount,
      category,
      subcategory,
      date: dateResult.date,
      operationId,
      source: isSalaryIncomeForGuard ? 'salary_cycle_guard' : 'income_day_guard',
    },
  } : null;

  // V6.1+ (CONC-01..CONC-05): every real add_transaction write goes through
  // atomicAddTransaction. Balance-sensitive ops keep projected-balance checks;
  // non-sensitive adds skip the balance check but still require a confirmed
  // Firestore transaction commit, so FakeDb/local pending fallback cannot create
  // an apparent success that never appears in the client.
  const isBalanceSensitive = (type === 'expense' && (account === 'cash' || account === 'palPay'))
                          || (type === 'transfer' && (account === 'cash' || account === 'palPay'));

  // Validation-only mode is used by multi-line receipt recording. It executes the
  // exact same domain validation and transaction construction as addTransaction,
  // but deliberately stops before any persistence or side effect. The caller then
  // commits all prepared rows atomically as one receipt operation.
  if (args.validateOnly === true) {
    return {
      success: true,
      validationOnly: true,
      preparedTransaction: tx,
      operationId,
      isBalanceSensitive,
    };
  }

  console.info('[add-transaction] commit_start', {
    userIdHash: stableDocId(userId),
    operationId,
    amount,
    type,
    account,
    date: dateResult.date,
    category,
    subcategory,
    paymentWasProvided,
  });

  let writeResult: WriteResult | null = null;
  let actualTxId = '';
  let atomicResult: Awaited<ReturnType<typeof atomicAddTransaction>>;
  try {
    atomicResult = await atomicAddTransaction(userId, tx, {
      skipBalanceCheck: !isBalanceSensitive,
      riskConfirmed: Boolean(args.riskConfirmed || (type === 'income' && args.duplicateConfirmed)),
      uniqueGuard: incomeUniqueGuard,
    });
  } catch (e: any) {
    return {
      success: false,
      retryable: true,
      reason: 'CLOUD_WRITE_FAILED',
      message: `لم يتم حفظ العملية في Firestore. لم أسجل أي قيد. السبب: ${e?.message || 'فشل غير معروف في التخزين السحابي'}`,
      error: e?.message || String(e),
    };
  }
  if (!atomicResult.ok) {
    const failReason = (atomicResult as any).reason as string;
    const failAvailable = (atomicResult as any).available as number | undefined;
    if (failReason === 'INSUFFICIENT_FUNDS_ATOMIC') {
      return {
        success: false,
        needsClarification: true,
        reason: 'INSUFFICIENT_FUNDS',
        message: `المبلغ ${amount} ₪ أكبر من الرصيد المتاح (${failAvailable} ₪). العملية مرفوضة لمنع تجاوز الرصيد.`,
      };
    }
    if (failReason === 'DUPLICATE_SALARY_INCOME') {
      return {
        success: false,
        needsConfirmation: true,
        reason: 'DUPLICATE_SALARY_INCOME',
        message: `راتب هذه الدورة مسجل سابقاً بنفس المبلغ ${amount} ₪ على نفس الحساب. لن أكرره حتى لا يتضاعف الرصيد.`,
        duplicateGuard: (atomicResult as any).duplicateGuard || null,
      };
    }
    if (failReason === 'POSSIBLE_DUPLICATE_INCOME') {
      return {
        success: false,
        needsConfirmation: true,
        reason: 'POSSIBLE_DUPLICATE_INCOME',
        message: `يوجد دخل بنفس المبلغ ${amount} ₪ على نفس الحساب ونفس التاريخ. لن أكرره حتى تؤكد أنه دخل آخر.`,
        duplicateGuard: (atomicResult as any).duplicateGuard || null,
      };
    }
    return { success: false, error: failReason, reason: failReason };
  }
  actualTxId = atomicResult.docId;
  writeResult = { durability: 'committed', synced: true, pending: false };

  const committedBalances = 'balances' in atomicResult ? (atomicResult as any).balances : undefined;
  const commitVerification = await verifyAddTransactionCommit(userId, actualTxId, tx, committedBalances, atomicResult as any);
  console.info('[add-transaction] commit_verification', {
    userIdHash: stableDocId(userId),
    operationId,
    transactionId: actualTxId,
    ok: commitVerification.ok,
    transactionDocumentConfirmed: commitVerification.transactionDocumentConfirmed,
    balanceSnapshotConfirmed: commitVerification.balanceSnapshotConfirmed,
    balanceEffectConfirmed: commitVerification.balanceEffectConfirmed,
    errors: commitVerification.errors,
  });

  if (!commitVerification.ok) {
    console.warn('[add-transaction] post_commit_verification_warning', {
      userIdHash: stableDocId(userId),
      operationId,
      transactionId: actualTxId,
      errors: commitVerification.errors,
      warnings: commitVerification.warnings,
    });
  }
  const responseBalances = commitVerification.storedBalances || committedBalances;
  const postCommitVerificationWarning = commitVerification.ok
    ? ''
    : 'تم تنفيذ Firestore transaction بنجاح، لكن فحص ما بعد الحفظ سجل تحذيراً داخلياً وتم اعتماد نتيجة العملية الذرية كمصدر الحقيقة.';
  
  // The ledger write above is durably committed. Secondary effects
  // (notifications/budget warnings) must never turn that committed write into
  // an apparent tool failure, otherwise Live may tell the user to retry and
  // create a duplicate while the original transaction already exists.
  try {
    await recordTransactionCommittedSideEffects(userId, actualTxId, tx, adminDb, {
      preUserBudgets,
      preTxSnapshot,
    });
  } catch (sideEffectErr) {
    console.warn('Post-commit financial side effect failed; preserving committed transaction success:', sideEffectErr);
  }

  try {
    await recalculateCyclesForTransactionChange(userId, token, null, { id: actualTxId, ...tx }, 'transaction_added');
  } catch (vaultErr) {
    console.warn('Savings Vault recalculation failed after committed transaction; preserving committed transaction success:', vaultErr);
  }
  
  const affectedSalaryCycle = getSalaryCycleForDate(tx.date || tx.createdAt || new Date().toISOString(), new Date());
  return {
    success: true,
    transactionId: actualTxId,
    operationId,
    transaction: { id: actualTxId, ...tx },
    affectedCycleId: affectedSalaryCycle.cycleId,
    affectedCycleIds: [affectedSalaryCycle.cycleId],
    affectedSalaryCycles: [{ cycleId: affectedSalaryCycle.cycleId, cycleStart: affectedSalaryCycle.cycleStart, cycleEnd: affectedSalaryCycle.cycleEnd, name: affectedSalaryCycle.name }],
    currentBalances: responseBalances,
    previousBalances: (atomicResult as any).previousBalances || null,
    balanceDelta: (atomicResult as any).balanceDelta || null,
    commitVerification,
    postCommitVerificationWarning: postCommitVerificationWarning || undefined,
    advisoryWarnings: advisoryWarnings.length ? advisoryWarnings : undefined,
    budgetWarning: advisoryWarnings.length ? advisoryWarnings.join(' ') : undefined,
    // V6: explicit durability flag. UI/AI MUST inspect this.
    // The balance snapshot is updated in the same Firestore transaction as the ledger write,
    // so no post-commit full-ledger balance refresh is needed.
    durability: writeResult!.durability,
    pending: writeResult!.pending,
    partial: writeResult!.pending,
    balanceReadPartial: false,
    cloudStorageConfirmed: writeResult!.durability === 'committed',
    cloudStoragePending: writeResult!.pending,
    message: writeResult!.durability === 'committed'
      ? `تم حفظ القيد في السحابة بقيمة ${amount} ₪.${advisoryWarnings.length ? ` ${advisoryWarnings.join(' ')}` : ''}`
      : undefined,
    balanceWarning: undefined,
    pendingReason: writeResult!.pending ? 'CLOUD_STORAGE_NOT_CONFIRMED' : undefined,
    pendingError: writeResult!.pending ? writeResult!.error : undefined,
    userFacingPendingMessage: writeResult!.pending
      ? 'الخادم يعمل، لكن Firestore لم يؤكد حفظ العملية سحابياً بعد. هذه ليست بالضرورة مشكلة إنترنت عندك؛ افحص إعدادات Firebase/Firestore أو أعد المحاولة.'
      : undefined,
  };
}

export async function prepareAddTransaction(args: any, userId: string, token: string) {
  // Receipt recording needs the canonical add_transaction validation/preparation
  // authority, but must not pass validateOnly through toolHandlers because that
  // wrapper records idempotency outcomes for operations that have not written yet.
  return addTransaction({ ...args, validateOnly: true }, userId, token);
}

export async function sendPalPayPayment(args: any, userId: string, token: string) {
  const adminDb = getDb(token);
  console.log("TOOL CALL: sendPalPayPayment", args);

  // V6 (HF-3): full validation mirroring addTransaction guards.
  const amount = parseAbsoluteFinancialAmount(args.amount);
  if (amount <= 0) {
    return { success: false, needsClarification: true, reason: 'INVALID_AMOUNT', message: 'المبلغ يجب أن يكون رقماً موجباً.' };
  }
  const recipientName = String(args.recipientName || '').trim();
  const phoneNumber = String(args.phoneNumber || '').trim();
  const description = String(args.description || '').trim();
  if (!recipientName) return { success: false, needsClarification: true, reason: 'MISSING_RECIPIENT', message: 'إلى من ترسل المبلغ؟' };
  if (!phoneNumber) return { success: false, needsClarification: true, reason: 'MISSING_PHONE', message: 'ما رقم جوال المستلم؟' };
  // Palestinian phone format: +970/+972 or 05xxxxxxxx. Loose validation.
  const normalizedPhone = phoneNumber.replace(/[\s-]/g, '');
  if (!/^(\+9(70|72)|0)?5\d{8}$/.test(normalizedPhone)) {
    return { success: false, needsClarification: true, reason: 'INVALID_PHONE', message: `رقم الجوال ${phoneNumber} غير صالح. يجب أن يبدأ بـ 05 أو +9705 أو +9725.` };
  }

  // Check PalPay balance BEFORE writing.
  const balanceCheck = await getBalance({}, userId, token);
  const palPayAvailable = Number(balanceCheck?.balances?.palPay || 0);
  if (amount > palPayAvailable + 0.0001) {
    return { success: false, needsClarification: true, reason: 'INSUFFICIENT_FUNDS', message: `رصيد PalPay المتاح هو ${palPayAvailable} ₪ فقط. لا يمكن تحويل ${amount} ₪.` };
  }

  const operationId = String(args.operationId || `palpay_${Date.now()}_${Math.random().toString(36).slice(2,10)}`);
  const txRef = adminDb.collection('transactions').doc();
  const tx = {
    userId,
    amount,
    type: 'expense',
    account: 'palPay',
    // V6 (LF-14): use a category that exists in DEFAULT_BUDGETS so budget tracking fires.
    category: 'تحويلات PalPay',
    subcategory: `تحويل إلى ${recipientName}`,
    merchant: 'PalPay',
    notes: description || `تحويل ${amount} ₪ إلى ${recipientName} (${phoneNumber})`,
    transactionType: 'PALPAY_TRANSFER',
    operationId,
    necessity: 'ضروري',
    date: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    // Preserve recipient metadata for audit trail.
    palpayRecipient: recipientName,
    palpayPhone: normalizedPhone,
  };

  // Add PalPay category to DEFAULT_BUDGETS lazily if not present (so budget tracking works).
  if (!DEFAULT_BUDGETS['تحويلات PalPay']) {
    DEFAULT_BUDGETS['تحويلات PalPay'] = 1000;
  }

  let atomicResult: Awaited<ReturnType<typeof atomicAddTransaction>>;
  try {
    atomicResult = await atomicAddTransaction(userId, tx, { riskConfirmed: Boolean(args.riskConfirmed) });
  } catch (e: any) {
    return { success: false, retryable: true, reason: 'PALPAY_ATOMIC_WRITE_FAILED', message: `تعذر حفظ تحويل PalPay بأمان: ${e?.message || 'unknown error'}` };
  }
  if (!atomicResult.ok) {
    const failAvailable = (atomicResult as any).available;
    return { success: false, needsClarification: true, reason: (atomicResult as any).reason, message: failAvailable !== undefined ? `رصيد PalPay المتاح هو ${failAvailable} ₪ فقط.` : 'تعذر تنفيذ تحويل PalPay بأمان.' };
  }

  await addNotification(userId, `تم تحويل ${amount} ₪ إلى ${recipientName} (${normalizedPhone}) عبر PalPay بنجاح.`, 'success', adminDb);

  return {
    success: true,
    transactionId: atomicResult.docId,
    operationId,
    currentBalances: atomicResult.balances,
    durability: 'committed',
    pending: false,
    partial: false,
  };
}

export async function generateReport(args: any, userId: string, token: string) {
  const adminDb = getDb(token);
  console.log("TOOL CALL: generateReport", args);
  
  const now = new Date();
  const requestedTimeframe = String(args.timeframe || args.period || '').trim();
  const reportUserIntentText = `${args.currentUserText || ''} ${args.userText || ''} ${args.question || ''} ${args.query || ''}`;
  const reportTitleText = `${args.title || ''}`;
  const monthFromUserText = parseSalaryCycleMonth(reportUserIntentText);
  const monthFromTitle = parseSalaryCycleMonth(reportTitleText);
  const explicitReportMonth = parseSalaryCycleMonth(args.month || args.salaryMonth || args.monthNumber);
  // Trust the user's actual words first. Gemini may generate a wrong title or
  // month argument such as month=9 while the user asked for "شهر 8". The title
  // and model-filled month are only fallbacks when the original user text has no
  // explicit month.
  const inferredReportMonth = monthFromUserText ?? monthFromTitle ?? explicitReportMonth;
  const combinedReportText = `${reportUserIntentText} ${reportTitleText}`;
  const hasExplicitCurrentCycleText = /الدورة\s*الحالية|الشهر\s*الحالي|الحالي(?:ة)?|current/i.test(combinedReportText);
  const hasExplicitAllHistoryText = /كل\s*التاريخ|كل\s*السنوات|من\s*البداية|كل\s*البيانات|all\s*history|entire\s*history/i.test(combinedReportText);
  const hasReportIntentText = /تقرير|report/i.test(combinedReportText);
  const hasCompleteReportText = /كامل|شامل|مفصل|كل\s*المصروفات|كافة\s*البنود|كل\s*البنود|complete|full|detailed/i.test(combinedReportText);
  const hasExplicitRange = Boolean(args.startDate && args.endDate);
  const hasMonth = inferredReportMonth !== null;
  // If the user/title says "شهر 8", that explicit salary-cycle month must win
  // over model-filled current/custom ranges. Otherwise Gemini may send current
  // cycle dates while keeping a "شهر 8" title, producing a month-9 report.
  const timeframe = hasMonth ? 'salary_cycle' : (requestedTimeframe || (hasExplicitRange ? 'custom' : 'current_salary_cycle'));
  const reportScopeTrace: any = {
    rawArgs: args,
    requestedTimeframe,
    reportUserIntentText,
    reportTitleText,
    monthFromUserText,
    monthFromTitle,
    explicitReportMonth,
    inferredReportMonth,
    hasMonth,
    hasExplicitRange,
    hasExplicitCurrentCycleText,
    hasExplicitAllHistoryText,
    hasReportIntentText,
    hasCompleteReportText,
    finalTimeframeBeforeRange: timeframe,
  };
  console.warn('[REPORT_SCOPE_TRACE] generate_report_scope_resolved_pre_range', reportScopeTrace);
  if ((String(requestedTimeframe).toLowerCase() === 'all' && !hasExplicitAllHistoryText && !args.allowFullLedgerReport) || (hasReportIntentText && hasCompleteReportText && !hasMonth && !hasExplicitRange && !hasExplicitCurrentCycleText && !hasExplicitAllHistoryText)) {
    console.warn('[REPORT_SCOPE_TRACE] generate_report_scope_rejected', reportScopeTrace);
    return {
      success: false,
      needsClarification: true,
      retryable: true,
      reason: 'REPORT_SCOPE_MONTH_REQUIRED',
      reportScopeTrace,
      message: 'لم يصل شهر التقرير إلى الأداة أو وصل timeframe=all بدون طلب صريح لكل التاريخ. لا يجوز إنشاء تقرير للدورة الحالية افتراضياً. أعد استدعاء generate_report مع timeframe="salary_cycle" و month=رقم شهر الدورة الذي ذكره المستخدم، مثلاً month=8 لدورة شهر 8. عبارة كافة البنود تعني category="all" فقط وليست timeframe="all".',
    };
  }
  const categoryQuery = args.category && args.category !== 'all' && args.category !== 'الكل' && args.category !== 'كافة البنود' ? args.category : '';
  const subcategoryQuery = String(args.subcategory || '').trim();
  const typeQuery = String(args.type || '').trim();
  let startIso = '';
  let endExclusiveIso = '';
  let salaryCycleForReport: SalaryCyclePeriod | null = null;
  if (timeframe === 'all' && !args.allowFullLedgerReport) {
    return { success: false, needsConfirmation: true, reason: 'FULL_LEDGER_REPORT_REQUIRES_CONFIRMATION', message: 'تقرير كل التاريخ يحتاج قراءة واسعة. حدد فترة/دورة راتب أو أكد allowFullLedgerReport=true.' };
  }
  if (timeframe === 'custom') {
    if (!args.startDate || !args.endDate) {
      return { success: false, needsClarification: true, reason: 'CUSTOM_REPORT_REQUIRES_DATES', message: 'للتقرير بتاريخ مخصص لازم تحدد startDate و endDate بوضوح.' };
    }
    startIso = new Date(`${String(args.startDate).slice(0, 10)}T00:00:00.000Z`).toISOString();
    const end = new Date(`${String(args.endDate).slice(0, 10)}T00:00:00.000Z`);
    end.setUTCDate(end.getUTCDate() + 1);
    endExclusiveIso = end.toISOString();
  } else if (timeframe === 'today') {
    const today = now.toISOString().slice(0, 10);
    const tomorrow = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
    startIso = `${today}T00:00:00.000Z`;
    endExclusiveIso = `${tomorrow.toISOString().slice(0, 10)}T00:00:00.000Z`;
  } else if (timeframe === 'week') {
    startIso = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
    endExclusiveIso = now.toISOString();
  } else if (timeframe === 'month' && args.calendarMonth === true) {
    const thisMonth = now.toISOString().slice(0, 7);
    const nextMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
    startIso = `${thisMonth}-01T00:00:00.000Z`;
    endExclusiveIso = `${nextMonth.toISOString().slice(0, 10)}T00:00:00.000Z`;
  } else if (timeframe === 'month' || timeframe === 'salary_cycle' || timeframe === 'current_salary_cycle' || hasMonth) {
    if (inferredReportMonth !== null) {
      const explicitYear = Number(args.year || args.salaryYear || args.cycleYear || now.getUTCFullYear());
      salaryCycleForReport = buildSalaryCycleForMonth(explicitYear, inferredReportMonth);
    } else {
      const cycleArgs = { ...args, period: timeframe === 'current_salary_cycle' ? undefined : args.period };
      salaryCycleForReport = resolveSalaryCycleFromArgs(cycleArgs, now);
    }
    startIso = salaryCycleForReport.startIso;
    endExclusiveIso = salaryCycleForReport.endExclusiveIso;
  }

  reportScopeTrace.finalTimeframe = timeframe;
  reportScopeTrace.startIso = startIso;
  reportScopeTrace.endExclusiveIso = endExclusiveIso;
  reportScopeTrace.salaryCycle = salaryCycleForReport ? {
    cycleId: salaryCycleForReport.cycleId,
    name: salaryCycleForReport.name,
    month: salaryCycleForReport.month,
    year: salaryCycleForReport.year,
    cycleStart: salaryCycleForReport.cycleStart,
    cycleEndExclusive: salaryCycleForReport.cycleEndExclusive,
  } : null;
  console.warn('[REPORT_SCOPE_TRACE] generate_report_range_resolved', reportScopeTrace);

  let allUserTxs: any[] = [];
  let reportReadPartial = false;
  let reportReadDiagnostics: any = null;

  if (salaryCycleForReport) {
    // A complete written salary-cycle report must use the same robust reader as
    // the vault/cycle UI and must not fail just because the older composite
    // userId+date+orderBy query is unavailable.
    const cycleRead = await readTransactionsForSalaryCycle(salaryCycleForReport, userId, token, SALARY_CYCLE_TRANSACTION_QUERY_LIMIT);
    allUserTxs = cycleRead.transactions || [];
    reportReadPartial = Boolean(cycleRead.partial || cycleRead.limitReached);
    reportReadDiagnostics = { source: 'salary_cycle_reader', cycleId: salaryCycleForReport.cycleId, queryStats: cycleRead.queryStats || [], limit: cycleRead.limit };
  } else {
    let txQuery: any = adminDb.collection('transactions').where('userId', '==', userId);
    if (startIso) txQuery = txQuery.where('date', '>=', startIso);
    if (endExclusiveIso) txQuery = txQuery.where('date', '<', endExclusiveIso);
    if (startIso || endExclusiveIso) txQuery = txQuery.orderBy('date', 'desc').limit(SALARY_CYCLE_TRANSACTION_QUERY_LIMIT);
    const txSnapshot = await txQuery.get();
    allUserTxs = txSnapshot.docs.map(d => ({ id: d.id, ...d.data() }));
    reportReadPartial = Boolean((txSnapshot as any).partial === true || ((startIso || endExclusiveIso) && allUserTxs.length >= SALARY_CYCLE_TRANSACTION_QUERY_LIMIT));
    reportReadDiagnostics = { source: 'direct_user_query', docsRead: allUserTxs.length, limit: (startIso || endExclusiveIso) ? SALARY_CYCLE_TRANSACTION_QUERY_LIMIT : null };
  }

  // Never refuse a requested written report only because the list is long. Save
  // the report and include a warning if the bounded read may be partial.

  // 1. First attempt: category/type/subcategory filtering after the Firestore date window.
  // Date filtering is already pushed into Firestore so salary-cycle months are not
  // accidentally re-filtered as calendar months in Node.js.
  let filtered = allUserTxs.filter((t: any) => {
    if (categoryQuery && !matchesArabicCategory(t, categoryQuery)) return false;
    if (subcategoryQuery && !matchesArabicCategory({ category: t.subcategory || '', subcategory: t.subcategory || '', notes: t.notes || '' }, subcategoryQuery)) return false;
    if (typeQuery && t.type !== typeQuery) return false;
    return true;
  });

  // 2. V6 (LF-18, MF-25): if no transactions match the timeframe, return EMPTY — do NOT
  // silently fall back to ALL time. The report title says "الشهر الحالي" so the data
  // MUST be this month. An empty period report is the honest answer.
  // (The previous fallback misled users into thinking old data was current.)
  // We still keep the category-only fallback if a category was requested AND timeframe
  // was 'all' (which is the default and means no time constraint).

  // 3. If STILL zero transactions and title provides a hint, search by title — but ONLY
  // when timeframe is 'all'. Otherwise we'd be mixing timeframes silently.
  if (filtered.length === 0 && args.title && timeframe === 'all') {
    filtered = allUserTxs.filter((t: any) => matchesArabicCategory(t, args.title));
  }

  // Sort descending by date
  filtered.sort((a: any, b: any) => new Date(b.date || b.createdAt || 0).getTime() - new Date(a.date || a.createdAt || 0).getTime());
  
  const defaultTitle = args.title || (
    timeframe === 'today' ? 'تقرير مصروفات اليوم التفصيلي' :
    timeframe === 'month' ? 'التقرير المالي الشهري الشامل' :
    categoryQuery ? `تقرير تفصيلي لبند (${categoryQuery})` :
    'التقرير المالي الهيكلي الشامل لكافة البنود'
  );

  const reportRef = adminDb.collection('reports').doc();
  const report = buildReportSnapshotRecord({
    userId,
    title: defaultTitle,
    timeframe,
    category: categoryQuery || 'كافة البنود',
    transactions: filtered,
  });
  reportScopeTrace.filteredTransactionsCount = filtered.length;
  reportScopeTrace.readPartial = reportReadPartial;
  reportScopeTrace.readDiagnostics = reportReadDiagnostics;
  console.warn('[REPORT_SCOPE_TRACE] generate_report_before_save', reportScopeTrace);

  const reportToSave = {
    ...report,
    salaryCycle: salaryCycleForReport ? {
      cycleId: salaryCycleForReport.cycleId,
      name: salaryCycleForReport.name,
      start: salaryCycleForReport.cycleStart,
      endExclusive: salaryCycleForReport.cycleEndExclusive,
    } : null,
    requestedFullWrittenReport: true,
    readPartial: reportReadPartial,
    readDiagnostics: reportReadDiagnostics,
    reportScope: {
      timeframe,
      startIso,
      endExclusiveIso,
      salaryCycle: reportScopeTrace.salaryCycle,
      inferredReportMonth,
      requestedTimeframe,
    },
    warning: reportReadPartial ? 'تم حفظ التقرير من القراءة المتاحة، لكن وصلنا حد القراءة المسموح لهذه الفترة؛ قد تحتاج لاحقاً إلى تصدير على دفعات إذا زادت العمليات جداً.' : '',
  };
  
  await reportRef.set(reportToSave);

  await addNotification(userId, `تم إنجاز ${defaultTitle} بنجاح (${filtered.length} عملية)! تجده في حافظة التقارير.`, 'success', adminDb);

  return { 
    success: true, 
    reportId: reportRef.id, 
    transactionsCount: filtered.length,
    readPartial: reportReadPartial,
    salaryCycle: reportToSave.salaryCycle,
    reportScope: reportToSave.reportScope,
    message: `تم إنشاء التقرير الكتابي الكامل وحفظه في حافظة التقارير (${filtered.length} عملية). رقم التقرير: ${reportRef.id}`
  };
}

export async function getReports(args: any, userId: string, token: string) {
  const adminDb = getDb(token);
  const snapshot = await adminDb.collection('reports')
    .where('userId', '==', userId)
    .orderBy('createdAt', 'desc')
    .limit(100)
    .get();
  return { reports: snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() })), partial: (snapshot as any).partial };
}

export async function deleteReport(args: { id: string }, userId: string, token: string) {
  const adminDb = getDb(token);
  console.log("TOOL CALL: deleteReport", args);
  if (!args.id) throw new Error("Report id is required");
  
  const reportRef = adminDb.collection('reports').doc(args.id);
  const doc = await reportRef.get();
  if (doc.exists && doc.data()?.userId === userId) {
    await reportRef.delete();
    return { success: true, message: "تم حذف التقرير بنجاح." };
  }
  return { success: false, message: "التقرير غير موجود أو تم حذفه مسبقاً." };
}

export async function clearAllReports(args: any, userId: string, token: string) {
  const adminDb = getDb(token);
  console.log("TOOL CALL: clearAllReports for user", userId);
  const snapshot = await adminDb.collection('reports').where('userId', '==', userId).get();
  
  if (snapshot.docs.length > 0) {
    const batch = adminDb.batch();
    for (const d of snapshot.docs) {
      batch.delete(adminDb.collection('reports').doc(d.id));
    }
    await batch.commit();
  }
  return { success: true, count: snapshot.docs.length, message: `تم حذف كافة التقارير (${snapshot.docs.length} تقرير).` };
}

export async function memorySave(args: any, userId: string, token: string) {
  const adminDb = getDb(token);
  console.log("TOOL CALL: memorySave", args);
  // Just use debts collection or user profile for memory for now, let's store in a 'memory' subcollection of user
  await adminDb.collection('users').doc(userId).collection('memory').doc(args.key).set({ value: args.value, updatedAt: new Date().toISOString() });
  return { success: true, message: `Saved ${args.key} to memory.` };
}

export async function memorySearch(args: any, userId: string, token: string) {
  const adminDb = getDb(token);
  console.log("TOOL CALL: memorySearch", args);
  // V6 (MF-2): actually filter by args.query while keeping memory lookup bounded.
  // A substring search still happens in-process, but only over a small recent
  // slice so long-running historical entry sessions do not exhaust Firestore quota.
  const limit = Math.max(1, Math.min(80, Number(args.limit) || 40));
  const snapshot = await adminDb.collection('users').doc(userId).collection('memory').limit(limit).get();
  const query = String(args.query || '').trim().toLowerCase();
  const allEntries: { key: string; value: string }[] = [];
  snapshot.docs.forEach(doc => {
    const data = doc.data();
    if (data && data.value) {
      allEntries.push({ key: doc.id, value: String(data.value) });
    }
  });
  if (!query) {
    return { memory: Object.fromEntries(allEntries.slice(0, 20).map(e => [e.key, e.value])), bounded: true, limit };
  }
  const matched = allEntries.filter(e =>
    e.key.toLowerCase().includes(query) || e.value.toLowerCase().includes(query)
  );
  const top = matched.slice(0, 10);
  return { memory: Object.fromEntries(top.map(e => [e.key, e.value])), bounded: true, limit };
}

export async function deleteMemoryKey(args: { key: string }, userId: string, token: string) {
  const adminDb = getDb(token);
  console.log("TOOL CALL: deleteMemoryKey", args);
  if (!args.key) return { error: "Key is required" };
  await adminDb.collection('users').doc(userId).collection('memory').doc(args.key).delete();
  return { success: true, message: `Deleted ${args.key} from memory.` };
}

export async function createRecurringItem(args: any, userId: string, token: string) {
  const adminDb = getDb(token);
  console.log("TOOL CALL: createRecurringItem", args);
  const docRef = adminDb.collection('debts').doc();
  await docRef.set({
    userId,
    type: 'subscription',
    personOrService: args.name,
    amount: args.amount,
    dueDate: args.next_date || new Date().toISOString(),
    status: 'active',
    createdAt: new Date().toISOString()
  });
  return { success: true, message: "Recurring item created." };
}

export async function exportUserData(userId: string, token: string) {
  const adminDb = getDb(token);
  console.log("TOOL CALL: exportUserData for", userId);
  
  // 1. Fetch transactions
  const txSnapshot = await adminDb.collection('transactions').where('userId', '==', userId).get();
  const transactions = txSnapshot.docs.map(d => ({ id: d.id, ...d.data() }));

  // 2. Fetch custom budgets
  const budgetsSnapshot = await adminDb.collection('users').doc(userId).collection('budgets').get();
  const budgets: Record<string, number> = {};
  budgetsSnapshot.docs.forEach((d: any) => {
    const data = d.data();
    if (data && data.limit !== undefined) {
      budgets[d.id] = Number(data.limit);
    }
  });

  // 3. Fetch commitments
  const commitmentsSnapshot = await adminDb.collection('commitments').where('userId', '==', userId).get();
  const commitments = commitmentsSnapshot.docs.map(d => ({ id: d.id, ...d.data() }));

  // 4. Fetch reports
  const reportsSnapshot = await adminDb.collection('reports').where('userId', '==', userId).get();
  const reports = reportsSnapshot.docs.map(d => ({ id: d.id, ...d.data() }));

  // 5. Fetch memory
  const memorySnapshot = await adminDb.collection('users').doc(userId).collection('memory').get();
  const memory: Record<string, string> = {};
  memorySnapshot.docs.forEach(d => {
    const data = d.data();
    if (data && data.value) memory[d.id] = data.value;
  });

  return {
    version: "1.0",
    exportDate: new Date().toISOString(),
    app: "Masrofi AI",
    userId,
    counts: {
      transactions: transactions.length,
      budgets: Object.keys(budgets).length,
      commitments: commitments.length,
      reports: reports.length,
      memoryKeys: Object.keys(memory).length
    },
    transactions,
    budgets,
    commitments,
    reports,
    memory
  };
}

type PreparedImportedNamedRecord = { sourceId: string; docData: any };

type ImportSectionValidationFailure = {
  section: string;
  index: string | number;
  code: string;
  message: string;
};

function isPlainBackupObject(value: any): boolean {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function isSafeBackupDocId(value: string): boolean {
  return Boolean(value && !value.includes('/'));
}

function prepareImportedBudgets(rawBudgets: any): {
  ok: true;
  entries: PreparedImportedNamedRecord[];
} | {
  ok: false;
  failures: ImportSectionValidationFailure[];
} {
  if (rawBudgets === undefined || rawBudgets === null) return { ok: true, entries: [] };
  if (!isPlainBackupObject(rawBudgets)) {
    return { ok: false, failures: [{ section: 'budgets', index: '*', code: 'INVALID_BUDGETS_SECTION', message: 'قسم الموازنات في النسخة الاحتياطية يجب أن يكون كائناً.' }] };
  }
  const entries: PreparedImportedNamedRecord[] = [];
  const failures: ImportSectionValidationFailure[] = [];
  for (const [rawCategory, rawLimit] of Object.entries(rawBudgets)) {
    const category = String(rawCategory || '').trim();
    const limit = typeof rawLimit === 'string' ? Number(rawLimit.trim()) : Number(rawLimit);
    if (!isSafeBackupDocId(category)) {
      failures.push({ section: 'budgets', index: rawCategory, code: 'INVALID_BUDGET_CATEGORY', message: 'اسم بند الموازنة غير صالح للاستعادة.' });
      continue;
    }
    if (!Number.isFinite(limit) || limit <= 0) {
      failures.push({ section: 'budgets', index: rawCategory, code: 'INVALID_BUDGET_LIMIT', message: 'حد الموازنة المستورد يجب أن يكون رقماً موجباً.' });
      continue;
    }
    entries.push({ sourceId: category, docData: { category, limit, updatedAt: new Date().toISOString() } });
  }
  if (failures.length > 0) return { ok: false, failures };
  return { ok: true, entries };
}

function prepareImportedCommitments(rawCommitments: unknown, userId: string): {
  ok: true;
  entries: PreparedImportedNamedRecord[];
} | {
  ok: false;
  failures: ImportSectionValidationFailure[];
} {
  if (rawCommitments === undefined || rawCommitments === null) return { ok: true, entries: [] };
  if (!Array.isArray(rawCommitments)) {
    return { ok: false, failures: [{ section: 'commitments', index: '*', code: 'INVALID_COMMITMENTS_SECTION', message: 'قسم الالتزامات في النسخة الاحتياطية يجب أن يكون مصفوفة.' }] };
  }
  const entries: PreparedImportedNamedRecord[] = [];
  const failures: ImportSectionValidationFailure[] = [];
  const seenIds = new Set<string>();
  for (const [index, rawCommitment] of rawCommitments.entries()) {
    if (!rawCommitment || typeof rawCommitment !== 'object' || Array.isArray(rawCommitment)) {
      failures.push({ section: 'commitments', index, code: 'INVALID_COMMITMENT_OBJECT', message: 'سجل الالتزام ليس كائناً صالحاً.' });
      continue;
    }
    const c = rawCommitment as Record<string, unknown>;
    const sourceId = String(c.id || '').trim();
    if (sourceId) {
      if (!isSafeBackupDocId(sourceId)) {
        failures.push({ section: 'commitments', index, code: 'INVALID_COMMITMENT_ID', message: 'معرف الالتزام غير صالح للاستعادة.' });
        continue;
      }
      if (seenIds.has(sourceId)) {
        failures.push({ section: 'commitments', index, code: 'DUPLICATE_COMMITMENT_ID', message: `معرف الالتزام مكرر داخل النسخة الاحتياطية: ${sourceId}` });
        continue;
      }
      seenIds.add(sourceId);
    }
    const title = String(c.title || '').trim();
    const amount = typeof c.amount === 'string' ? Number(c.amount.trim()) : Number(c.amount);
    if (!title) {
      failures.push({ section: 'commitments', index, code: 'MISSING_COMMITMENT_TITLE', message: 'كل التزام مستورد يجب أن يحتوي عنواناً.' });
      continue;
    }
    if (!Number.isFinite(amount) || amount <= 0) {
      failures.push({ section: 'commitments', index, code: 'INVALID_COMMITMENT_AMOUNT', message: 'كل التزام مستورد يجب أن يحتوي مبلغاً موجباً صالحاً.' });
      continue;
    }
    entries.push({
      sourceId,
      docData: {
        ...c,
        userId,
        title,
        amount: Math.abs(amount),
        dueDate: c.dueDate || new Date().toISOString(),
        category: c.category || 'أقساط والتزامات',
        notes: c.notes || '',
        createdAt: c.createdAt || new Date().toISOString(),
      }
    });
  }
  if (failures.length > 0) return { ok: false, failures };
  return { ok: true, entries };
}

function prepareImportedReports(rawReports: unknown, userId: string): {
  ok: true;
  entries: PreparedImportedNamedRecord[];
} | {
  ok: false;
  failures: ImportSectionValidationFailure[];
} {
  if (rawReports === undefined || rawReports === null) return { ok: true, entries: [] };
  if (!Array.isArray(rawReports)) {
    return { ok: false, failures: [{ section: 'reports', index: '*', code: 'INVALID_REPORTS_SECTION', message: 'قسم التقارير في النسخة الاحتياطية يجب أن يكون مصفوفة.' }] };
  }
  const entries: PreparedImportedNamedRecord[] = [];
  const failures: ImportSectionValidationFailure[] = [];
  const seenIds = new Set<string>();
  for (const [index, rawReport] of rawReports.entries()) {
    if (!rawReport || typeof rawReport !== 'object' || Array.isArray(rawReport)) {
      failures.push({ section: 'reports', index, code: 'INVALID_REPORT_OBJECT', message: 'سجل التقرير ليس كائناً صالحاً.' });
      continue;
    }
    const r = rawReport as Record<string, unknown>;
    const sourceId = String(r.id || '').trim();
    if (sourceId) {
      if (!isSafeBackupDocId(sourceId)) {
        failures.push({ section: 'reports', index, code: 'INVALID_REPORT_ID', message: 'معرف التقرير غير صالح للاستعادة.' });
        continue;
      }
      if (seenIds.has(sourceId)) {
        failures.push({ section: 'reports', index, code: 'DUPLICATE_REPORT_ID', message: `معرف التقرير مكرر داخل النسخة الاحتياطية: ${sourceId}` });
        continue;
      }
      seenIds.add(sourceId);
    }
    const title = String(r.title || '').trim();
    if (!title) {
      failures.push({ section: 'reports', index, code: 'MISSING_REPORT_TITLE', message: 'كل تقرير مستورد يجب أن يحتوي عنواناً.' });
      continue;
    }
    entries.push({
      sourceId,
      docData: {
        ...r,
        userId,
        title,
        category: r.category || 'all',
        date: r.date || r.generatedAt || new Date().toISOString(),
        createdAt: r.createdAt || new Date().toISOString(),
        transactions: Array.isArray(r.transactions) ? r.transactions : [],
      }
    });
  }
  if (failures.length > 0) return { ok: false, failures };
  return { ok: true, entries };
}

function prepareImportedMemory(rawMemory: any): {
  ok: true;
  entries: PreparedImportedNamedRecord[];
} | {
  ok: false;
  failures: ImportSectionValidationFailure[];
} {
  if (rawMemory === undefined || rawMemory === null) return { ok: true, entries: [] };
  if (!isPlainBackupObject(rawMemory)) {
    return { ok: false, failures: [{ section: 'memory', index: '*', code: 'INVALID_MEMORY_SECTION', message: 'قسم الذاكرة في النسخة الاحتياطية يجب أن يكون كائناً.' }] };
  }
  const entries: PreparedImportedNamedRecord[] = [];
  const failures: ImportSectionValidationFailure[] = [];
  for (const [rawKey, rawValue] of Object.entries(rawMemory)) {
    const key = String(rawKey || '').trim();
    if (!isSafeBackupDocId(key)) {
      failures.push({ section: 'memory', index: rawKey, code: 'INVALID_MEMORY_KEY', message: 'مفتاح الذاكرة غير صالح للاستعادة.' });
      continue;
    }
    if (typeof rawValue !== 'string' || !rawValue.trim()) {
      failures.push({ section: 'memory', index: rawKey, code: 'INVALID_MEMORY_VALUE', message: 'قيمة الذاكرة المستوردة يجب أن تكون نصاً غير فارغ.' });
      continue;
    }
    entries.push({ sourceId: key, docData: { value: rawValue, updatedAt: new Date().toISOString() } });
  }
  if (failures.length > 0) return { ok: false, failures };
  return { ok: true, entries };
}

export async function importUserData(payload: any, userId: string, token: string, mode: 'merge' | 'replace' = 'merge') {
  console.log(`TOOL CALL: importUserData for ${userId} with mode=${mode}`);

  const envelope = validateImportEnvelope(payload);
  if (!envelope.ok) return { success: false, ...envelope };

  const adminDb = getDb(token);

  // Handle case where user directly imports an array of transactions or full backup object
  const transactionsToImport: any[] = envelope.isTransactionArrayImport
    ? payload
    : Array.isArray(envelope.backupObject.transactions)
      ? envelope.backupObject.transactions
      : [];

  const rawBudgetsToImport = envelope.isTransactionArrayImport ? undefined : envelope.backupObject.budgets;
  const rawCommitmentsToImport = envelope.isTransactionArrayImport ? undefined : envelope.backupObject.commitments;
  const rawReportsToImport = envelope.isTransactionArrayImport ? undefined : envelope.backupObject.reports;
  const rawMemoryToImport = envelope.isTransactionArrayImport ? undefined : envelope.backupObject.memory;

  // Preflight the entire backup BEFORE any import mutation. Restore/import is a
  // historical-state operation, so we validate and normalize without replaying
  // notifications or other financial side effects during preparation.
  const preparedTransactions = prepareImportedFinancialTransactions(transactionsToImport, userId);
  const preparedBudgets = prepareImportedBudgets(rawBudgetsToImport);
  const preparedCommitments = prepareImportedCommitments(rawCommitmentsToImport, userId);
  const preparedReports = prepareImportedReports(rawReportsToImport, userId);
  const preparedMemory = prepareImportedMemory(rawMemoryToImport);
  const validationFailures = [
    ...('failures' in preparedTransactions ? preparedTransactions.failures : []),
    ...('failures' in preparedBudgets ? preparedBudgets.failures : []),
    ...('failures' in preparedCommitments ? preparedCommitments.failures : []),
    ...('failures' in preparedReports ? preparedReports.failures : []),
    ...('failures' in preparedMemory ? preparedMemory.failures : []),
  ];
  if (validationFailures.length > 0) {
    return {
      success: false,
      reason: 'IMPORT_BACKUP_VALIDATION_FAILED',
      message: 'لم يتم استيراد النسخة لأن بعض سجلات النسخة الاحتياطية غير صالحة. لم يتم حذف أو تغيير البيانات الحالية.',
      validationFailures,
    };
  }

  const transactionEntries = (preparedTransactions as { ok: true; entries: Array<{ sourceId: string; docData: any }> }).entries;
  const budgetEntries = (preparedBudgets as { ok: true; entries: PreparedImportedNamedRecord[] }).entries;
  const commitmentEntries = (preparedCommitments as { ok: true; entries: PreparedImportedNamedRecord[] }).entries;
  const reportEntries = (preparedReports as { ok: true; entries: PreparedImportedNamedRecord[] }).entries;
  const memoryEntries = (preparedMemory as { ok: true; entries: PreparedImportedNamedRecord[] }).entries;

  // Replace mode is all-or-nothing. Build the full mutation plan before changing
  // user state, then commit it in one real Firestore batch.
  if (mode === 'replace') {
    const [oldTx, oldComm, oldRep, oldBudgets, oldMemory] = await Promise.all([
      firebaseAdminDb.collection('transactions').where('userId', '==', userId).get(),
      firebaseAdminDb.collection('commitments').where('userId', '==', userId).get(),
      firebaseAdminDb.collection('reports').where('userId', '==', userId).get(),
      firebaseAdminDb.collection('users').doc(userId).collection('budgets').get(),
      firebaseAdminDb.collection('users').doc(userId).collection('memory').get(),
    ]);

    const deleteCount = oldTx.size + oldComm.size + oldRep.size + oldBudgets.size + oldMemory.size;
    const writeCount = transactionEntries.length + budgetEntries.length + commitmentEntries.length + reportEntries.length + memoryEntries.length;
    const mutationCount = deleteCount + writeCount;

    // Firestore WriteBatch commits are atomic but capped. Keep explicit headroom
    // and fail before mutation rather than chunking a replace into partially committed pieces.
    if (mutationCount > IMPORT_REPLACE_ATOMIC_MUTATION_LIMIT) {
      return {
        success: false,
        retryable: false,
        reason: 'IMPORT_REPLACE_TOO_LARGE_FOR_ATOMIC_COMMIT',
        message: 'النسخة الاحتياطية كبيرة جداً للاستعادة الذرية الآمنة. لم يتم تغيير أي بيانات حالية.',
        mutationCount,
      };
    }

    const batch = firebaseAdminDb.batch();
    oldTx.docs.forEach((d: any) => batch.delete(d.ref));
    oldComm.docs.forEach((d: any) => batch.delete(d.ref));
    oldRep.docs.forEach((d: any) => batch.delete(d.ref));
    oldBudgets.docs.forEach((d: any) => batch.delete(d.ref));
    oldMemory.docs.forEach((d: any) => batch.delete(d.ref));

    for (const prepared of transactionEntries) {
      const ref = prepared.sourceId
        ? firebaseAdminDb.collection('transactions').doc(prepared.sourceId)
        : firebaseAdminDb.collection('transactions').doc();
      batch.set(ref, { ...prepared.docData, sourceId: prepared.sourceId || undefined }, { merge: true });
    }
    for (const prepared of budgetEntries) {
      batch.set(
        firebaseAdminDb.collection('users').doc(userId).collection('budgets').doc(prepared.sourceId),
        prepared.docData,
        { merge: true }
      );
    }
    for (const prepared of commitmentEntries) {
      const ref = prepared.sourceId ? firebaseAdminDb.collection('commitments').doc(prepared.sourceId) : firebaseAdminDb.collection('commitments').doc();
      batch.set(ref, { ...prepared.docData, id: ref.id }, { merge: true });
    }
    for (const prepared of reportEntries) {
      const ref = prepared.sourceId ? firebaseAdminDb.collection('reports').doc(prepared.sourceId) : firebaseAdminDb.collection('reports').doc();
      batch.set(ref, { ...prepared.docData, id: ref.id }, { merge: true });
    }
    for (const prepared of memoryEntries) {
      batch.set(
        firebaseAdminDb.collection('users').doc(userId).collection('memory').doc(prepared.sourceId),
        prepared.docData,
        { merge: true }
      );
    }

    try {
      await batch.commit();
    } catch (e: any) {
      return {
        success: false,
        retryable: true,
        reason: 'IMPORT_REPLACE_ATOMIC_COMMIT_FAILED',
        message: 'فشلت الاستعادة الذرية ولم يتم تطبيق استعادة جزئية.',
        error: e?.message || 'Firestore atomic restore failed',
      };
    }

    const balanceRepair = await repairAccountBalanceSnapshot({ reason: 'import_replace_completed' }, userId, token);
    if (balanceRepair.success !== true) {
      await firebaseAdminDb.collection('users').doc(userId).collection('meta').doc('accountBalances').delete().catch(() => {});
    }
    clearAllLocalUserData(userId);
    return {
      success: true,
      mode,
      atomic: true,
      importedTransactions: transactionEntries.length,
      importedBudgets: budgetEntries.length,
      importedCommitments: commitmentEntries.length,
      importedReports: reportEntries.length,
      importedMemory: memoryEntries.length,
      accountBalanceSnapshotRepaired: balanceRepair.success === true,
      accountBalanceRepairDocsRead: balanceRepair.transactionDocsRead || 0,
    };
  }

  // Merge mode: write only records that passed the full preflight validator.
  let importedTxCount = 0;
  for (const prepared of transactionEntries) {
    const docRef = prepared.sourceId ? adminDb.collection('transactions').doc(prepared.sourceId) : adminDb.collection('transactions').doc();
    const writeResult = await docRef.set({ ...prepared.docData, sourceId: prepared.sourceId || undefined });
    if (writeResult?.pending || writeResult?.synced === false) {
      return {
        success: false,
        retryable: true,
        reason: 'IMPORT_NOT_DURABLY_COMMITTED',
        message: 'توقف الاستيراد لأن إحدى العمليات لم تُحفظ في السحابة بشكل مؤكد.',
        importedBeforeFailure: importedTxCount,
        error: writeResult?.error,
      };
    }
    importedTxCount++;
  }

  // 2. Write custom budgets
  let importedBudgetsCount = 0;
  for (const prepared of budgetEntries) {
    await adminDb.collection('users').doc(userId).collection('budgets').doc(prepared.sourceId).set(prepared.docData);
    importedBudgetsCount++;
  }

  // 3. Write commitments
  let importedCommitmentsCount = 0;
  for (const prepared of commitmentEntries) {
    const docRef = prepared.sourceId ? adminDb.collection('commitments').doc(prepared.sourceId) : adminDb.collection('commitments').doc();
    await docRef.set({ ...prepared.docData, id: docRef.id });
    importedCommitmentsCount++;
  }

  // 4. Write reports
  let importedReportsCount = 0;
  for (const prepared of reportEntries) {
    const docRef = prepared.sourceId ? adminDb.collection('reports').doc(prepared.sourceId) : adminDb.collection('reports').doc();
    await docRef.set({ ...prepared.docData, id: docRef.id });
    importedReportsCount++;
  }

  // 5. Write memory
  let importedMemoryCount = 0;
  for (const prepared of memoryEntries) {
    await adminDb.collection('users').doc(userId).collection('memory').doc(prepared.sourceId).set(prepared.docData);
    importedMemoryCount++;
  }

  const balanceRepair = await repairAccountBalanceSnapshot({ reason: 'import_merge_completed' }, userId, token);
  if (balanceRepair.success !== true) {
    await firebaseAdminDb.collection('users').doc(userId).collection('meta').doc('accountBalances').delete().catch(() => {});
  }
  await addNotification(userId, `تم استيراد ${importedTxCount} عملية مالية و ${importedBudgetsCount} موازنة بنجاح.`, 'success', adminDb);

  return {
    success: true,
    mode,
    counts: {
      transactions: importedTxCount,
      budgets: importedBudgetsCount,
      commitments: importedCommitmentsCount,
      reports: importedReportsCount,
      memory: importedMemoryCount
    },
    accountBalanceSnapshotRepaired: balanceRepair.success === true,
    accountBalanceRepairDocsRead: balanceRepair.transactionDocsRead || 0,
    message: `تم بنجاح استيراد ${importedTxCount} عملية مالية، ${importedBudgetsCount} موازنة، و ${importedCommitmentsCount} التزام.`
  };
}

/**
 * V6 (HF-1): REMOVED searchMarketInformation — the hardcoded fake-price tool.
 * AI must use only `search_local_market` which uses real Google Search grounding.
 * If a real search fails, the response says so explicitly; no fabricated prices.
 */
export async function searchMarketInformation(args: any, userId: string, token: string) {
  // Kept as a stub that always refuses, to prevent any prompt that still references
  // this tool from accidentally executing it. The function declaration is removed below.
  return {
    success: false,
    deprecated: true,
    message: 'تم إيقاف هذه الأداة المزيّفة. استخدم search_local_market للحصول على أسعار حقيقية موثقة.',
    useInstead: 'search_local_market',
  };
}

export async function repairAccountBalanceSnapshot(args:any,userId:string,token:string){
  try {
    const [txSnap, vaultMetaSnap] = await Promise.all([
      firebaseAdminDb.collection('transactions').where('userId','==',userId).get(),
      firebaseAdminDb.collection('users').doc(userId).collection('meta').doc('savingsVault').get(),
    ]);
    const ledgerBalances = calculateBalancesFromDocs(txSnap.docs);
    const vaultMetaBalance = vaultMetaSnap.exists ? roundMoney(Number(vaultMetaSnap.data()?.currentBalance || 0)) : null;
    const balances = { ...ledgerBalances, vault: vaultMetaBalance !== null ? vaultMetaBalance : roundMoney(Number(ledgerBalances.vault || 0)), total: roundMoney(Number(ledgerBalances.cash || 0) + Number(ledgerBalances.palPay || 0)) };
    const now = new Date().toISOString();
    await firebaseAdminDb.collection('users').doc(userId).collection('meta').doc('accountBalances').set({
      userId,
      cash: roundMoney(Number(balances.cash || 0)),
      palPay: roundMoney(Number(balances.palPay || 0)),
      debt: roundMoney(Number(balances.debt || 0)),
      vault: roundMoney(Number(balances.vault || 0)),
      total: roundMoney(Number(balances.cash || 0) + Number(balances.palPay || 0)),
      source: 'repair_full_ledger',
      repairedAt: now,
      updatedAt: now,
      transactionDocsRead: txSnap.docs.length,
      version: 1,
    }, { merge: true });
    return { success: true, balances, partial: false, transactionDocsRead: txSnap.docs.length, source: 'repair_full_ledger' };
  } catch (e:any) {
    return { success: false, retryable: true, partial: true, reason: 'ACCOUNT_BALANCE_REPAIR_FAILED', error: e?.message || String(e) };
  }
}

export async function getBalance(args:any,userId:string,token:string){
  // Normal financial reads are O(1): one account balance snapshot document.
  // Full-ledger reconstruction is limited to one-time bootstrap or explicit repair.
  try {
    const metaRef = firebaseAdminDb.collection('users').doc(userId).collection('meta').doc('accountBalances');
    const metaSnap = await metaRef.get();
    if (metaSnap.exists) {
      const data = metaSnap.data() || {};
      const cash = roundMoney(Number(data.cash || 0));
      const palPay = roundMoney(Number(data.palPay || 0));
      const debt = roundMoney(Number(data.debt || 0));
      const vault = roundMoney(Number(data.vault || 0));
      const balances = { cash, palPay, debt, vault, total: roundMoney(cash + palPay) };
      return {
        balances,
        total: balances.total,
        partial: false,
        cloudStorageConfirmed: true,
        source: 'accountBalances',
        readEfficiency: { metaDocsRead: 1, transactionDocsRead: 0 },
      };
    }

    const repaired = await repairAccountBalanceSnapshot({ reason: 'missing_account_balance_snapshot_bootstrap' }, userId, token);
    if (repaired.success) {
      return {
        balances: repaired.balances,
        total: repaired.balances.cash + repaired.balances.palPay,
        partial: false,
        cloudStorageConfirmed: true,
        source: 'bootstrap_full_ledger_once',
        readEfficiency: { metaDocsRead: 1, transactionDocsRead: repaired.transactionDocsRead },
      };
    }
    throw new Error(repaired.error || 'balance snapshot repair failed');
  } catch (e: any) {
    const localDb = getDb(token);
    const cachedSnap = await localDb.collection('transactions').where('userId','==',userId).limit(300).get();
    const cachedBalances = calculateBalancesFromDocs(cachedSnap.docs);
    return {
      balances: cachedBalances,
      total: cachedBalances.cash + cachedBalances.palPay,
      partial: true,
      cloudStorageConfirmed: false,
      source: 'offline-cache-bounded',
      error: e?.message || 'Firestore balance read failed',
      readEfficiency: { metaDocsRead: 1, transactionDocsRead: cachedSnap.docs.length, boundedFallback: true, limit: 300 },
    };
  }
}

export async function transferMoney(args: any, userId: string, token: string) {
  const adminDb = getDb(token);
  console.log("TOOL CALL: transferMoney", args);
  
  const amount = parseAbsoluteFinancialAmount(args.amount);
  if (amount <= 0) {
    return { success: false, needsClarification: true, reason: 'INVALID_AMOUNT', missingFields: ['amount'], message: 'ما قيمة التحويل أو الدين بالضبط؟' };
  }

  const fromAccount = normalizeLedgerAccount(args.fromAccount || args.account || 'cash');
  const originalBorrowText = normalizeArabicText(`${args.currentUserText || ''} ${args.userText || ''} ${args.clarificationReplyText || ''}`);
  const hasBorrowText = Boolean(originalBorrowText.trim());
  const explicitBorrowCash = /كاش|نقد|نقدي|نقدا/.test(originalBorrowText);
  const explicitBorrowPalPay = /palpay|pal pay|بال باي|بالباي|محفظه|محفظة/.test(originalBorrowText);
  const borrowDestinationClarifiedByUser = Boolean(args.borrowDestinationClarifiedByUser || args.destinationClarifiedByUser);
  if (fromAccount === 'debt' && (!args.toAccount || (hasBorrowText && !borrowDestinationClarifiedByUser && !args.clarificationReplyText && !explicitBorrowCash && !explicitBorrowPalPay))) {
    return { success: false, needsClarification: true, reason: 'MISSING_BORROW_DESTINATION', missingFields: ['borrowDestination'], message: 'استلمت المبلغ نقدي (كاش) أم في محفظة PalPay؟' };
  }
  let toAccount = normalizeLedgerAccount(args.toAccount || (fromAccount === 'cash' ? 'palPay' : 'cash'));
  
  if (fromAccount === toAccount) {
    toAccount = fromAccount === 'cash' ? 'palPay' : 'cash';
  }

  const accountDisplayName = (account: string) => account === 'palPay' ? 'PalPay' : account === 'debt' ? 'الديون' : account === 'vault' ? 'الخزنة' : 'النقدي';
  const fromName = accountDisplayName(fromAccount);
  const toName = accountDisplayName(toAccount);
  const creditor = String(args.creditor || args.person || args.merchant || '').trim();

  // Borrowing money (debt -> cash/PalPay) must identify the creditor; otherwise later repayment cannot be resolved safely.
  if (fromAccount === 'debt' && !creditor) {
    return { success: false, needsClarification: true, reason: 'MISSING_CREDITOR', missingFields: ['creditor'], message: 'ممن استدنت هذا المبلغ؟' };
  }

  // Internal wallet transfers cannot create money by driving the source wallet below zero.
  if (fromAccount !== 'debt' && toAccount !== 'debt') {
    const current = await getBalance({}, userId, token);
    // V6.2 (FINDING-07): refuse balance-sensitive transfer on partial state.
    if (current.partial === true) {
      return {
        success: false,
        retryable: true,
        reason: 'PARTIAL_STATE_UNSAFE',
        message: 'تعذّر التحقق من رصيدك الحالي بدقة. لا يمكن تنفيذ التحويل الآن. حاول مرة أخرى عند استعادة الاتصال.',
        operationId: String(args.operationId || `transfer_${Date.now()}_${Math.random().toString(36).slice(2,10)}`),
      };
    }
    const available = Number(current?.balances?.[fromAccount] || 0);
    if (amount > available + 0.0001) {
      return { success: false, needsClarification: true, reason: 'INSUFFICIENT_FUNDS', message: `الرصيد المتاح في ${fromName} هو ${available} ₪ فقط. هل تريد مبلغاً آخر؟` };
    }
  }

  const transferDateResult = normalizeHistoricalTransactionDate({
    date: args.date,
    historicalMonth: args.historicalMonth || args.monthContext || args.entryMonth,
    day: args.day || args.transactionDay,
    now: new Date(),
  });
  if (transferDateResult.ok === false) {
    return { success: false, needsClarification: true, reason: transferDateResult.reason, message: transferDateResult.message };
  }

  // Create ONE single transaction of type 'transfer'. Vault transfers are locked
  // internal transfers: they never create income/expense, but they move liquidity
  // out of cash/PalPay into the unavailable vault account, or release it back.
  const txRef = adminDb.collection('transactions').doc();
  const transferNow = new Date().toISOString();
  const transferTransactionType = toAccount === 'vault'
    ? 'VAULT_LOCK_MANUAL'
    : fromAccount === 'vault'
      ? 'VAULT_RELEASE'
      : fromAccount === 'debt'
        ? 'DEBT_BORROWING'
        : 'INTERNAL_TRANSFER';
  const tx = {
    userId,
    amount,
    type: 'transfer',
    account: fromAccount,
    fromAccount,
    toAccount,
    category: toAccount === 'vault' ? 'تحويل للخزنة' : fromAccount === 'vault' ? 'فتح الخزنة' : 'تحويل داخلي',
    subcategory: `تحويل من ${fromName} إلى ${toName}`,
    notes: args.notes || `تحويل مبلغ ${amount} ₪ من ${fromName} إلى ${toName}`,
    merchant: fromAccount === 'debt' ? creditor : (fromAccount === 'vault' || toAccount === 'vault' ? 'الخزنة' : 'تحويل بين المحافظ'),
    creditor: fromAccount === 'debt' ? creditor : '',
    creditorKey: fromAccount === 'debt' ? normalizeCreditorName(creditor) : '',
    transactionType: transferTransactionType,
    operationId: String(args.operationId || `transfer_${Date.now()}_${Math.random().toString(36).slice(2,10)}`),
    necessity: '',
    date: transferDateResult.date,
    dateSource: transferDateResult.source,
    createdAt: transferNow
  };

  // V6.2 (FINDING-02): atomic balance-sensitive transfer.
  // No more TOCTOU: the balance check + write happen inside a single
  // Firestore runTransaction. Atomic failure NEVER downgrades to direct write.
  let actualTxId = txRef.id;
  let committedBalances: any = undefined;
  let writeResult: WriteResult | { durability: 'committed'; synced: true; pending: false };
  try {
    const atomicResult = await atomicTransferMoney(userId, tx, { riskConfirmed: Boolean(args.riskConfirmed) });
    if (!atomicResult.ok) {
      const failReason = (atomicResult as any).reason as string;
      const failAvailable = (atomicResult as any).available as number | undefined;
      if (failReason === 'INSUFFICIENT_FUNDS_ATOMIC' || failReason === 'INSUFFICIENT_VAULT_FUNDS_ATOMIC') {
        return {
          success: false,
          needsClarification: true,
          reason: failReason === 'INSUFFICIENT_VAULT_FUNDS_ATOMIC' ? 'INSUFFICIENT_VAULT_FUNDS' : 'INSUFFICIENT_FUNDS',
          message: `الرصيد المتاح في ${fromName} هو ${failAvailable} ₪ فقط. التحويل مرفوض لمنع تجاوز الرصيد.`,
        };
      }
      return { success: false, error: failReason };
    }
    actualTxId = atomicResult.docId;
    committedBalances = (atomicResult as any).balances;
    writeResult = { durability: 'committed', synced: true, pending: false };
  } catch (atomicErr: any) {
    // V6.2 (FINDING-04): NO direct write fallback. Surface as FAILED.
    console.error('[transferMoney] atomic transaction FAILED — refusing direct write fallback:', atomicErr?.message);
    const isRetryable = atomicErr?.code === 8 || /RESOURCE_EXHAUSTED|quota|contention|aborted/i.test(String(atomicErr?.message || ''));
    return {
      success: false,
      retryable: isRetryable,
      reason: isRetryable ? 'ATOMIC_FAILED_RETRYABLE' : 'ATOMIC_FAILED',
      message: isRetryable
        ? 'تعذّر تنفيذ التحويل الآن بسبب ضغط مؤقت على قاعدة البيانات. حاول مرة أخرى خلال لحظات.'
        : `تعذّر تنفيذ التحويل بشكل آمن: ${atomicErr?.message || 'unknown error'}`,
      operationId: tx.operationId,
    };
  }

  await addNotification(userId, `تم تحويل ${amount} ₪ من ${fromName} إلى ${toName} بنجاح.`, 'success', adminDb, {
    idempotencyKey: `transfer-success:${tx.operationId}`,
    transactionId: actualTxId,
    operationId: tx.operationId,
    metadata: { amount, fromAccount, toAccount }
  });

  return {
    success: true,
    transactionId: actualTxId,
    operationId: tx.operationId,
    message: `تم تحويل ${amount} ₪ من ${fromName} إلى ${toName} بنجاح. التحويل لا يؤثر على الدخل أو المصروف العام.`,
    currentBalances: committedBalances,
    durability: writeResult.durability,
    pending: writeResult.pending,
    partial: writeResult.pending,
  };
}

function normalizeCreditorName(value: any): string {
  return normalizeCreditorKey(value);
}

// Compatibility export for existing callers/tests. The financial rule itself now
// lives in the shared domain core; this adapter only unwraps Firestore snapshots.
export function calculateBalancesFromDocs(docs: any[]) {
  const transactions = (docs || []).map((doc: any) => typeof doc?.data === 'function' ? doc.data() : doc);
  return calculateBalances(transactions);
}

function calculateOpenCreditorDebts(docs: any[]) {
  const transactions = (docs || []).map((doc: any) => typeof doc?.data === 'function' ? doc.data() : doc);
  const creditorDebts = calculateBreakdown(transactions).creditorDebts;
  const ignoredKeys = new Set([normalizeCreditorName('سداد دين'), normalizeCreditorName('تحويل بين المحافظ')]);
  const creditorNames = new Map<string, string>();
  for (const tx of transactions) {
    const creditor = String(tx?.creditor || tx?.merchant || '').trim();
    const key = normalizeCreditorName(creditor);
    if (!key || ignoredKeys.has(key) || creditorNames.has(key)) continue;
    creditorNames.set(key, creditor);
  }
  return Object.entries(creditorDebts)
    .filter(([key, remaining]) => !ignoredKeys.has(key) && Number(remaining) > 0.0001)
    .map(([key, remaining]) => ({
      key,
      creditor: creditorNames.get(key) || key,
      remaining: Math.round(Number(remaining) * 100) / 100,
    }));
}

function debtSettlementText(args: any): string {
  return normalizeArabicText(`${args?.userText || ''} ${args?.currentUserText || ''} ${args?.question || ''} ${args?.notes || ''} ${args?.dateMode || ''} ${args?.paymentDateMode || ''} ${args?.sourceCycle || ''} ${args?.salaryCycle || ''}`);
}

function wantsHistoricalDebtSettlement(args: any): boolean {
  const text = debtSettlementText(args);
  return Boolean(
    args?.backdateToDebtDate === true ||
    args?.settleAtDebtDate === true ||
    args?.useDebtDate === true ||
    args?.fromSalaryCycleBalance === true ||
    args?.sourceCycle ||
    args?.salaryCycle ||
    args?.salaryMonth ||
    args?.month ||
    /لحظه الدين|لحظة الدين|تاريخ الدين|وقت الدين|من رصيد شهر|من رصيد دوره|من رصيد دورة|لدوره شهر|لدورة شهر|دوره شهر|دورة شهر/.test(text)
  );
}

function isDebtCreationTx(tx: any): boolean {
  const kind = String(tx?.transactionType || '');
  return kind === 'CREDIT_PURCHASE'
    || kind === 'DEBT_BORROWING'
    || (tx?.type === 'expense' && normalizeLedgerAccount(tx?.account) === 'debt')
    || (tx?.type === 'transfer' && normalizeLedgerAccount(tx?.fromAccount || tx?.account) === 'debt');
}

function resolveDebtSettlementDate(args: any, creditorTransactions: any[], now: Date = new Date()) {
  const explicit = normalizeHistoricalTransactionDate({ date: args?.date || args?.paymentDate || args?.settlementDate, year: args?.year || args?.salaryYear, now });
  if (explicit.ok && explicit.source !== 'current-time') {
    const cycle = getSalaryCycleForDate(explicit.date, now);
    return { date: explicit.date, dateSource: explicit.source, cycle, historical: true, matchedDebtDate: false };
  }
  if (!wantsHistoricalDebtSettlement(args)) {
    const date = now.toISOString();
    return { date, dateSource: 'current-time', cycle: getSalaryCycleForDate(date, now), historical: false, matchedDebtDate: false };
  }

  const rawText = `${args?.userText || ''} ${args?.currentUserText || ''} ${args?.question || ''} ${args?.notes || ''}`;
  const inferredMonth = parseSalaryCycleMonth(args?.salaryMonth ?? args?.month ?? args?.monthNumber ?? rawText);
  const inferredYear = Number(args?.salaryYear || args?.year || now.getUTCFullYear());
  const targetCycle = inferredMonth ? buildSalaryCycleForMonth(inferredYear, inferredMonth, now) : null;
  const debtCreations = (creditorTransactions || [])
    .filter(isDebtCreationTx)
    .filter((tx: any) => {
      if (!targetCycle) return true;
      const d = String(tx?.date || tx?.createdAt || '');
      return d >= targetCycle.startIso && d < targetCycle.endExclusiveIso;
    })
    .sort((a: any, b: any) => String(a?.date || a?.createdAt || '').localeCompare(String(b?.date || b?.createdAt || '')));

  const matchedDebt = debtCreations[0];
  if (matchedDebt?.date || matchedDebt?.createdAt) {
    const date = String(matchedDebt.date || matchedDebt.createdAt);
    return { date, dateSource: 'matched-debt-date', cycle: getSalaryCycleForDate(date, now), historical: true, matchedDebtDate: true, matchedDebtId: matchedDebt.id || matchedDebt.operationId || null };
  }
  if (targetCycle) {
    const date = `${targetCycle.cycleEnd}T23:58:00.000Z`;
    return { date, dateSource: 'salary-cycle-end-fallback', cycle: targetCycle, historical: true, matchedDebtDate: false };
  }
  const date = now.toISOString();
  return { date, dateSource: 'current-time-fallback', cycle: getSalaryCycleForDate(date, now), historical: false, matchedDebtDate: false };
}

export async function payDebt(args:any,userId:string,token:string){
  const adminDb=getDb(token), amount=parsePositiveFinancialAmount(args.amount);
  if(amount<=0)return{success:false,needsClarification:true,reason:'INVALID_AMOUNT',missingFields:['amount'],message:'كم مبلغ سداد الدين؟'};
  const rawPaymentAccount = args.paymentMethod || args.fromAccount;
  const originalPaymentText = normalizeArabicText(`${args.currentUserText || ''} ${args.userText || ''} ${args.clarificationReplyText || ''}`);
  const hasPaymentText = Boolean(originalPaymentText.trim());
  const explicitPaymentCash = /كاش|نقد|نقدي|نقدا/.test(originalPaymentText);
  const explicitPaymentPalPay = /palpay|pal pay|بال باي|بالباي|محفظه|محفظة/.test(originalPaymentText);
  const debtPaymentAccountClarifiedByUser = Boolean(args.debtPaymentAccountClarifiedByUser || args.paymentMethodClarifiedByUser || args.accountClarifiedByUser);
  if (!rawPaymentAccount || (hasPaymentText && !debtPaymentAccountClarifiedByUser && !args.clarificationReplyText && !explicitPaymentCash && !explicitPaymentPalPay)) {
    return { success:false, needsClarification:true, reason:'MISSING_DEBT_PAYMENT_ACCOUNT', missingFields:['debtPaymentAccount'], message:'هل سددت الدين من الكاش أم من محفظة PalPay؟' };
  }
  let fromAccount=normalizeAccount(rawPaymentAccount);
  if(fromAccount==='debt'){
    return { success:false, needsClarification:true, reason:'MISSING_DEBT_PAYMENT_ACCOUNT', missingFields:['debtPaymentAccount'], message:'سداد الدين لازم يكون من الكاش أو PalPay، وليس من حساب الدين. من أين دفعت؟' };
  }
  const fromName=fromAccount==='palPay'?'محفظة PalPay':'النقدي (كاش)';
  const requestedCreditor = String(args.creditor||args.person||args.merchant||'').trim();
  const requestedCreditorKey = normalizeCreditorName(requestedCreditor);
  if (!requestedCreditorKey) {
    const recentDebtSnap = await adminDb.collection('transactions')
      .where('userId','==',userId)
      .where('account','==','debt')
      .limit(50)
      .get()
      .catch(() => ({ docs: [], partial: true } as any));
    const options = calculateOpenCreditorDebts(recentDebtSnap.docs).slice(0, 8);
    return {
      success:false,
      needsClarification:true,
      reason:'MISSING_CREDITOR_BOUNDED',
      missingFields:['creditor'],
      options,
      partial: Boolean((recentDebtSnap as any).partial),
      message:'لأي دائن تريد سداد الدين؟ اذكر اسم الشخص أو المحل حتى أتحقق باستعلام محدود بدل قراءة كل السجل.'
    };
  }

  const [creditorSnap, balanceResult] = await Promise.all([
    adminDb.collection('transactions')
      .where('userId','==',userId)
      .where('creditorKey','==',requestedCreditorKey)
      .get(),
    getBalance({}, userId, token),
  ]);
  if ((creditorSnap as any).partial === true || balanceResult.partial === true) {
    return { success:false, retryable:true, reason:'PARTIAL_STATE_UNSAFE', message:'تعذّر التحقق من ديونك أو رصيدك الحالي بدقة. لا يمكن تنفيذ السداد الآن.' };
  }

  const debts=calculateOpenCreditorDebts(creditorSnap.docs);
  const selection=selectOpenCreditorDebt({ debts, requestedCreditor, amount });
  if(selection.ok === false)return{success:false,needsClarification:true,reason:selection.reason,options:selection.options,message:selection.message};
  const selected=selection.selected;
  if(amount>selected.remaining+0.0001)return{success:false,needsClarification:true,reason:'OVERPAYMENT',creditor:selected.creditor,remaining:selected.remaining,message:`المتبقي لـ ${selected.creditor} هو ${selected.remaining} ₪ فقط.`};
  const available=Number(balanceResult?.balances?.[fromAccount]||0);
  if(amount>available+0.0001)return{success:false,needsClarification:true,reason:'INSUFFICIENT_FUNDS',available,message:`الرصيد المتاح في ${fromName} هو ${available} ₪ فقط. لا يمكن تنفيذ سداد ${amount} ₪.`};

  const operationId=String(args.operationId||`debtpay_${Date.now()}_${Math.random().toString(36).slice(2,10)}`);
  const creditorTransactions = creditorSnap.docs.map((d:any)=>({ id:d.id, ...d.data() }));
  const settlementDate = resolveDebtSettlementDate(args, creditorTransactions, new Date());
  const createdAt = new Date().toISOString();
  const tx={
    userId,
    operationId,
    amount,
    type:'transfer',
    account:fromAccount,
    fromAccount,
    toAccount:'debt',
    transactionType:'DEBT_PAYMENT',
    creditor:selected.creditor,
    creditorKey:selected.key,
    category:'سداد ديون والتزامات',
    subcategory:`سداد دين - ${selected.creditor}`,
    notes:args.notes||`سداد دين بقيمة ${amount} ₪ من ${fromName} لصالح ${selected.creditor}`,
    merchant:selected.creditor,
    necessity:'ضروري',
    date:settlementDate.date,
    createdAt,
    dateSource:settlementDate.dateSource,
    settlementCycleId:settlementDate.cycle.cycleId,
    settlementCycleName:settlementDate.cycle.name,
    historicalSettlement:settlementDate.historical,
    matchedDebtDate:settlementDate.matchedDebtDate,
    matchedDebtId:(settlementDate as any).matchedDebtId || null,
  };
  let atomicResult: Awaited<ReturnType<typeof atomicPayDebt>>;
  try {
    atomicResult = await atomicPayDebt(userId, tx, selected.key, { riskConfirmed: Boolean(args.riskConfirmed) });
  } catch (atomicErr: any) {
    console.error('[payDebt] atomic transaction FAILED — refusing direct write fallback:', atomicErr?.message);
    const isRetryable = atomicErr?.code === 8 || /RESOURCE_EXHAUSTED|quota|contention|aborted/i.test(String(atomicErr?.message || ''));
    return {
      success: false,
      needsClarification: !isRetryable,
      retryable: isRetryable,
      reason: isRetryable ? 'ATOMIC_FAILED_RETRYABLE' : 'ATOMIC_FAILED',
      message: isRetryable
        ? 'تعذّر تنفيذ سداد الدين الآن بسبب ضغط مؤقت على قاعدة البيانات. حاول مرة أخرى خلال لحظات.'
        : `تعذّر تنفيذ سداد الدين بشكل آمن: ${atomicErr?.message || 'unknown error'}`,
      operationId,
    };
  }
  if (!atomicResult.ok) {
    const failReason = (atomicResult as any).reason as string;
    const failRemaining = (atomicResult as any).remaining as number | undefined;
    const failAvailable = (atomicResult as any).available as number | undefined;
    if (failReason === 'OVERPAYMENT_ATOMIC') return { success: false, needsClarification: true, reason: 'OVERPAYMENT', creditor: selected.creditor, remaining: failRemaining, message: `المتبقي لـ ${selected.creditor} هو ${failRemaining} ₪ فقط (تم رصد محاولة سداد متزامنة).` };
    if (failReason === 'INSUFFICIENT_FUNDS_ATOMIC') return { success: false, needsClarification: true, reason: 'INSUFFICIENT_FUNDS', available: failAvailable, message: `الرصيد المتاح في ${fromName} هو ${failAvailable} ₪ فقط.` };
    return { success: false, error: failReason };
  }
  const finalTxId = atomicResult.docId;
  const affectedPaymentCycle = getSalaryCycleForDate(tx.date || tx.createdAt || new Date().toISOString(), new Date());
  const recalculatedCycles = await recalculateCyclesForTransactionChange(userId, token, null, { id: finalTxId, ...tx }, 'pay_debt_settlement');
  const historicalSuffix = settlementDate.historical ? ` كتسوية تاريخية ضمن ${affectedPaymentCycle.name} بتاريخ ${String(tx.date).slice(0,10)}` : ' بتاريخ اليوم';
  await addNotification(userId,`تم سداد ${amount} ₪ من دين ${selected.creditor} من ${fromName}${historicalSuffix}.`, 'success', adminDb);
  return{success:true,transactionId:finalTxId,operationId,creditor:selected.creditor,remainingDebtForCreditor:(atomicResult as any).remaining ?? Math.max(0,Math.round((selected.remaining-amount)*100)/100),affectedCycleId:affectedPaymentCycle.cycleId,affectedCycleIds:[affectedPaymentCycle.cycleId],settlementDate:tx.date,dateSource:settlementDate.dateSource,historicalSettlement:settlementDate.historical,settlementCycle:{cycleId:affectedPaymentCycle.cycleId,cycleStart:affectedPaymentCycle.cycleStart,cycleEnd:affectedPaymentCycle.cycleEnd,name:affectedPaymentCycle.name},recalculatedCycles,message:`تم سداد ${amount} ₪ من دين ${selected.creditor} بنجاح من ${fromName}${historicalSuffix}.`,currentBalances:(atomicResult as any).balances, readEfficiency:{ creditorDocsRead: creditorSnap.docs.length, accountBalanceDocsRead: 1, recalculatedCycles: recalculatedCycles?.map((c:any)=>c?.cycleId).filter(Boolean) }};
}

export async function getRecentTransactions(args: any, userId: string, token: string) {
  const adminDb = getDb(token);
  const limit = Math.max(1, Math.min(20, Number(args?.limit) || 10));
  const userText = String(args?.userText || args?.currentUserText || '').trim();
  const normalizedUserText = normalizeArabicText(userText).toLowerCase();
  const asDate = (value: any): Date | null => {
    if (!value) return null;
    if (value instanceof Date) return value;
    if (typeof value?.toDate === 'function') return value.toDate();
    if (typeof value?.toMillis === 'function') return new Date(value.toMillis());
    if (typeof value?.seconds === 'number') return new Date(value.seconds * 1000);
    const parsed = new Date(String(value));
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  };
  const localDateKey = (value: any): string | null => {
    const parsed = asDate(value);
    if (!parsed) return null;
    // User/session timezone is GMT+3 in Render logs and the mobile UI.
    return new Date(parsed.getTime() + 3 * 60 * 60 * 1000).toISOString().slice(0, 10);
  };
  const normalizeDateKey = (value: any): string | null => {
    const raw = String(value || '').trim();
    if (!raw) return null;
    if (/^(today|اليوم)$/i.test(raw)) return localDateKey(new Date());
    const iso = raw.match(/(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})/);
    if (iso) {
      const y = Number(iso[1]);
      const m = String(Number(iso[2])).padStart(2, '0');
      const d = String(Number(iso[3])).padStart(2, '0');
      return `${y}-${m}-${d}`;
    }
    return localDateKey(raw);
  };
  const wantsToday = Boolean(args?.today)
    || /اليوم|نهار اليوم|اليوميه|اليومية/.test(normalizedUserText)
    || /^(today|اليوم)$/i.test(String(args?.date || '').trim());
  const requestedDateKey = normalizeDateKey(args?.date || args?.createdDate || args?.targetDate)
    || (wantsToday ? localDateKey(new Date()) : null);
  const typeFilter = String(args?.type || '').trim().toLowerCase()
    || (/مصروف|مصروفات|مشتريات|صرف/.test(normalizedUserText) ? 'expense' : '');
  const boundedLimit = Math.max(300, limit * 25);
  const timestampMs = (value: any): number => {
    const parsed = asDate(value);
    return parsed ? parsed.getTime() : 0;
  };
  const sortByRecency = (items: any[]) => items.sort((a: any, b: any) => {
    const aTime = timestampMs(a.createdAt || a.updatedAt || a.date);
    const bTime = timestampMs(b.createdAt || b.updatedAt || b.date);
    if (bTime !== aTime) return bTime - aTime;
    return String(b.id || '').localeCompare(String(a.id || ''));
  });
  const matchesRequestedScope = (t: any) => {
    if (typeFilter && String(t.type || '').toLowerCase() !== typeFilter) return false;
    if (!requestedDateKey) return true;
    const txDateKey = String(t.date || '').slice(0, 10);
    const txLocalDateKey = localDateKey(t.date);
    const createdLocalDateKey = localDateKey(t.createdAt || t.updatedAt);
    // "تسجلت اليوم" means created today; "مصروف اليوم" means transaction date today.
    return txDateKey === requestedDateKey || txLocalDateKey === requestedDateKey || createdLocalDateKey === requestedDateKey;
  };
  const compactDocs = (snap: any) => (snap?.docs || []).map((d: any) => ({ id: d.id, ...d.data() }));
  let docs: any[] = [];
  let source = requestedDateKey ? 'bounded_user_query_today_scope' : 'createdAt_desc';
  const mergeUnique = (items: any[]) => {
    const map = new Map<string, any>();
    for (const item of items || []) {
      const id = String(item?.id || item?.operationId || `${item?.createdAt || ''}:${item?.date || ''}:${item?.amount || ''}:${map.size}`);
      if (!map.has(id)) map.set(id, item);
    }
    return Array.from(map.values());
  };

  try {
    if (!requestedDateKey) {
      const snapshot = await adminDb.collection('transactions')
        .where('userId', '==', userId)
        .orderBy('createdAt', 'desc')
        .limit(limit)
        .get();
      docs = compactDocs(snapshot);
      if (docs.length === 0) {
        console.warn('[get_recent_transactions] createdAt query returned 0 docs; falling back to bounded user scan', { userIdHash: stableDocId(userId), limit });
        const fallback = await adminDb.collection('transactions').where('userId', '==', userId).limit(boundedLimit).get();
        docs = compactDocs(fallback);
        source = 'bounded_user_query_after_empty_createdAt';
      }
    } else {
      const targetedDocs: any[] = [];
      const dateParts = requestedDateKey.match(/^(\d{4})-(\d{2})-(\d{2})$/);
      const startUtcIso = dateParts
        ? new Date(Date.UTC(Number(dateParts[1]), Number(dateParts[2]) - 1, Number(dateParts[3])) - 3 * 60 * 60 * 1000).toISOString()
        : `${requestedDateKey}T00:00:00.000Z`;
      const endUtcIso = dateParts
        ? new Date(Date.UTC(Number(dateParts[1]), Number(dateParts[2]) - 1, Number(dateParts[3]) + 1) - 3 * 60 * 60 * 1000).toISOString()
        : `${requestedDateKey}T23:59:59.999Z`;
      const nextDateKey = dateParts
        ? new Date(Date.UTC(Number(dateParts[1]), Number(dateParts[2]) - 1, Number(dateParts[3]) + 1)).toISOString().slice(0, 10)
        : requestedDateKey;
      try {
        const createdSnap = await adminDb.collection('transactions')
          .where('userId', '==', userId)
          .where('createdAt', '>=', startUtcIso)
          .where('createdAt', '<', endUtcIso)
          .limit(boundedLimit)
          .get();
        targetedDocs.push(...compactDocs(createdSnap));
      } catch (createdErr: any) {
        console.warn('[get_recent_transactions] createdAt day-range query failed; continuing with date/fallback', { message: createdErr?.message || String(createdErr), requestedDateKey });
      }
      try {
        const dateSnap = await adminDb.collection('transactions')
          .where('userId', '==', userId)
          .where('date', '>=', requestedDateKey)
          .where('date', '<', nextDateKey)
          .limit(boundedLimit)
          .get();
        targetedDocs.push(...compactDocs(dateSnap));
      } catch (dateErr: any) {
        console.warn('[get_recent_transactions] date day-range query failed; continuing with fallback', { message: dateErr?.message || String(dateErr), requestedDateKey });
      }
      const fallback = await adminDb.collection('transactions').where('userId', '==', userId).limit(boundedLimit).get();
      docs = targetedDocs.concat(compactDocs(fallback));
      source = targetedDocs.length > 0 ? 'targeted_createdAt_or_date_day_range_then_fallback' : 'bounded_user_query_filtered_by_date_or_createdAt';
    }
  } catch (primaryErr: any) {
    console.warn('[get_recent_transactions] primary query failed; falling back to bounded user query', { message: primaryErr?.message || String(primaryErr), requestedDateKey });
    source = 'bounded_user_query_sorted_in_memory';
    const fallback = await adminDb.collection('transactions')
      .where('userId', '==', userId)
      .limit(boundedLimit)
      .get();
    docs = compactDocs(fallback);
  }

  docs = sortByRecency(mergeUnique(docs).filter(matchesRequestedScope)).slice(0, limit);

  const transactions = docs.map((t: any) => ({
    id: t.id,
    amount: parsePositiveFinancialAmount(t.amount),
    type: t.type || '',
    account: t.account || t.paymentMethod || '',
    date: String(t.date || t.createdAt || '').slice(0, 10),
    createdAt: t.createdAt || '',
    category: t.category || '',
    subcategory: t.subcategory || '',
    merchant: t.merchant || t.creditor || '',
    purchaseItem: t.purchaseItem || '',
    beneficiary: t.beneficiary || '',
    notes: t.notes || '',
    transactionType: t.transactionType || '',
  }));

  const lines = transactions.map((t: any, idx: number) => {
    const kind = t.type === 'income' ? 'دخل' : t.type === 'transfer' ? 'تحويل' : t.transactionType === 'DEBT_PAYMENT' ? 'سداد دين' : 'مصروف';
    const account = t.account === 'palPay' ? 'PalPay' : t.account === 'cash' ? 'كاش' : t.account === 'debt' ? 'دين' : t.account || 'غير محدد';
    const what = t.purchaseItem || t.subcategory || t.category || t.notes || 'عملية مالية';
    const merchant = t.merchant ? ` - ${t.merchant}` : '';
    return `${idx + 1}) ${t.date || 'بدون تاريخ'}: ${kind} ${t.amount} ₪ (${account}) - ${what}${merchant}`;
  });

  const scopeText = requestedDateKey ? ` بتاريخ/تسجيل ${requestedDateKey}` : '';
  return {
    success: true,
    transactions,
    count: transactions.length,
    source,
    requestedDateKey: requestedDateKey || undefined,
    typeFilter: typeFilter || undefined,
    message: transactions.length
      ? `آخر ${transactions.length} عمليات مالية${scopeText}:\n${lines.join('\n')}`
      : `لا توجد عمليات مالية${scopeText} مطابقة حتى الآن.`,
  };
}

function auditLedgerFingerprint(t: any): string {
  const amount = Math.round(parsePositiveFinancialAmount(t.amount) * 100) / 100;
  const purpose = normalizeArabicText(`${t.purchaseItem || ''} ${t.beneficiary || ''} ${t.notes || ''} ${t.category || ''} ${t.subcategory || ''}`)
    .replace(/\d+(\.\d+)?/g, ' ')
    .replace(/\s+/g, ' ')
    .trim() || 'unspecified';
  return [t.type || '', t.account || '', amount, normalizeArabicText(t.merchant || t.creditor || ''), purpose].join('|');
}

export async function auditFinancialDuplicates(args: any, userId: string, token: string) {
  const adminDb = getDb(token);
  const txLimit = Math.max(1, Math.min(1000, Number(args?.limit) || 500));
  const notifLimit = Math.max(1, Math.min(500, Number(args?.notificationLimit) || 200));
  if (args?.full === true && !args?.allowFullLedgerAudit) {
    return { success: false, needsConfirmation: true, reason: 'FULL_LEDGER_AUDIT_REQUIRES_CONFIRMATION', message: 'تدقيق كل التاريخ يحتاج قراءة واسعة. أكد صراحة allowFullLedgerAudit أو استخدم limit/فترة محددة.' };
  }
  let txQuery: any = adminDb.collection('transactions').where('userId', '==', userId);
  if (args?.startDate) txQuery = txQuery.where('date', '>=', new Date(`${String(args.startDate).slice(0, 10)}T00:00:00.000Z`).toISOString());
  if (args?.endDate) {
    const end = new Date(`${String(args.endDate).slice(0, 10)}T00:00:00.000Z`);
    end.setUTCDate(end.getUTCDate() + 1);
    txQuery = txQuery.where('date', '<', end.toISOString());
  }
  if (args?.full !== true) txQuery = txQuery.orderBy('createdAt', 'desc').limit(txLimit);
  const txSnap = await txQuery.get();
  const transactions = txSnap.docs.map((d: any) => ({ id: d.id, ...d.data() }));
  const notifSnap = await adminDb.collection('users').doc(userId).collection('notifications')
    .orderBy('createdAt', 'desc')
    .limit(notifLimit)
    .get();
  const notifications = notifSnap.docs.map((d: any) => ({ id: d.id, ...d.data() }));

  const group = (items: any[], keyFn: (x: any) => string) => {
    const m = new Map<string, any[]>();
    for (const item of items) {
      const key = keyFn(item);
      if (!key) continue;
      const arr = m.get(key) || [];
      arr.push(item);
      m.set(key, arr);
    }
    return Array.from(m.entries()).filter(([, arr]) => arr.length > 1).map(([key, arr]) => ({ key, count: arr.length, items: arr }));
  };

  const duplicateOperationIds = group(transactions.filter((t: any) => t.operationId), (t: any) => String(t.operationId));
  const duplicateLedgerFingerprints = group(transactions, auditLedgerFingerprint);
  const orphanSuccessNotifications = notifications.filter((n: any) => n.type === 'success' && /تم تسجيل|تم تحويل|تم سداد/.test(String(n.message || '')) && !n.transactionId);
  const notificationsByTransaction = group(notifications.filter((n: any) => n.transactionId), (n: any) => String(n.transactionId));

  return {
    success: true,
    counts: { transactions: transactions.length, notifications: notifications.length },
    duplicateOperationIds: duplicateOperationIds.map(g => ({ key: g.key, count: g.count, transactionIds: g.items.map((t: any) => t.id), amounts: g.items.map((t: any) => t.amount) })),
    duplicateLedgerFingerprints: duplicateLedgerFingerprints.map(g => ({ key: g.key, count: g.count, transactionIds: g.items.map((t: any) => t.id), sample: g.items.map((t: any) => ({ id: t.id, amount: t.amount, account: t.account, merchant: t.merchant, purchaseItem: t.purchaseItem, beneficiary: t.beneficiary, category: t.category, subcategory: t.subcategory, createdAt: t.createdAt })) })),
    successNotificationsWithoutTransactionId: orphanSuccessNotifications.map((n: any) => ({ id: n.id, message: n.message, createdAt: n.createdAt })),
    multipleNotificationsForSameTransaction: notificationsByTransaction.map(g => ({ transactionId: g.key, count: g.count, notificationIds: g.items.map((n: any) => n.id), messages: g.items.map((n: any) => n.message) })),
    partial: Boolean((txSnap as any).partial || (notifSnap as any).partial || (args?.full !== true && transactions.length >= txLimit) || notifications.length >= notifLimit),
    readEfficiency: { transactionDocsRead: transactions.length, transactionLimit: args?.full === true ? null : txLimit, notificationDocsRead: notifications.length, notificationLimit: notifLimit }
  };
}

function auditAsDate(value: any): Date | null {
  if (!value) return null;
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value : null;
  if (typeof value?.toDate === 'function') {
    const d = value.toDate();
    return Number.isFinite(d.getTime()) ? d : null;
  }
  if (typeof value?.toMillis === 'function') {
    const d = new Date(value.toMillis());
    return Number.isFinite(d.getTime()) ? d : null;
  }
  if (typeof value?.seconds === 'number') {
    const d = new Date(value.seconds * 1000);
    return Number.isFinite(d.getTime()) ? d : null;
  }
  const parsed = new Date(String(value));
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

function auditDateKey(value: any): string {
  const parsed = auditAsDate(value);
  if (parsed) return parsed.toISOString().slice(0, 10);
  const raw = String(value || '').trim();
  const iso = raw.match(/(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})/);
  if (iso) return `${iso[1]}-${String(Number(iso[2])).padStart(2, '0')}-${String(Number(iso[3])).padStart(2, '0')}`;
  return raw.slice(0, 10);
}

function auditSeverityRank(value: any): number {
  const s = String(value || 'info').toLowerCase();
  return s === 'critical' ? 4 : s === 'warning' ? 3 : s === 'info' ? 2 : 1;
}

function addAuditFinding(findings: any[], input: any) {
  const severity = String(input.severity || 'info').toLowerCase();
  const category = String(input.category || 'general');
  const title = String(input.title || 'ملاحظة تدقيق مالي');
  const fingerprint = stableDocId(`${category}:${title}:${JSON.stringify(input.relatedIds || input.evidence || input.message || '')}`);
  findings.push({
    id: input.id || fingerprint,
    severity,
    category,
    title,
    message: input.message || title,
    evidence: input.evidence || {},
    relatedIds: input.relatedIds || [],
    recommendedActions: input.recommendedActions || [],
    createdAt: new Date().toISOString(),
  });
}

function auditGroup(items: any[], keyFn: (item: any) => string) {
  const map = new Map<string, any[]>();
  for (const item of items || []) {
    const key = keyFn(item);
    if (!key) continue;
    const arr = map.get(key) || [];
    arr.push(item);
    map.set(key, arr);
  }
  return Array.from(map.entries()).filter(([, arr]) => arr.length > 1).map(([key, arr]) => ({ key, items: arr, count: arr.length }));
}

function isAuditBlank(value: any): boolean {
  const raw = normalizeArabicText(String(value || '')).trim().toLowerCase();
  return !raw || ['غير محدد', 'غير مصنف', 'اخرى', 'أخرى', 'other', 'unknown', 'undefined', 'null', '-'].includes(raw);
}

export async function runFinancialAudit(args: any, userId: string, token: string) {
  const adminDb = getDb(token);
  const now = args?.now ? new Date(String(args.now)) : new Date();
  const safeNow = Number.isFinite(now.getTime()) ? now : new Date();
  const limit = Math.max(50, Math.min(1000, Number(args?.limit) || 500));
  const notificationLimit = Math.max(50, Math.min(500, Number(args?.notificationLimit) || 200));
  const scope = String(args?.scope || args?.period || 'salary_cycle').toLowerCase();
  const wantsFullAudit = parseBooleanLike(args?.full) || scope === 'all';
  const allowFullLedgerAudit = parseBooleanLike(args?.allowFullLedgerAudit);
  if (wantsFullAudit && !allowFullLedgerAudit) {
    return { success: false, needsConfirmation: true, reason: 'FULL_FINANCIAL_AUDIT_REQUIRES_CONFIRMATION', message: 'المدقق المالي الشامل لكل التاريخ يحتاج قراءة واسعة. حدد دورة/فترة أو أكد allowFullLedgerAudit صراحة.' };
  }

  const findings: any[] = [];
  let transactions: any[] = [];
  let transactionReadPartial = false;
  let transactionReadSource = 'salary_cycle';
  let queryStats: any[] = [];
  let period: any = null;

  if (scope === 'salary_cycle' || scope === 'current_salary_cycle') {
    period = resolveSalaryCycleFromArgs(args || {}, safeNow);
    const read = await readTransactionsForSalaryCycle(period, userId, token, limit);
    transactions = read.transactions || [];
    transactionReadPartial = Boolean(read.partial || read.limitReached || read.boundedFallback);
    queryStats = read.queryStats || [];
  } else {
    transactionReadSource = 'createdAt_desc_bounded';
    try {
      const snap = await adminDb.collection('transactions')
        .where('userId', '==', userId)
        .orderBy('createdAt', 'desc')
        .limit(limit)
        .get();
      transactions = snap.docs.map((d: any) => ({ id: d.id, ...d.data() }));
      transactionReadPartial = Boolean((snap as any).partial || transactions.length >= limit);
    } catch (err: any) {
      transactionReadSource = 'userId_bounded_fallback';
      const fallback = await adminDb.collection('transactions').where('userId', '==', userId).limit(limit).get();
      transactions = fallback.docs.map((d: any) => ({ id: d.id, ...d.data() }));
      transactionReadPartial = true;
      queryStats.push({ label: 'createdAt_desc_failed', error: err?.message || String(err) });
    }
  }

  const [budgets, commitmentsSnap, savingsSnap, notificationsSnap, safeSpending] = await Promise.all([
    getUserBudgets(userId, adminDb).catch(() => ({})),
    adminDb.collection('commitments').where('userId', '==', userId).orderBy('dueDate', 'asc').limit(150).get().catch(() => ({ docs: [], partial: true })),
    adminDb.collection('users').doc(userId).collection('savingsGoals').limit(100).get().catch(() => ({ docs: [], partial: true })),
    adminDb.collection('users').doc(userId).collection('notifications').orderBy('createdAt', 'desc').limit(notificationLimit).get().catch(() => ({ docs: [], partial: true })),
    getSafeSpendingLimit({ period: 'salary_cycle' }, userId, token).catch((e: any) => ({ success: false, error: e?.message || String(e) })),
  ]);

  const commitments = ((commitmentsSnap as any).docs || []).map((d: any) => ({ id: d.id, ...d.data() }));
  const savingsGoals = ((savingsSnap as any).docs || []).map((d: any) => ({ id: d.id, ...d.data() }));
  const notifications = ((notificationsSnap as any).docs || []).map((d: any) => ({ id: d.id, ...d.data() }));
  const expenses = transactions.filter((t: any) => String(t.type || '').toLowerCase() === 'expense');
  const incomes = transactions.filter((t: any) => String(t.type || '').toLowerCase() === 'income');

  const duplicateOperationIds = auditGroup(transactions.filter((t: any) => t.operationId), (t: any) => String(t.operationId));
  if (duplicateOperationIds.length) {
    addAuditFinding(findings, {
      severity: 'critical',
      category: 'duplicates',
      title: 'عمليات مكررة بنفس معرف التشغيل',
      message: `وجدت ${duplicateOperationIds.length} مجموعة عمليات تحمل نفس operationId. هذا قد يعني تسجيل مزدوج ويحتاج مراجعة قبل الاعتماد على الرصيد.`,
      evidence: { groups: duplicateOperationIds.slice(0, 5).map((g: any) => ({ key: g.key, count: g.count, ids: g.items.map((t: any) => t.id) })) },
      relatedIds: duplicateOperationIds.flatMap((g: any) => g.items.map((t: any) => t.id)).slice(0, 20),
      recommendedActions: ['راجع المجموعات المكررة', 'احذف أو ادمج النسخ الزائدة فقط بعد التأكد من العملية الأصلية'],
    });
  }

  const duplicateFingerprints = auditGroup(transactions, auditLedgerFingerprint)
    .filter((g: any) => !/^transfer\|/.test(g.key));
  if (duplicateFingerprints.length) {
    addAuditFinding(findings, {
      severity: duplicateFingerprints.some((g: any) => g.count >= 3) ? 'critical' : 'warning',
      category: 'duplicates',
      title: 'عمليات متشابهة قد تكون مكررة',
      message: `وجدت ${duplicateFingerprints.length} مجموعة عمليات متطابقة تقريباً في المبلغ والحساب والغرض.`,
      evidence: { groups: duplicateFingerprints.slice(0, 5).map((g: any) => ({ key: g.key, count: g.count, ids: g.items.map((t: any) => t.id), amount: g.items[0]?.amount })) },
      relatedIds: duplicateFingerprints.flatMap((g: any) => g.items.map((t: any) => t.id)).slice(0, 20),
      recommendedActions: ['افتح العمليات المتشابهة', 'تأكد هل هي تكرار أم مشتريات منفصلة بنفس القيمة'],
    });
  }

  const salaryLikeIncome = incomes.filter((t: any) => {
    const text = normalizeArabicText(`${t.category || ''} ${t.subcategory || ''} ${t.notes || ''} ${t.merchant || ''} ${t.beneficiary || ''}`).toLowerCase();
    return parsePositiveFinancialAmount(t.amount) >= 500 && /راتب|salary|معاش/.test(text);
  });
  const duplicateSalary = auditGroup(salaryLikeIncome, (t: any) => `${auditDateKey(t.date || t.createdAt).slice(0, 7)}:${roundFinancial(t.amount)}:${t.account || ''}`);
  if (duplicateSalary.length) {
    addAuditFinding(findings, {
      severity: 'critical',
      category: 'income_integrity',
      title: 'اشتباه راتب مكرر',
      message: 'يوجد دخل شبيه بالراتب مسجل أكثر من مرة بنفس الشهر والمبلغ والحساب.',
      evidence: { groups: duplicateSalary.map((g: any) => ({ key: g.key, count: g.count, ids: g.items.map((t: any) => t.id) })) },
      relatedIds: duplicateSalary.flatMap((g: any) => g.items.map((t: any) => t.id)).slice(0, 20),
      recommendedActions: ['راجع قيود الراتب قبل حساب الحد الآمن', 'احذف النسخة الزائدة إن كانت مكررة فعلاً'],
    });
  }

  const debtWithoutCreditor = expenses.filter((t: any) => String(t.account || '').toLowerCase() === 'debt' && isAuditBlank(t.creditor || t.merchant));
  if (debtWithoutCreditor.length) {
    addAuditFinding(findings, {
      severity: 'critical',
      category: 'debt_integrity',
      title: 'ديون بلا دائن واضح',
      message: `${debtWithoutCreditor.length} عملية دين لا تحتوي دائن/تاجر واضح، وهذا يضعف تتبع الديون والسداد.`,
      evidence: { count: debtWithoutCreditor.length, sample: debtWithoutCreditor.slice(0, 5).map((t: any) => ({ id: t.id, amount: t.amount, date: t.date })) },
      relatedIds: debtWithoutCreditor.map((t: any) => t.id).slice(0, 20),
      recommendedActions: ['أضف اسم الدائن لكل عملية دين', 'راجع كشف الدائنين بعد التصحيح'],
    });
  }

  const missingCategory = expenses.filter((t: any) => isAuditBlank(t.category));
  const missingPurpose = expenses.filter((t: any) => parsePositiveFinancialAmount(t.amount) >= 50 && isAuditBlank(t.purchaseItem) && isAuditBlank(t.beneficiary) && isAuditBlank(t.notes) && isAuditBlank(t.subcategory) && isAuditBlank(t.merchant));
  if (missingCategory.length || missingPurpose.length) {
    addAuditFinding(findings, {
      severity: missingCategory.length > 5 || missingPurpose.length > 5 ? 'warning' : 'info',
      category: 'data_quality',
      title: 'عمليات ناقصة التصنيف أو الغرض',
      message: `يوجد ${missingCategory.length} مصروف بلا بند واضح و${missingPurpose.length} مصروف مهم بلا وصف كافٍ.`,
      evidence: { missingCategory: missingCategory.slice(0, 5).map((t: any) => t.id), missingPurpose: missingPurpose.slice(0, 5).map((t: any) => t.id) },
      relatedIds: [...missingCategory, ...missingPurpose].map((t: any) => t.id).slice(0, 20),
      recommendedActions: ['صنّف العمليات الناقصة', 'أضف وصفاً للمصاريف الأكبر من 50 ₪'],
    });
  }

  const nowKey = safeNow.toISOString().slice(0, 10);
  const pendingCommitments = commitments.filter((c: any) => !['paid', 'cancelled'].includes(String(c.status || 'pending').toLowerCase()));
  const overdueCommitments = pendingCommitments.filter((c: any) => {
    const dueKey = auditDateKey(c.dueDate);
    return /^\d{4}-\d{2}-\d{2}$/.test(dueKey) && dueKey < nowKey;
  });
  const dueSoonCommitments = pendingCommitments.filter((c: any) => {
    const due = auditAsDate(c.dueDate);
    if (!due) return false;
    const days = Math.ceil((due.getTime() - safeNow.getTime()) / 86400000);
    return days >= 0 && days <= 7;
  });
  if (overdueCommitments.length) {
    addAuditFinding(findings, {
      severity: 'critical',
      category: 'commitments',
      title: 'التزامات متأخرة غير مغلقة',
      message: `${overdueCommitments.length} التزام موعده فات وما زال pending.`,
      evidence: { sample: overdueCommitments.slice(0, 5).map((c: any) => ({ id: c.id, title: c.title, amount: c.amount, dueDate: c.dueDate })) },
      relatedIds: overdueCommitments.map((c: any) => c.id).slice(0, 20),
      recommendedActions: ['علّم الالتزام كمدفوع إذا تم سداده', 'أو أجّل موعده إذا بقي مستحقاً'],
    });
  } else if (dueSoonCommitments.length) {
    addAuditFinding(findings, {
      severity: 'warning',
      category: 'commitments',
      title: 'التزامات قريبة خلال 7 أيام',
      message: `يوجد ${dueSoonCommitments.length} التزام قريب يحتاج تجهيز سيولة.`,
      evidence: { sample: dueSoonCommitments.slice(0, 5).map((c: any) => ({ id: c.id, title: c.title, amount: c.amount, dueDate: c.dueDate })) },
      relatedIds: dueSoonCommitments.map((c: any) => c.id).slice(0, 20),
      recommendedActions: ['احجز مبلغ الالتزامات قبل أي صرف كمالي', 'استخدم حد الصرف الآمن قبل الشراء'],
    });
  }

  const activeBudgets = budgets || {};
  const spentByCategory = new Map<string, number>();
  for (const t of expenses) {
    const category = String(t.category || 'غير مصنف');
    spentByCategory.set(category, roundFinancial((spentByCategory.get(category) || 0) + parsePositiveFinancialAmount(t.amount)));
  }
  const budgetBreaches: any[] = [];
  for (const [category, spent] of spentByCategory.entries()) {
    const limitValue = parsePositiveFinancialAmount((activeBudgets as any)[category]);
    if (limitValue > 0 && spent >= limitValue * 0.8) {
      budgetBreaches.push({ category, spent, limit: limitValue, ratio: roundFinancial(spent / limitValue) });
    }
  }
  if (budgetBreaches.length) {
    addAuditFinding(findings, {
      severity: budgetBreaches.some((b: any) => b.ratio >= 1) ? 'critical' : 'warning',
      category: 'budget_control',
      title: 'بنود ميزانية عند الحد أو فوقه',
      message: `${budgetBreaches.length} بند ميزانية وصل 80% أو تجاوز السقف.`,
      evidence: { breaches: budgetBreaches.sort((a: any, b: any) => b.ratio - a.ratio).slice(0, 8) },
      recommendedActions: ['أوقف أو خفف الصرف في البنود المتجاوزة', 'راجع الحد الآمن قبل أي عملية جديدة'],
    });
  }

  const activeGoals = savingsGoals.filter((g: any) => !['completed', 'cancelled', 'archived'].includes(String(g.status || 'active').toLowerCase()));
  const riskyGoals = activeGoals.map((goal: any) => buildSavingsGoalPlan({ goal, now: safeNow }))
    .filter((plan: any) => ['critical', 'warning'].includes(String(plan.alertLevel || '')));
  if (riskyGoals.length) {
    addAuditFinding(findings, {
      severity: riskyGoals.some((g: any) => g.alertLevel === 'critical') ? 'critical' : 'warning',
      category: 'savings_goals',
      title: 'أهداف ادخار خارج المسار',
      message: `${riskyGoals.length} هدف ادخار يحتاج متابعة حتى لا يتأخر.`,
      evidence: { goals: riskyGoals.slice(0, 5).map((g: any) => ({ id: g.id, name: g.name, remainingAmount: g.remainingAmount, monthlyRequired: g.monthlyRequired, alertLevel: g.alertLevel })) },
      relatedIds: riskyGoals.map((g: any) => g.id).slice(0, 20),
      recommendedActions: ['حوّل مساهمة صغيرة للأهداف عالية الأولوية بعد الراتب', 'خفف الصرف الكمالي حتى يرجع الهدف للمسار'],
    });
  }

  const recurringDetection = await detectRecurringCommitments({ limit: Math.min(limit, 500), candidateLimit: 5, minOccurrences: 2 }, userId, token).catch((e: any) => ({ success: false, candidates: [], error: e?.message || String(e) }));
  const recurringCandidates = Array.isArray((recurringDetection as any).candidates) ? (recurringDetection as any).candidates : [];
  if (recurringCandidates.length) {
    addAuditFinding(findings, {
      severity: recurringCandidates.some((c: any) => Number(c.confidence || 0) >= 0.85) ? 'warning' : 'info',
      category: 'recurring_commitments',
      title: 'مصاريف متكررة غير مجدولة',
      message: `وجدت ${recurringCandidates.length} مصروف متكرر محتمل غير موجود كالتزام. تحويله لالتزام يحسن توقعات نهاية الشهر.`,
      evidence: { candidates: recurringCandidates.slice(0, 5).map((c: any) => ({ detectionKey: c.detectionKey, title: c.title, amount: c.amount, frequency: c.frequency, nextDueDate: c.nextDueDate, confidence: c.confidence })) },
      relatedIds: recurringCandidates.flatMap((c: any) => c.sourceTransactionIds || []).slice(0, 20),
      recommendedActions: ['راجع المرشحات المتكررة', 'حوّل الاشتراكات والفواتير المؤكدة إلى التزامات متكررة'],
    });
  }

  const habitAnalysis = await analyzeFinancialHabits({ period: 'last_30_days', limit: Math.min(limit, 800), insightLimit: 5 }, userId, token).catch((e: any) => ({ success: false, insights: [], error: e?.message || String(e) }));
  const habitInsights = Array.isArray((habitAnalysis as any).insights) ? (habitAnalysis as any).insights.filter((i: any) => i.severity === 'warning') : [];
  if (habitInsights.length) {
    addAuditFinding(findings, {
      severity: habitInsights.length >= 3 ? 'critical' : 'warning',
      category: 'habit_patterns',
      title: 'أنماط صرف تحتاج ضبط',
      message: `وجدت ${habitInsights.length} نمط صرف تحذيري مثل ارتفاع بند أو تاجر أو يوم صرف.`,
      evidence: { insights: habitInsights.slice(0, 5).map((i: any) => ({ type: i.type, title: i.title, message: i.message, evidence: i.evidence })) },
      relatedIds: habitInsights.flatMap((i: any) => i.evidence?.sampleIds || i.evidence?.smallPurchases?.sampleIds || []).slice(0, 20),
      recommendedActions: ['ضع سقفاً مؤقتاً للبند المرتفع', 'راجع العمليات الصغيرة والمتكررة قبل نهاية الأسبوع'],
    });
  }

  const monthEndForecast = await forecastMonthEndFinancialPosition({ horizon: 'salary_cycle', transactionLimit: Math.min(limit, 800) }, userId, token).catch((e: any) => ({ success: false, status: 'unknown', error: e?.message || String(e) }));
  if (['month_end_deficit', 'month_end_pressure'].includes(String((monthEndForecast as any).status || ''))) {
    addAuditFinding(findings, {
      severity: (monthEndForecast as any).status === 'month_end_deficit' ? 'critical' : 'warning',
      category: 'month_end_forecast',
      title: 'توقع نهاية الشهر يحتاج انتباه',
      message: (monthEndForecast as any).message || 'توقع نهاية الشهر يشير إلى ضغط أو عجز محتمل.',
      evidence: { forecast: (monthEndForecast as any).forecast, correctionPlan: (monthEndForecast as any).correctionPlan, confidence: (monthEndForecast as any).confidence },
      relatedIds: [],
      recommendedActions: ((monthEndForecast as any).correctionPlan?.actions || []).slice(0, 5).map((a: any) => a.message || a.title).filter(Boolean),
    });
  }

  const openCriticalAlerts = notifications.filter((n: any) => Boolean(n.advisorAlert) && normalizeAdvisorAlertStatus(n.advisorStatus) === 'open' && String(n.severity || '').toLowerCase() === 'critical');
  if (openCriticalAlerts.length) {
    addAuditFinding(findings, {
      severity: 'critical',
      category: 'advisor_alerts',
      title: 'تنبيهات حرجة مفتوحة',
      message: `يوجد ${openCriticalAlerts.length} تنبيه مالي حرج لم يتم التعامل معه.`,
      evidence: { sample: openCriticalAlerts.slice(0, 5).map((n: any) => ({ id: n.id, message: n.message, category: n.category, createdAt: n.createdAt })) },
      relatedIds: openCriticalAlerts.map((n: any) => n.id).slice(0, 20),
      recommendedActions: ['افتح مركز التنبيهات', 'حل أو أجّل أو تجاهل التنبيهات بقرار واعٍ'],
    });
  }

  if ((safeSpending as any)?.success !== false && ['critical', 'danger', 'warning'].includes(String((safeSpending as any).decision || ''))) {
    addAuditFinding(findings, {
      severity: ['critical', 'danger'].includes(String((safeSpending as any).decision)) ? 'critical' : 'warning',
      category: 'cash_safety',
      title: 'حد الصرف الآمن منخفض',
      message: (safeSpending as any).message || 'الحد الآمن للصرف يحتاج انتباه.',
      evidence: { safeSpending: (safeSpending as any).safeSpending, breakdown: (safeSpending as any).breakdown },
      recommendedActions: ['لا تسجل مصاريف كمالية قبل مراجعة الالتزامات', 'ارفع السيولة أو خفف الصرف اليومي'],
    });
  }

  const futureTransactions = transactions.filter((t: any) => auditDateKey(t.date || t.createdAt) > new Date(safeNow.getTime() + 86400000).toISOString().slice(0, 10));
  const invalidAmounts = transactions.filter((t: any) => parsePositiveFinancialAmount(t.amount) <= 0);
  if (futureTransactions.length || invalidAmounts.length) {
    addAuditFinding(findings, {
      severity: 'warning',
      category: 'ledger_integrity',
      title: 'تواريخ أو مبالغ تحتاج مراجعة',
      message: `وجدت ${futureTransactions.length} عملية بتاريخ مستقبلي و${invalidAmounts.length} عملية بمبلغ غير صالح.`,
      evidence: { futureTransactions: futureTransactions.slice(0, 5).map((t: any) => t.id), invalidAmounts: invalidAmounts.slice(0, 5).map((t: any) => t.id) },
      relatedIds: [...futureTransactions, ...invalidAmounts].map((t: any) => t.id).slice(0, 20),
      recommendedActions: ['صحح التاريخ أو المبلغ قبل الاعتماد على التقارير'],
    });
  }

  findings.sort((a: any, b: any) => auditSeverityRank(b.severity) - auditSeverityRank(a.severity) || String(a.title).localeCompare(String(b.title)));
  const counts = findings.reduce((acc: any, f: any) => {
    acc.total += 1;
    acc.bySeverity[f.severity] = (acc.bySeverity[f.severity] || 0) + 1;
    acc.byCategory[f.category] = (acc.byCategory[f.category] || 0) + 1;
    return acc;
  }, { total: 0, bySeverity: {}, byCategory: {} });
  const penalty = findings.reduce((sum: number, f: any) => sum + (f.severity === 'critical' ? 20 : f.severity === 'warning' ? 8 : 2), 0);
  const score = Math.max(0, Math.min(100, 100 - penalty));
  const status = counts.bySeverity.critical ? 'critical' : counts.bySeverity.warning ? 'warning' : 'clean';
  const message = status === 'critical'
    ? `المدقق وجد ${counts.bySeverity.critical} مشكلة حرجة تحتاج علاج قبل الاعتماد الكامل على الرصيد.`
    : status === 'warning'
      ? `المدقق وجد ${counts.bySeverity.warning} ملاحظة تحتاج تحسين، لكن لا توجد مشكلة حرجة واضحة.`
      : 'المدقق لم يجد مشاكل مالية مهمة ضمن نطاق القراءة الحالي.';

  let savedAuditId: string | null = null;
  if (args?.save === true) {
    const auditId = stableDocId(`audit:${userId}:${scope}:${period?.cycleId || ''}:${safeNow.toISOString().slice(0, 10)}`);
    savedAuditId = auditId;
    await adminDb.collection('users').doc(userId).collection('advisorAudits').doc(auditId).set({
      userId,
      createdAt: new Date().toISOString(),
      scope,
      period,
      score,
      status,
      counts,
      message,
      findings: findings.slice(0, 50),
      partial: Boolean(transactionReadPartial || (commitmentsSnap as any).partial || (savingsSnap as any).partial || (notificationsSnap as any).partial),
    }, { merge: true });
  }

  if (args?.persistAlerts === true) {
    for (const finding of findings.filter((f: any) => ['critical', 'warning'].includes(f.severity)).slice(0, 10)) {
      await addNotification(userId, `🧾 المدقق المالي: ${finding.title} — ${finding.message}`, 'warning', adminDb, {
        idempotencyKey: `advisor-audit:${period?.cycleId || scope}:${finding.id}`,
        advisorAlert: true,
        advisorStatus: 'open',
        severity: finding.severity,
        priority: finding.severity === 'critical' ? 'high' : 'medium',
        category: `audit_${finding.category}`,
        source: 'runFinancialAudit',
        metadata: { auditId: savedAuditId, finding },
        actions: [
          { id: 'review_finding', label: 'راجع الملاحظة', type: 'review' },
          { id: 'resolve', label: 'تم التعامل', type: 'resolve' },
          { id: 'snooze', label: 'ذكرني لاحقاً', type: 'snooze' },
        ],
      });
    }
  }

  return {
    success: true,
    score,
    status,
    message,
    counts,
    findings: findings.slice(0, Math.max(1, Math.min(50, Number(args?.findingLimit) || 20))),
    savedAuditId,
    scope: { type: scope, period, transactionReadSource, transactionLimit: limit, notificationLimit },
    summary: {
      transactions: transactions.length,
      expenses: expenses.length,
      incomes: incomes.length,
      commitments: commitments.length,
      savingsGoals: activeGoals.length,
      openCriticalAlerts: openCriticalAlerts.length,
    },
    partial: Boolean(transactionReadPartial || (commitmentsSnap as any).partial || (savingsSnap as any).partial || (notificationsSnap as any).partial),
    readEfficiency: {
      transactionDocsRead: transactions.length,
      transactionLimit: limit,
      transactionReadSource,
      queryStats,
      commitmentDocsRead: commitments.length,
      savingsGoalDocsRead: savingsGoals.length,
      notificationDocsRead: notifications.length,
      notificationLimit,
    },
  };
}

export async function updateTransaction(args: any, userId: string, token: string) {
  const adminDb = getDb(token);
  console.log("TOOL CALL: updateTransaction", args);
  const txRef = adminDb.collection('transactions').doc(args.id);
  const doc = await txRef.get();
  if (!doc.exists || doc.data()?.userId !== userId) return { error: "Transaction not found" };
  const existing = doc.data() as any;

  // V6 (CF-4): re-validate financial invariants on update.
  // Build the projected post-update document and run addTransaction-style guards.

  const updates: any = {};
  if (args.amount !== undefined) {
    updates.amount = parsePositiveFinancialAmount(args.amount);
    if (updates.amount <= 0) {
      return { success: false, needsClarification: true, reason: 'INVALID_AMOUNT', message: 'المبلغ الجديد غير صالح (يجب أن يكون رقماً محدداً موجباً).' };
    }
  }
  if (args.type) updates.type = String(args.type).toLowerCase();
  if (args.account) updates.account = normalizeAccount(args.account);
  if (args.fromAccount) updates.fromAccount = normalizeAccount(args.fromAccount);
  if (args.toAccount) updates.toAccount = normalizeAccount(args.toAccount);
  if (args.category !== undefined) updates.category = String(args.category);
  if (args.subcategory !== undefined) updates.subcategory = String(args.subcategory);
  if (args.merchant !== undefined) updates.merchant = String(args.merchant);
  if (args.notes !== undefined) updates.notes = String(args.notes);
  if (args.necessity !== undefined) updates.necessity = String(args.necessity);
  if (args.date !== undefined) updates.date = String(args.date);
  updates.updatedAt = new Date().toISOString();

  // 3. Compute projected state.
  const projected: any = { ...existing, ...updates };
  // If account changed, recompute derived fields (creditor/creditorKey/transactionType).
  if (updates.account !== undefined || updates.type !== undefined) {
    const t = (projected.type || 'expense').toLowerCase();
    const a = normalizeAccount(projected.account);
    projected.account = a;
    projected.transactionType = (t === 'expense' && a === 'debt')
      ? 'CREDIT_PURCHASE'
      : (t === 'income' ? 'INCOME' : (t === 'transfer' ? (projected.transactionType || 'INTERNAL_TRANSFER') : 'EXPENSE'));
    // If transitioning to a debt-expense, ensure creditor is set.
    if (t === 'expense' && a === 'debt') {
      const cred = String(projected.merchant || projected.creditor || '').trim();
      if (!cred) {
        return { success: false, needsClarification: true, reason: 'MISSING_CREDITOR', message: 'عند تحويل العملية إلى دين، يجب تحديد الدائن.' };
      }
      projected.creditor = cred;
      projected.creditorKey = normalizeCreditorName(cred);
    } else if (updates.account !== undefined) {
      // Moving away from debt — clear creditor fields.
      projected.creditor = '';
      projected.creditorKey = '';
    }
  }

  // 4. Re-derive subcategory/necessity consistency for expenses.
  if ((projected.type || 'expense') === 'expense') {
    if (updates.category !== undefined && !projected.category) {
      return { success: false, needsClarification: true, reason: 'MISSING_CATEGORY', message: 'ما بند العملية الرئيسي؟' };
    }
  }

  // Date/description metadata cannot change account balances. For those edits,
  // avoid the full-ledger preflight and use the atomic ownership-checked write.
  const balanceSensitiveUpdate = updates.amount !== undefined
    || updates.type !== undefined
    || updates.account !== undefined
    || updates.fromAccount !== undefined
    || updates.toAccount !== undefined;
  if (!balanceSensitiveUpdate) {
    const atomicResult = await atomicUpdateTransaction(userId, args.id, updates, {
      riskConfirmed: !!args.riskConfirmed,
      skipBalanceRecalculation: true,
    });
    if ('reason' in atomicResult) {
      return { success: false, reason: atomicResult.reason, message: 'تعذر تعديل العملية بأمان لأنها تغيرت أو لم تعد موجودة.' };
    }
    let vaultRecalculation: any[] = [];
    try {
      vaultRecalculation = await recalculateCyclesForTransactionChange(userId, token, existing, projected, 'transaction_metadata_updated');
    } catch (vaultErr) {
      console.warn('Savings Vault recalculation failed after metadata update:', vaultErr);
    }
    return {
      success: true,
      durability: 'cloud',
      pending: false,
      partial: false,
      vaultRecalculation: vaultRecalculation.map((r: any) => r?.salaryCycle?.cycleId).filter(Boolean),
    };
  }

  // 5. For balance-sensitive edits, do not read the full ledger here.
  // atomicUpdateTransaction applies the replacement delta to the account balance
  // snapshot inside one Firestore transaction and rejects negative cash/PalPay.
  // Budget UX checks below are bounded by the affected month/category only and
  // are advisory; they must never block editing an existing transaction.
  let budgetWarning = '';
  if (projected.type === 'expense' && (updates.amount !== undefined || updates.category !== undefined || updates.date !== undefined)) {
    try {
      const userBudgets = await getUserBudgets(userId, adminDb);
      const projectedDate = new Date(projected.date || new Date().toISOString());
      const safeDate = Number.isNaN(projectedDate.getTime()) ? new Date() : projectedDate;
      const thisMonth = safeDate.toISOString().slice(0, 7);
      const monthStart = `${thisMonth}-01T00:00:00.000Z`;
      const nextMonthDate = new Date(Date.UTC(safeDate.getUTCFullYear(), safeDate.getUTCMonth() + 1, 1));
      const nextMonthStart = `${nextMonthDate.toISOString().slice(0, 10)}T00:00:00.000Z`;
      const categorySnap = await adminDb.collection('transactions')
        .where('userId', '==', userId)
        .where('date', '>=', monthStart)
        .where('date', '<', nextMonthStart)
        .where('category', '==', projected.category)
        .limit(300)
        .get();
      if ((categorySnap as any).partial === true || categorySnap.docs.length >= 300) {
        budgetWarning = 'تعذر تأكيد أثر التعديل على الميزانية من قراءة محدودة/جزئية، لكنني لم أوقف تعديل العملية الموجودة. المنع الحقيقي فقط إذا كان التعديل سيجعل الرصيد سالباً.';
        console.warn('update_transaction advisory budget check was partial; continuing to atomic update', {
          userIdHash: stableDocId(userId),
          transactionId: args.id,
          partial: Boolean((categorySnap as any).partial),
          docs: categorySnap.docs.length,
        });
      } else {
        const existingSameCategory = categorySnap.docs
          .filter((d: any) => d.id !== args.id)
          .map((d: any) => d.data())
          .filter((t: any) => t.type === 'expense');
        const spent = existingSameCategory.reduce((s: number, t: any) => s + parsePositiveFinancialAmount(t.amount), 0) + parsePositiveFinancialAmount(projected.amount);
        const limit = Number(userBudgets?.[projected.category] || DEFAULT_BUDGETS[projected.category] || 0);
        if (limit > 0 && spent >= limit) {
          budgetWarning = `تحذير ميزانية: التعديل يرفع بند [${projected.category}] إلى ${spent} ₪ مقابل سقف ${limit} ₪. تم تنفيذ التعديل لأن تحذير الميزانية لا يمنع تعديل عملية موجودة.`;
        }
      }
    } catch (e) {
      console.error('update_transaction bounded budget check failed:', e);
    }
  }

  // 6. Apply the update with the recomputed derived fields.
  const finalUpdates: any = { ...updates };
  if (updates.account !== undefined || updates.type !== undefined) {
    finalUpdates.transactionType = projected.transactionType;
    finalUpdates.creditor = projected.creditor;
    finalUpdates.creditorKey = projected.creditorKey;
  }

  // Re-run the balance-sensitive invariant and the write in one Firestore transaction.
  // The earlier projection remains useful for clarification/budget UX, but it is not
  // trusted as the final concurrency guard.
  const atomicResult = await atomicUpdateTransaction(userId, args.id, finalUpdates, { riskConfirmed: !!args.riskConfirmed });
  if ('reason' in atomicResult) {
    if (atomicResult.reason === 'NEGATIVE_CASH_RESULT') {
      return { success: false, needsConfirmation: true, reason: atomicResult.reason, message: `هذا التعديل سيجعل رصيد الكاش سالباً (${atomicResult.balances?.cash} ₪). هل تريد المتابعة؟`, financialImpact: { cashAfter: atomicResult.balances?.cash } };
    }
    if (atomicResult.reason === 'NEGATIVE_PALPAY_RESULT') {
      return { success: false, needsConfirmation: true, reason: atomicResult.reason, message: `هذا التعديل سيجعل رصيد PalPay سالباً (${atomicResult.balances?.palPay} ₪). هل تريد المتابعة؟`, financialImpact: { palPayAfter: atomicResult.balances?.palPay } };
    }
    return { success: false, reason: atomicResult.reason, message: 'تعذر تعديل العملية بأمان لأنها تغيرت أو لم تعد موجودة.' };
  }
  let vaultRecalculation: any[] = [];
  try {
    vaultRecalculation = await recalculateCyclesForTransactionChange(userId, token, existing, projected, 'transaction_financial_updated');
  } catch (vaultErr) {
    console.warn('Savings Vault recalculation failed after financial update:', vaultErr);
  }
  return {
    success: true,
    currentBalances: atomicResult.balances,
    durability: 'cloud',
    pending: false,
    partial: false,
    budgetWarning: budgetWarning || undefined,
    message: budgetWarning ? `تم تعديل العملية. ${budgetWarning}` : 'تم تعديل العملية بنجاح.',
    vaultRecalculation: vaultRecalculation.map((r: any) => r?.salaryCycle?.cycleId).filter(Boolean),
  };
}

function formatDateKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function addDaysToDateKey(dateKey: string, days: number): string {
  const parsed = parseDateLike(dateKey);
  if (!parsed) return dateKey;
  const shifted = new Date(Date.UTC(parsed.getUTCFullYear(), parsed.getUTCMonth(), parsed.getUTCDate() + days));
  return formatDateKey(shifted);
}

function parseSmartDeleteDateKey(value: unknown, now: Date = new Date()): string | null {
  const parsed = parseDateLike(value);
  if (parsed) return formatDateKey(parsed);

  const raw = normalizeDigits(value);
  if (!raw) return null;

  const embeddedIso = raw.match(/(?:^|\D)(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})(?=\D|$)/);
  if (embeddedIso) {
    const year = Number(embeddedIso[1]);
    const month = Number(embeddedIso[2]);
    const day = Number(embeddedIso[3]);
    const date = new Date(Date.UTC(year, month - 1, day));
    if (!Number.isNaN(date.getTime()) && date.getUTCFullYear() === year && date.getUTCMonth() + 1 === month && date.getUTCDate() === day) {
      return formatDateKey(date);
    }
  }

  const partial = raw.match(/(?:^|\D)(\d{1,2})[\/\-.](\d{1,2})(?:[\/\-.](\d{2,4}))?(?=\D|$)/);
  if (!partial) return null;

  const day = Number(partial[1]);
  const month = Number(partial[2]);
  let year = partial[3] ? Number(partial[3]) : now.getUTCFullYear();
  if (year < 100) year += 2000;

  const date = new Date(Date.UTC(year, month - 1, day));
  if (Number.isNaN(date.getTime())) return null;
  if (date.getUTCFullYear() !== year || date.getUTCMonth() + 1 !== month || date.getUTCDate() !== day) return null;
  return formatDateKey(date);
}

function resolveSmartDeleteDateKey(args: any, now: Date = new Date()): string | null {
  const explicit = args?.date ?? args?.transactionDate ?? args?.operationDate ?? args?.day;
  const explicitDate = parseSmartDeleteDateKey(explicit, now);
  if (explicitDate) return explicitDate;

  const textDate = parseSmartDeleteDateKey(`${args?.userText || ''} ${args?.currentUserText || ''} ${args?.question || ''} ${args?.query || ''} ${args?.notes || ''}`, now);
  return textDate;
}

const FINANCIAL_LOCAL_TIME_ZONE = 'Asia/Gaza';

function formatFinancialLocalDateKey(date: Date): string {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: FINANCIAL_LOCAL_TIME_ZONE,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(date);
    const get = (type: string) => parts.find(p => p.type === type)?.value || '';
    const year = get('year');
    const month = get('month');
    const day = get('day');
    if (year && month && day) return `${year}-${month}-${day}`;
  } catch (_) {
    // Fall back to UTC below if the runtime does not support the IANA zone.
  }
  return date.toISOString().slice(0, 10);
}

function transactionDateKey(tx: any): string {
  const rawValue = tx?.date || tx?.transactionDate || tx?.createdAt;
  const raw = normalizeDigits(rawValue);
  const dateOnly = raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (dateOnly) {
    const parsedDateOnly = parseDateLike(raw);
    return parsedDateOnly ? formatDateKey(parsedDateOnly) : raw.slice(0, 10);
  }
  const parsedInstant = raw ? new Date(raw) : null;
  if (parsedInstant && !Number.isNaN(parsedInstant.getTime())) return formatFinancialLocalDateKey(parsedInstant);
  const parsed = parseDateLike(rawValue);
  return parsed ? formatDateKey(parsed) : String(rawValue || '').slice(0, 10);
}

function inferSmartDeleteAccount(args: any): string | null {
  if (args?.account || args?.fromAccount) return normalizeAccount(args.account || args.fromAccount);
  const text = normalizeArabicText(`${args?.category || ''} ${args?.notes || ''} ${args?.userText || ''} ${args?.currentUserText || ''} ${args?.question || ''} ${args?.query || ''}`).toLowerCase();
  if (text.includes('palpay') || text.includes('pal pay') || text.includes('بال باي') || text.includes('بالباي')) return 'palPay';
  if (text.includes('كاش') || text.includes('cash') || text.includes('نقد') || text.includes('نقدي')) return 'cash';
  if (text.includes('دين') || text.includes('ديون')) return 'debt';
  return null;
}

function shouldApplySmartDeleteCategory(category: unknown): boolean {
  const text = normalizeArabicText(category || '').toLowerCase().trim();
  if (!text) return false;
  const genericCategories = new Set(['مصروف', 'مصروف نقدي', 'نقدي', 'نقد', 'كاش', 'cash', 'عملية', 'عمليه']);
  if (genericCategories.has(text)) return false;
  if (text.includes('مصروف') && (text.includes('نقد') || text.includes('كاش') || text.includes('cash'))) return false;
  return true;
}

function smartDeleteCandidate(t: any) {
  return { id: t.id, amount: t.amount, type: t.type, account: t.account, category: t.category, subcategory: t.subcategory, merchant: t.merchant, creditor: t.creditor, date: t.date, dateKey: transactionDateKey(t), notes: t.notes };
}

function getTimeZoneOffsetMinutes(timeZone: string, instant: Date): number {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).formatToParts(instant);
    const get = (type: string) => parts.find(p => p.type === type)?.value || '0';
    const year = Number(get('year'));
    const month = Number(get('month'));
    const day = Number(get('day'));
    const hour = Number(get('hour')) % 24;
    const minute = Number(get('minute'));
    const second = Number(get('second'));
    const localAsUtc = Date.UTC(year, month - 1, day, hour, minute, second);
    return Math.round((localAsUtc - instant.getTime()) / 60000);
  } catch (_) {
    return 0;
  }
}

function getFinancialLocalDayUtcStart(dateKey: string): Date | null {
  const m = dateKey.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const noonGuess = new Date(Date.UTC(year, month - 1, day, 12));
  const noonOffset = getTimeZoneOffsetMinutes(FINANCIAL_LOCAL_TIME_ZONE, noonGuess);
  const midnightGuess = new Date(Date.UTC(year, month - 1, day) - noonOffset * 60000);
  const midnightOffset = getTimeZoneOffsetMinutes(FINANCIAL_LOCAL_TIME_ZONE, midnightGuess);
  return new Date(Date.UTC(year, month - 1, day) - midnightOffset * 60000);
}

async function readTransactionsForSmartDeleteDate(dateKey: string, userId: string, limit = 250) {
  const boundedLimit = Math.max(25, Math.min(500, Number(limit) || 250));
  const endDateKey = addDaysToDateKey(dateKey, 1);
  const localStartUtc = getFinancialLocalDayUtcStart(dateKey);
  const localEndUtc = getFinancialLocalDayUtcStart(endDateKey);
  const queryStats: any[] = [];
  const docsById = new Map<string, any>();

  const runDateQuery = async (label: string, startValue: any, endValue: any) => {
    try {
      const snap = await firebaseAdminDb.collection('transactions')
        .where('date', '>=', startValue)
        .where('date', '<', endValue)
        .limit(boundedLimit)
        .get();
      queryStats.push({ label, docsRead: snap.docs.length });
      for (const doc of snap.docs || []) docsById.set(doc.id, doc);
      return snap.docs.length >= boundedLimit;
    } catch (error: any) {
      queryStats.push({ label, error: error?.message || String(error) });
      return false;
    }
  };

  const limitHits = [
    await runDateQuery('date_key_range', dateKey, endDateKey),
  ];

  if (localStartUtc && localEndUtc) {
    // Some old rows are stored as UTC instants. A row shown locally as 2026-08-27
    // may be stored as 2026-08-26T21:xx:xxZ, so the date-key query above misses it.
    limitHits.push(await runDateQuery('local_day_iso_utc_range', localStartUtc.toISOString(), localEndUtc.toISOString()));
    // Some rows may be Firestore Timestamp/Date values rather than strings.
    limitHits.push(await runDateQuery('local_day_timestamp_range', localStartUtc, localEndUtc));
  }

  const broadDocs = Array.from(docsById.values());
  const transactions = broadDocs
    .filter((d: any) => d.data()?.userId === userId)
    .map((d: any) => ({ id: d.id, ...d.data() }));
  return { transactions, scannedDateWindowDocs: broadDocs.length, queryStats, limit: boundedLimit, limitReached: limitHits.some(Boolean) };
}

export async function deleteTransaction(args: any, userId: string, token: string) {
  const adminDb = getDb(token);
  console.log("TOOL CALL: deleteTransaction", args);
  
  // 1. Direct ID deletion if a valid ID was passed
  if (args.id && typeof args.id === 'string' && args.id.length > 5) {
    const txRef = adminDb.collection('transactions').doc(args.id);
    const doc = await txRef.get();
    if (doc.exists && doc.data()?.userId === userId) {
      const atomicResult = await atomicDeleteTransaction(userId, args.id, { riskConfirmed: !!args.riskConfirmed });
      if ('reason' in atomicResult) {
        if (atomicResult.reason === 'NEGATIVE_CASH_RESULT' || atomicResult.reason === 'NEGATIVE_PALPAY_RESULT') {
          return {
            success: false,
            needsConfirmation: true,
            reason: atomicResult.reason,
            message: 'حذف هذه العملية سيجعل أحد الأرصدة سالباً. هل تريد المتابعة رغم الأثر المالي؟',
            financialImpact: atomicResult.balances,
          };
        }
        return { success: false, reason: atomicResult.reason, message: 'تعذر حذف العملية بأمان لأنها تغيرت أو لم تعد موجودة.' };
      }
      const data = atomicResult.deleted;
      const accName = data?.account === 'palPay' ? 'PalPay' : data?.account === 'debt' ? 'الديون' : 'النقدي';
      await addNotification(userId, `تم حذف عملية (${data?.notes || data?.category || ''} بقيمة ${data?.amount} ₪ من ${accName}) بنجاح.`, 'success', adminDb);
      let vaultRecalculation: any[] = [];
      try {
        vaultRecalculation = await recalculateCyclesForTransactionChange(userId, token, data, null, 'transaction_deleted');
      } catch (vaultErr) {
        console.warn('Savings Vault recalculation failed after direct delete:', vaultErr);
      }
      return { success: true, message: "تم حذف العملية بنجاح.", currentBalances: atomicResult.balances, vaultRecalculation: vaultRecalculation.map((r: any) => r?.salaryCycle?.cycleId).filter(Boolean) };
    }
  }

  // 2. Smart deletion by criteria (date, account, amount, category, or most recent)
  // Date is treated as a first-class criterion because older/future-dated rows can
  // appear in cycle/cash-tracking screens even when they are not among the latest
  // createdAt rows. Example: 27/8 must find the 2026-08-27 transaction directly.
  const targetDateKey = resolveSmartDeleteDateKey(args);
  const targetAccount = inferSmartDeleteAccount(args);
  const targetAmount = args.amount ? parsePositiveFinancialAmount(args.amount) : null;
  const categoryFilter = shouldApplySmartDeleteCategory(args.category) ? args.category : null;
  let readEfficiency: any = null;

  let userTxs: any[] = [];
  if (targetDateKey) {
    const dateResult = await readTransactionsForSmartDeleteDate(targetDateKey, userId, args.searchLimit);
    userTxs = dateResult.transactions;
    readEfficiency = { queryType: 'date_range_then_user_filter', date: targetDateKey, scannedDateWindowDocs: dateResult.scannedDateWindowDocs, queryStats: dateResult.queryStats, limit: dateResult.limit };
    if (dateResult.limitReached) {
      return {
        success: false,
        needsClarification: true,
        reason: 'SMART_DELETE_DATE_WINDOW_TOO_LARGE',
        message: `وجدت عمليات كثيرة بتاريخ ${targetDateKey}. أعطني المعرّف أو تفاصيل أدق قبل الحذف.`,
        candidates: userTxs.slice(0, 5).map(smartDeleteCandidate),
        readEfficiency,
      };
    }
  } else {
    const snapshot = await adminDb.collection('transactions')
      .where('userId', '==', userId)
      .orderBy('createdAt', 'desc')
      .limit(100)
      .get();
    userTxs = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
    readEfficiency = { queryType: 'recent_createdAt', transactionDocsRead: snapshot.docs.length, limit: 100 };
    if ((snapshot as any).partial === true || userTxs.length >= 100) {
      return {
        success: false,
        needsClarification: true,
        reason: 'SMART_DELETE_REQUIRES_ID_OR_MORE_DETAILS',
        message: 'لمنع حرق Firestore reads، بحثت فقط في آخر 100 عملية. حدّد العملية بالمعرّف أو أعطني تاريخ/مبلغ/حساب أدق قبل الحذف.',
        candidates: userTxs.slice(0, 5).map(smartDeleteCandidate),
        readEfficiency,
      };
    }
  }

  // Sort descending by date/createdAt within the bounded candidate set.
  userTxs.sort((a: any, b: any) => new Date(b.createdAt || b.date || 0).getTime() - new Date(a.createdAt || a.date || 0).getTime());

  if (targetDateKey) {
    userTxs = userTxs.filter((t: any) => transactionDateKey(t) === targetDateKey);
  }

  if (targetAccount) {
    userTxs = userTxs.filter((t: any) => normalizeAccount(t.account) === targetAccount || normalizeAccount(t.fromAccount) === targetAccount || normalizeAccount(t.toAccount) === targetAccount);
  }

  if (targetAmount) {
    userTxs = userTxs.filter((t: any) => Math.abs(parsePositiveFinancialAmount(t.amount) - targetAmount) < 0.01);
  }

  if (categoryFilter) {
    userTxs = userTxs.filter((t: any) => matchesArabicCategory(t, categoryFilter));
  }

  if (userTxs.length > 1 && !args.id) {
    return {
      success: false,
      needsClarification: true,
      reason: 'AMBIGUOUS_DELETE',
      message: `وجدت ${userTxs.length} عمليات مطابقة. حدد العملية أو أعطني تفاصيل إضافية قبل الحذف.`,
      candidates: userTxs.slice(0, 5).map(smartDeleteCandidate),
      readEfficiency,
    };
  }

  // V6 (MF-6): smart-delete with a single candidate must STILL request confirmation.
  // Silent destructive mutations based on AI guessing are not acceptable.
  if (userTxs.length === 1 && !args.id && !args.confirmed) {
    const toDelete = userTxs[0];
    return {
      success: false,
      needsClarification: true,
      reason: 'CONFIRM_SINGLE_SMART_DELETE',
      message: `وجدت عملية واحدة مطابقة بتاريخ ${transactionDateKey(toDelete)}. هل تقصد حذفها؟`,
      candidate: smartDeleteCandidate(toDelete),
      readEfficiency,
    };
  }

  if (userTxs.length === 1 && (args.id || args.confirmed)) {
    const toDelete = userTxs[0];
    // Revalidate ownership, ledger balances, and delete atomically. The smart-search
    // candidate may be stale by the time the user confirms it.
    const atomicResult = await atomicDeleteTransaction(userId, toDelete.id, { riskConfirmed: !!args.riskConfirmed });
    if ('reason' in atomicResult) {
      if (atomicResult.reason === 'NEGATIVE_CASH_RESULT' || atomicResult.reason === 'NEGATIVE_PALPAY_RESULT') {
        return {
          success: false,
          needsConfirmation: true,
          reason: atomicResult.reason,
          message: 'حذف هذه العملية سيجعل أحد الأرصدة سالباً. هل تريد المتابعة رغم الأثر المالي؟',
          financialImpact: atomicResult.balances,
        };
      }
      return { success: false, reason: atomicResult.reason, message: 'تعذر حذف العملية بأمان لأنها تغيرت أو لم تعد موجودة.' };
    }
    const deletedData = atomicResult.deleted;
    const accName = deletedData.account === 'palPay' ? 'PalPay' : deletedData.account === 'debt' ? 'الديون' : 'النقدي';
    await addNotification(userId, `تم حذف عملية (${toDelete.notes || toDelete.category || ''} بقيمة ${toDelete.amount} ₪ من حساب ${accName}) بنجاح.`, 'success', adminDb);
    let vaultRecalculation: any[] = [];
    try {
      vaultRecalculation = await recalculateCyclesForTransactionChange(userId, token, deletedData || toDelete, null, 'transaction_deleted');
    } catch (vaultErr) {
      console.warn('Savings Vault recalculation failed after smart delete:', vaultErr);
    }
    
    return { 
      success: true, 
      deletedTransaction: smartDeleteCandidate(toDelete), 
      message: `تم حذف عملية بقيمة ${toDelete.amount} ₪ من حساب ${accName} بنجاح.`,
      currentBalances: atomicResult.balances,
      vaultRecalculation: vaultRecalculation.map((r: any) => r?.salaryCycle?.cycleId).filter(Boolean),
      readEfficiency,
    };
  }

  return { success: false, message: targetDateKey ? `لم يتم العثور على عملية مطابقة بتاريخ ${targetDateKey}. جرّب تحديد المبلغ أو الحساب أو المعرّف.` : "لم يتم العثور على عملية مطابقة لحذفها. يرجى تحديد المبلغ أو اسم الحساب.", readEfficiency };
}

function matchesRecentDeleteKind(tx: any, kind: string): boolean {
  const transactionType = String(tx?.transactionType || '');
  const type = String(tx?.type || '');
  const account = normalizeLedgerAccount(tx?.account);
  const fromAccount = normalizeLedgerAccount(tx?.fromAccount || tx?.account);
  const toAccount = normalizeLedgerAccount(tx?.toAccount);
  const text = normalizeArabicText(`${tx?.category || ''} ${tx?.subcategory || ''} ${tx?.notes || ''} ${tx?.merchant || ''} ${tx?.creditor || ''} ${transactionType}`);
  if (kind === 'debt_payment') {
    const explicitDebtPayment = transactionType === 'DEBT_PAYMENT'
      || transactionType === 'DEBT_REPAYMENT'
      || transactionType === 'PAY_DEBT'
      || transactionType === 'CREDITOR_OVERPAYMENT'
      || transactionType === 'DEBT_OVERPAYMENT';
    const ledgerDebtPayment = (type === 'transfer' && toAccount === 'debt')
      || (type === 'income' && account === 'debt')
      || (type === 'transfer' && fromAccount !== 'debt' && text.includes('سداد') && text.includes('دين'));
    const overpaymentLike = (text.includes('فائض سداد') || text.includes('دائن') || text.includes('overpay') || text.includes('overpayment'))
      && (account === 'debt' || toAccount === 'debt' || text.includes('دين') || text.includes('دائن'));
    return explicitDebtPayment || ledgerDebtPayment || overpaymentLike;
  }
  if (kind === 'expense') return type === 'expense';
  if (kind === 'credit_purchase') {
    const explicitCreditPurchase = transactionType === 'CREDIT_PURCHASE' || account === 'debt';
    const textDebtPurchase = type === 'expense'
      && (text.includes('دين') || text.includes('بالدين') || text.includes('اجل') || text.includes('آجل') || text.includes('على الحساب'))
      && !(text.includes('سداد') || text.includes('تسديد') || text.includes('سدد') || text.includes('سديت'));
    return type === 'expense' && (explicitCreditPurchase || textDebtPurchase);
  }
  if (kind === 'income') return type === 'income';
  return true;
}

export async function deleteRecentTransactions(args: any, userId: string, token: string) {
  const adminDb = getDb(token);
  console.log('TOOL CALL: deleteRecentTransactions', args);
  const count = Math.max(1, Math.min(10, Number(args?.count) || 1));
  const kindRaw = normalizeArabicText(`${args?.kind || ''} ${args?.type || ''} ${args?.transactionKind || ''} ${args?.userText || ''} ${args?.currentUserText || ''} ${args?.question || ''}`) || 'expense';
  const debtPaymentDeleteIntent = kindRaw.includes('سداد') || kindRaw.includes('تسديد') || kindRaw.includes('سدد') || kindRaw.includes('سديت') || (kindRaw.includes('دين') && (kindRaw.includes('دفع') || kindRaw.includes('دفعت')));
  const creditPurchaseDeleteIntent = kindRaw.includes('دين') && !debtPaymentDeleteIntent;
  const kind = debtPaymentDeleteIntent
    ? 'debt_payment'
    : creditPurchaseDeleteIntent || (kindRaw.includes('شراء') && kindRaw.includes('دين'))
      ? 'credit_purchase'
      : kindRaw.includes('دخل') || kindRaw.includes('راتب')
        ? 'income'
        : kindRaw.includes('الكل') || kindRaw.includes('اي') || kindRaw === 'all'
          ? 'all'
          : 'expense';
  const explicitDeleteText = /(احذف|احذفي|امسح|امسحي|اشطب|اشطبي|حذف)/.test(kindRaw) && /(اخر|آخر|اخير|أخير|عملية|عمليات)/.test(kindRaw);
  const confirmed = args?.confirmed === true || args?.confirmation === 'DELETE_RECENT_TRANSACTIONS' || explicitDeleteText;
  const searchLimit = Math.max(25, Math.min(150, Number(args?.searchLimit) || count * 20));
  const snap = await adminDb.collection('transactions')
    .where('userId', '==', userId)
    .orderBy('createdAt', 'desc')
    .limit(searchLimit)
    .get();
  const recent = snap.docs
    .map((d: any) => ({ id: d.id, ...d.data() }))
    .filter((tx: any) => matchesRecentDeleteKind(tx, kind))
    .slice(0, count);

  if (recent.length < count) {
    return {
      success: false,
      needsClarification: true,
      reason: 'NOT_ENOUGH_RECENT_MATCHES',
      requested: count,
      found: recent.length,
      kind,
      message: `وجدت ${recent.length} عملية فقط من النوع المطلوب ضمن آخر ${searchLimit} عملية. لن أحذف قبل تأكيدك.`,
      candidates: recent.map((t: any) => ({ id: t.id, amount: t.amount, type: t.type, account: t.account, transactionType: t.transactionType, category: t.category, subcategory: t.subcategory, merchant: t.merchant, creditor: t.creditor, date: t.date, createdAt: t.createdAt, notes: t.notes })),
      readEfficiency: { transactionDocsRead: snap.docs.length, limit: searchLimit },
    };
  }

  const preview = recent.map((t: any) => ({ id: t.id, amount: t.amount, type: t.type, account: t.account, transactionType: t.transactionType, category: t.category, subcategory: t.subcategory, merchant: t.merchant, creditor: t.creditor, date: t.date, createdAt: t.createdAt, notes: t.notes }));
  if (!confirmed) {
    return {
      success: false,
      needsConfirmation: true,
      reason: 'CONFIRM_RECENT_BULK_DELETE',
      message: `سأحذف آخر ${count} عملية من النوع ${kind}. أكد بتمرير confirmed=true أو قل: نعم احذفها.`,
      candidates: preview,
      readEfficiency: { transactionDocsRead: snap.docs.length, limit: searchLimit },
    };
  }

  const deleteResult = await atomicDeleteTransactions(userId, recent.map((t: any) => t.id), { reason: `delete_recent:${kind}:${count}` });
  if (!deleteResult.ok) {
    const failedDeleteResult = deleteResult as Extract<typeof deleteResult, { ok: false }>;
    return { success: false, reason: failedDeleteResult.reason, requested: count, found: failedDeleteResult.found, message: 'تعذر حذف آخر العمليات بأمان؛ قد تكون تغيّرت قبل تنفيذ الحذف.' };
  }

  const affectedCycleIds = Array.from(new Set(recent.map((t: any) => getSalaryCycleForDate(t.date || t.createdAt || new Date().toISOString(), new Date()).cycleId)));
  const recalculatedCycles: any[] = [];
  for (const cycleId of affectedCycleIds) {
    try {
      const recalculated = await recalculateSalaryCycle({ cycleId, reason: `delete_recent_transactions:${kind}` }, userId, token);
      recalculatedCycles.push(recalculated?.salaryCycle?.cycleId || cycleId);
    } catch (err) {
      console.warn('Savings Vault recalculation failed after deleteRecentTransactions:', cycleId, err);
    }
  }

  await addNotification(userId, `تم حذف ${recent.length} عملية أخيرة من النوع ${kind} بأمان.`, 'success', adminDb);
  return {
    success: true,
    deletedCount: recent.length,
    deleted: preview,
    affectedCycleIds,
    recalculatedCycles,
    currentBalances: deleteResult.balances,
    message: `تم حذف ${recent.length} عملية أخيرة بنجاح.`,
    readEfficiency: { transactionDocsRead: snap.docs.length, deleteTransactionReads: recent.length + 1, limit: searchLimit },
  };
}

function isMisroutedVaultCloseDebtCreditCandidate(tx: any): boolean {
  const type = String(tx?.type || '');
  const transactionType = String(tx?.transactionType || '');
  const account = normalizeLedgerAccount(tx?.account);
  const fromAccount = normalizeLedgerAccount(tx?.fromAccount || tx?.account);
  const toAccount = normalizeLedgerAccount(tx?.toAccount);
  const text = normalizeArabicText(`${tx?.category || ''} ${tx?.subcategory || ''} ${tx?.notes || ''} ${tx?.merchant || ''} ${tx?.creditor || ''} ${tx?.reason || ''} ${transactionType}`);
  const looksLikeCreditorSurplus = text.includes('فائض سداد') || text.includes('دائن') || text.includes('overpayment') || text.includes('creditor_overpayment') || text.includes('debt_overpayment');
  const touchesDebtAsCredit = account === 'debt' || toAccount === 'debt' || (type === 'transfer' && fromAccount !== 'debt' && text.includes('سداد'));
  const looksLikeCloseVaultMistake = text.includes('خزنه') || text.includes('الخزنه') || text.includes('خزنة') || text.includes('الخزنة') || text.includes('اقفال') || text.includes('اقفل') || text.includes('close') || text.includes('vault');
  return (looksLikeCreditorSurplus && touchesDebtAsCredit) || (looksLikeCloseVaultMistake && matchesRecentDeleteKind(tx, 'debt_payment'));
}

export async function repairMisroutedVaultClose(args: any, userId: string, token: string) {
  const adminDb = getDb(token);
  console.log('TOOL CALL: repairMisroutedVaultClose', { ...args, userId: '[redacted]' });
  const targetAmount = args?.amount !== undefined ? parsePositiveFinancialAmount(args.amount) : null;
  const searchLimit = Math.max(25, Math.min(100, Number(args?.searchLimit) || 75));
  const confirmed = args?.confirmed === true || args?.confirmation === 'REPAIR_MISROUTED_VAULT_CLOSE';
  const snap = await adminDb.collection('transactions')
    .where('userId', '==', userId)
    .orderBy('createdAt', 'desc')
    .limit(searchLimit)
    .get();
  const allCandidates = snap.docs
    .map((d: any) => ({ id: d.id, ...d.data() }))
    .filter((tx: any) => isMisroutedVaultCloseDebtCreditCandidate(tx));
  let candidates = allCandidates;
  let amountFilterFallbackUsed = false;
  if (targetAmount !== null && targetAmount > 0) {
    const amountMatches = allCandidates.filter((tx: any) => Math.abs(parsePositiveFinancialAmount(tx.amount) - targetAmount) < 0.01);
    if (amountMatches.length > 0) {
      candidates = amountMatches;
    } else {
      amountFilterFallbackUsed = true;
      candidates = allCandidates;
    }
  }
  candidates = candidates.slice(0, 5);
  const preview = candidates.map((t: any) => ({
    id: t.id,
    amount: t.amount,
    type: t.type,
    account: t.account,
    fromAccount: t.fromAccount,
    toAccount: t.toAccount,
    transactionType: t.transactionType,
    category: t.category,
    subcategory: t.subcategory,
    merchant: t.merchant,
    creditor: t.creditor,
    date: t.date,
    createdAt: t.createdAt,
    notes: t.notes,
  }));

  if (candidates.length === 0) {
    return {
      success: false,
      reason: 'NO_MISROUTED_VAULT_CLOSE_CANDIDATE',
      message: `لم أجد عملية فائض دائن/سداد مشبوهة ضمن آخر ${searchLimit} عملية${targetAmount ? ` بقيمة ${targetAmount} ₪` : ''}. لن أغيّر الرصيد بدون دليل واضح.`,
      candidates: [],
      readEfficiency: { transactionDocsRead: snap.docs.length, limit: searchLimit },
    };
  }
  if (candidates.length > 1 || !confirmed) {
    return {
      success: false,
      needsConfirmation: true,
      reason: candidates.length > 1 ? 'AMBIGUOUS_MISROUTED_VAULT_CLOSE' : 'CONFIRM_MISROUTED_VAULT_CLOSE_REPAIR',
      message: candidates.length > 1
        ? `وجدت ${candidates.length} عمليات مشبوهة. لن أحذف قبل اختيار/تأكيد العملية الصحيحة.`
        : `وجدت عملية مشبوهة بقيمة ${Number(candidates[0].amount || 0).toLocaleString()} ₪. أكد التصحيح لحذفها ذرياً واسترجاع أثرها من الرصيد.`,
      candidates: preview,
      readEfficiency: { transactionDocsRead: snap.docs.length, limit: searchLimit },
    };
  }

  const target = candidates[0];
  const deleteResult = await atomicDeleteTransactions(userId, [target.id], { reason: 'repair_misrouted_vault_close' });
  if (!deleteResult.ok) {
    const failedDeleteResult = deleteResult as Extract<typeof deleteResult, { ok: false }>;
    return { success: false, reason: failedDeleteResult.reason, message: 'تعذر تصحيح العملية بأمان؛ قد تكون تغيّرت قبل التنفيذ.' };
  }
  const affectedCycleId = getSalaryCycleForDate(target.date || target.createdAt || new Date().toISOString(), new Date()).cycleId;
  let recalculated: any = null;
  try {
    recalculated = await recalculateSalaryCycle({ cycleId: affectedCycleId, reason: 'repair_misrouted_vault_close' }, userId, token);
  } catch (err) {
    console.warn('Savings Vault recalculation failed after misrouted vault repair:', err);
  }
  await addNotification(userId, `تم تصحيح عملية فائض دائن خاطئة بقيمة ${Number(target.amount || 0).toLocaleString()} ₪ وحذف أثرها.`, 'success', adminDb);
  return {
    success: true,
    deletedCount: 1,
    deleted: preview[0],
    affectedCycleId,
    affectedCycleIds: [affectedCycleId],
    recalculatedCycle: recalculated?.salaryCycle?.cycleId || affectedCycleId,
    currentBalances: deleteResult.balances,
    message: `تم تصحيح العملية المشبوهة وحذف فائض الدائن الخاطئ بقيمة ${Number(target.amount || 0).toLocaleString()} ₪.`,
    readEfficiency: { transactionDocsRead: snap.docs.length, deleteTransactionReads: 2, limit: searchLimit, amountFilterFallbackUsed },
  };
}

function isMisrecordedCreditPurchaseCandidate(tx: any): boolean {
  const type = String(tx?.type || '');
  const account = normalizeLedgerAccount(tx?.account);
  const transactionType = String(tx?.transactionType || '');
  if (type !== 'expense') return false;
  if (account === 'debt') return false;
  const text = normalizeArabicText(`${tx?.category || ''} ${tx?.subcategory || ''} ${tx?.notes || ''} ${tx?.merchant || ''} ${tx?.creditor || ''} ${tx?.purchaseItem || ''} ${transactionType}`);
  const debtWords = transactionType === 'CREDIT_PURCHASE' || text.includes('دين') || text.includes('بالدين') || text.includes('اجل') || text.includes('آجل') || text.includes('على الحساب');
  const repaymentWords = text.includes('سداد') || text.includes('تسديد') || text.includes('سدد') || text.includes('سديت');
  return debtWords && !repaymentWords;
}

export async function repairMisrecordedCreditPurchase(args: any, userId: string, token: string) {
  const adminDb = getDb(token);
  console.log('TOOL CALL: repairMisrecordedCreditPurchase', { ...args, userId: '[redacted]' });
  const targetAmount = args?.amount !== undefined ? parsePositiveFinancialAmount(args.amount) : null;
  const targetMerchant = normalizeArabicText(String(args?.merchant || args?.creditor || args?.seller || '').trim());
  const transactionId = String(args?.transactionId || args?.id || '').trim();
  const searchLimit = Math.max(25, Math.min(100, Number(args?.searchLimit) || 75));
  const confirmed = args?.confirmed === true || args?.confirmation === 'REPAIR_MISRECORDED_CREDIT_PURCHASE';
  if (transactionId) {
    const doc = await adminDb.collection('transactions').doc(transactionId).get();
    if (!doc.exists || doc.data()?.userId !== userId) {
      return { success: false, reason: 'TRANSACTION_NOT_FOUND', message: 'لم أجد العملية المحددة أو ليست تابعة لحسابك.' };
    }
    const target: any = { id: (doc as any).id || transactionId, ...doc.data() };
    if (String(target.type || '') !== 'expense') {
      return { success: false, reason: 'NOT_EXPENSE_TRANSACTION', message: 'هذه العملية ليست مصروفاً، لذلك لن أحولها إلى شراء دين.' };
    }
    const creditorName = String(args?.creditor || args?.merchant || args?.seller || target.creditor || target.merchant || 'غير محدد').trim();
    if (!confirmed) {
      return {
        success: false,
        needsConfirmation: true,
        reason: 'CONFIRM_DIRECT_CREDIT_PURCHASE_REPAIR',
        message: `سيتم تحويل عملية ${Number(target.amount || 0).toLocaleString()} ₪ إلى شراء دين على ${creditorName}. أكد التصحيح لإرجاع أثرها من النقدي/PalPay.`,
        candidate: { id: target.id, amount: target.amount, oldAccount: target.account, merchant: target.merchant, creditor: target.creditor, date: target.date, category: target.category, subcategory: target.subcategory },
      };
    }
    const finalUpdates = {
      account: 'debt',
      paymentMethod: 'debt',
      transactionType: 'CREDIT_PURCHASE',
      creditor: creditorName,
      creditorKey: normalizeCreditorKey(creditorName),
      repairedAt: new Date().toISOString(),
      repairReason: 'direct_selected_credit_purchase_repair',
    };
    const atomicResult = await atomicUpdateTransaction(userId, transactionId, finalUpdates, { riskConfirmed: true });
    if (!atomicResult.ok) {
      const failed = atomicResult as Extract<typeof atomicResult, { ok: false }>;
      return { success: false, reason: failed.reason, message: 'تعذر تصحيح عملية الدين بأمان؛ قد تكون تغيرت قبل التنفيذ.' };
    }
    const affectedCycleId = getSalaryCycleForDate(target.date || target.createdAt || new Date().toISOString(), new Date()).cycleId;
    let recalculated: any = null;
    try {
      recalculated = await recalculateSalaryCycle({ cycleId: affectedCycleId, reason: 'direct_selected_credit_purchase_repair' }, userId, token);
    } catch (err) {
      console.warn('Savings Vault recalculation failed after direct credit purchase repair:', err);
    }
    await addNotification(userId, `تم تحويل عملية ${Number(target.amount || 0).toLocaleString()} ₪ إلى شراء دين على ${creditorName} وإرجاع أثرها من الرصيد السائل.`, 'success', adminDb);
    return {
      success: true,
      updatedTransactionId: transactionId,
      affectedCycleId,
      affectedCycleIds: [affectedCycleId],
      recalculatedCycle: recalculated?.salaryCycle?.cycleId || affectedCycleId,
      currentBalances: atomicResult.balances,
      message: `تم تحويل البند المحدد إلى شراء دين على ${creditorName}. رجع أثره من النقدي/PalPay، وبقي محسوباً ضمن مصروفات الدورة كدين.`,
      readEfficiency: { transactionDocsRead: 1, balanceSnapshotReads: 1, transactionUpdateReads: 1 },
    };
  }
  const snap = await adminDb.collection('transactions')
    .where('userId', '==', userId)
    .orderBy('createdAt', 'desc')
    .limit(searchLimit)
    .get();
  const allRecent = snap.docs.map((d: any) => ({ id: d.id, ...d.data() }));
  let candidates = allRecent.filter((tx: any) => isMisrecordedCreditPurchaseCandidate(tx));
  if (targetAmount !== null && targetAmount > 0) {
    const amountMatches = candidates.filter((tx: any) => Math.abs(parsePositiveFinancialAmount(tx.amount) - targetAmount) < 0.01);
    candidates = amountMatches;
  }
  if (targetMerchant) {
    const merchantMatches = candidates.filter((tx: any) => normalizeArabicText(`${tx?.merchant || ''} ${tx?.creditor || ''} ${tx?.notes || ''}`).includes(targetMerchant));
    candidates = merchantMatches;
  }
  if (candidates.length === 0 && targetAmount !== null && targetAmount > 0 && targetMerchant) {
    candidates = allRecent.filter((tx: any) => {
      const type = String(tx?.type || '');
      const account = normalizeLedgerAccount(tx?.account);
      const amountMatches = Math.abs(parsePositiveFinancialAmount(tx.amount) - targetAmount) < 0.01;
      const merchantMatches = normalizeArabicText(`${tx?.merchant || ''} ${tx?.creditor || ''} ${tx?.notes || ''}`).includes(targetMerchant);
      return type === 'expense' && account !== 'debt' && amountMatches && merchantMatches;
    });
  }
  candidates = candidates.slice(0, 5);
  const preview = candidates.map((t: any) => ({
    id: t.id,
    amount: t.amount,
    oldAccount: t.account,
    newAccount: 'debt',
    type: t.type,
    transactionType: t.transactionType,
    merchant: t.merchant,
    creditor: t.creditor || t.merchant,
    category: t.category,
    subcategory: t.subcategory,
    date: t.date,
    createdAt: t.createdAt,
    notes: t.notes,
  }));

  if (candidates.length === 0) {
    return {
      success: false,
      reason: 'NO_MISRECORDED_CREDIT_PURCHASE_CANDIDATE',
      message: `لم أجد عملية دين خُصمت من النقدي/PalPay ضمن آخر ${searchLimit} عملية${targetAmount ? ` بقيمة ${targetAmount} ₪` : ''}. لن أعدل الرصيد بدون دليل واضح.`,
      candidates: [],
      readEfficiency: { transactionDocsRead: snap.docs.length, limit: searchLimit },
    };
  }
  if (candidates.length > 1 || !confirmed) {
    return {
      success: false,
      needsConfirmation: true,
      reason: candidates.length > 1 ? 'AMBIGUOUS_MISRECORDED_CREDIT_PURCHASE' : 'CONFIRM_MISRECORDED_CREDIT_PURCHASE_REPAIR',
      message: candidates.length > 1
        ? `وجدت ${candidates.length} عمليات دين خُصمت من النقدي/PalPay. اختر أو أكد العملية الصحيحة قبل التصحيح.`
        : `وجدت عملية دين خُصمت من ${preview[0].oldAccount || 'الرصيد'} بقيمة ${Number(candidates[0].amount || 0).toLocaleString()} ₪. أكد التصحيح لإرجاعها للدين بدون حذف العملية.`,
      candidates: preview,
      readEfficiency: { transactionDocsRead: snap.docs.length, limit: searchLimit },
    };
  }

  const target = candidates[0];
  const finalUpdates = {
    account: 'debt',
    paymentMethod: 'debt',
    transactionType: 'CREDIT_PURCHASE',
    creditor: target.creditor || target.merchant || args?.creditor || args?.merchant || 'غير محدد',
    creditorKey: normalizeCreditorKey(target.creditor || target.merchant || args?.creditor || args?.merchant || 'غير محدد'),
    repairedAt: new Date().toISOString(),
    repairReason: 'misrecorded_credit_purchase_cash_deduction',
  };
  const atomicResult = await atomicUpdateTransaction(userId, target.id, finalUpdates, { riskConfirmed: true });
  if (!atomicResult.ok) {
    const failed = atomicResult as Extract<typeof atomicResult, { ok: false }>;
    return { success: false, reason: failed.reason, message: 'تعذر تصحيح عملية الدين بأمان؛ قد تكون تغيرت قبل التنفيذ.' };
  }
  const projected = { ...target, ...finalUpdates, userId };
  const affectedCycleId = getSalaryCycleForDate(target.date || target.createdAt || new Date().toISOString(), new Date()).cycleId;
  let recalculated: any = null;
  try {
    recalculated = await recalculateSalaryCycle({ cycleId: affectedCycleId, reason: 'repair_misrecorded_credit_purchase' }, userId, token);
  } catch (err) {
    console.warn('Savings Vault recalculation failed after credit purchase repair:', err);
  }
  await addNotification(userId, `تم تصحيح عملية دين بقيمة ${Number(target.amount || 0).toLocaleString()} ₪: أُرجعت من ${target.account || 'الرصيد'} إلى الديون.`, 'success', adminDb);
  return {
    success: true,
    updatedTransactionId: target.id,
    before: preview[0],
    after: { id: target.id, ...projected },
    affectedCycleId,
    affectedCycleIds: [affectedCycleId],
    recalculatedCycle: recalculated?.salaryCycle?.cycleId || affectedCycleId,
    currentBalances: atomicResult.balances,
    message: `رجّعت أثر العملية من ${target.account === 'palPay' ? 'PalPay' : 'النقدي'} وحولتها لشراء دين بقيمة ${Number(target.amount || 0).toLocaleString()} ₪ بدون حذفها.`,
    readEfficiency: { transactionDocsRead: snap.docs.length, balanceSnapshotReads: 1, transactionUpdateReads: 1, limit: searchLimit },
  };
}

export async function repairDuplicateIncome(args: any, userId: string, token: string) {
  const adminDb = getDb(token);
  console.log('TOOL CALL: repairDuplicateIncome', args);
  const targetAmount = args.amount !== undefined ? parsePositiveFinancialAmount(args.amount) : null;
  const targetDate = String(args.date || '').slice(0, 10);
  const targetMonth = String(args.month || '').slice(0, 7);
  const repairNow = new Date();
  let startIso = '';
  let endIso = '';
  if (targetDate) {
    const start = new Date(`${targetDate}T00:00:00.000Z`);
    const end = new Date(start);
    end.setUTCDate(end.getUTCDate() + 1);
    startIso = start.toISOString();
    endIso = end.toISOString();
  } else if (targetMonth) {
    const start = new Date(`${targetMonth}-01T00:00:00.000Z`);
    const end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1));
    startIso = start.toISOString();
    endIso = end.toISOString();
  } else {
    startIso = new Date(repairNow.getTime() - 90 * 86400000).toISOString();
    endIso = repairNow.toISOString();
  }
  const snap = await adminDb.collection('transactions')
    .where('userId', '==', userId)
    .where('date', '>=', startIso)
    .where('date', '<', endIso)
    .where('type', '==', 'income')
    .limit(300)
    .get();
  if ((snap as any).partial === true || snap.docs.length >= 300) {
    return { success: false, retryable: true, reason: 'REPAIR_DUPLICATE_INCOME_QUERY_UNCERTAIN', message: 'لا يمكن إصلاح التكرار من قراءة جزئية أو مشبعة. حدّد تاريخاً أو شهراً أضيق.' };
  }
  const incomes = snap.docs
    .map((d: any) => ({ id: d.id, ...d.data() }))
    .filter((t: any) => targetAmount === null || Math.abs(parsePositiveFinancialAmount(t.amount) - targetAmount) < 0.01);

  const groups = new Map<string, any[]>();
  for (const t of incomes) {
    const day = String(t.date || t.createdAt || '').slice(0, 10);
    const key = [day, parsePositiveFinancialAmount(t.amount).toFixed(2), t.account || 'cash', t.category || '', t.subcategory || ''].join('|');
    const arr = groups.get(key) || [];
    arr.push(t);
    groups.set(key, arr);
  }

  const deleted: any[] = [];
  let currentBalances: any = undefined;
  for (const group of groups.values()) {
    if (group.length <= 1) continue;
    group.sort((a: any, b: any) => String(a.createdAt || a.date || '').localeCompare(String(b.createdAt || b.date || '')));
    const keep = group[0];
    for (const dup of group.slice(1)) {
      const deletion = await atomicDeleteTransaction(userId, dup.id, { riskConfirmed: Boolean(args.riskConfirmed) });
      if ('reason' in deletion) {
        return { success: false, needsConfirmation: true, reason: deletion.reason, message: 'توقف إصلاح التكرار لأن حذف إحدى النسخ سيؤثر على الأرصدة. أكد المخاطرة أو راجع العملية يدوياً.', deleted };
      }
      currentBalances = deletion.balances;
      deleted.push({ id: dup.id, amount: dup.amount, account: dup.account, date: dup.date, keptId: keep.id });
    }
  }

  return {
    success: true,
    deletedCount: deleted.length,
    deleted,
    message: deleted.length ? `حذفت ${deleted.length} قيد دخل مكرر وأبقيت النسخة الأصلية.` : 'لم أجد تكرار دخل مطابقاً للمعايير.',
    currentBalances
  };
}

export async function repairDuplicateCreditPurchase(args: any, userId: string, token: string) {
  const adminDb = getDb(token);
  console.log('TOOL CALL: repairDuplicateCreditPurchase', args);
  const targetAmount = args.amount !== undefined ? parsePositiveFinancialAmount(args.amount) : null;
  const targetCreditor = normalizeCreditorName(args.creditor || args.merchant || args.seller || '');
  const targetDate = String(args.date || '').slice(0, 10);
  const targetMonth = String(args.month || '').slice(0, 7);
  const repairNow = new Date();
  let startIso = '';
  let endIso = '';
  if (targetDate) {
    const start = new Date(`${targetDate}T00:00:00.000Z`);
    const end = new Date(start);
    end.setUTCDate(end.getUTCDate() + 1);
    startIso = start.toISOString();
    endIso = end.toISOString();
  } else if (targetMonth) {
    const start = new Date(`${targetMonth}-01T00:00:00.000Z`);
    const end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1));
    startIso = start.toISOString();
    endIso = end.toISOString();
  } else {
    startIso = new Date(repairNow.getTime() - 90 * 86400000).toISOString();
    endIso = repairNow.toISOString();
  }
  let q: any = adminDb.collection('transactions')
    .where('userId', '==', userId)
    .where('date', '>=', startIso)
    .where('date', '<', endIso);
  if (targetCreditor) q = q.where('creditorKey', '==', targetCreditor);
  const snap = await q.limit(300).get();
  if ((snap as any).partial === true || snap.docs.length >= 300) {
    return { success: false, retryable: true, reason: 'REPAIR_DUPLICATE_CREDIT_QUERY_UNCERTAIN', message: 'لا يمكن إصلاح تكرار الشراء بالدين من قراءة جزئية أو مشبعة. حدّد تاريخاً/شهراً/دائناً أضيق.' };
  }
  const purchases = snap.docs
    .map((d: any) => ({ id: d.id, ...d.data() }))
    .filter((t: any) => t.type === 'expense' && (t.account === 'debt' || t.transactionType === 'CREDIT_PURCHASE'))
    .filter((t: any) => targetAmount === null || Math.abs(parsePositiveFinancialAmount(t.amount) - targetAmount) < 0.01)
    .filter((t: any) => !targetCreditor || normalizeCreditorName(t.creditor || t.merchant || '') === targetCreditor);

  const groups = new Map<string, any[]>();
  for (const t of purchases) {
    const day = String(t.date || t.createdAt || '').slice(0, 10);
    const creditor = normalizeCreditorName(t.creditor || t.merchant || 'غير محدد');
    const key = [day, parsePositiveFinancialAmount(t.amount).toFixed(2), creditor, t.category || '', t.subcategory || ''].join('|');
    const arr = groups.get(key) || [];
    arr.push(t);
    groups.set(key, arr);
  }

  const deleted: any[] = [];
  let currentBalances: any = undefined;
  for (const group of groups.values()) {
    if (group.length <= 1) continue;
    group.sort((a: any, b: any) => String(a.createdAt || a.date || '').localeCompare(String(b.createdAt || b.date || '')));
    const keep = group[0];
    for (const dup of group.slice(1)) {
      const deletion = await atomicDeleteTransaction(userId, dup.id, { riskConfirmed: Boolean(args.riskConfirmed) });
      if ('reason' in deletion) {
        return { success: false, needsConfirmation: true, reason: deletion.reason, message: 'توقف إصلاح تكرار الشراء بالدين لأن حذف إحدى النسخ سيؤثر على الأرصدة. أكد المخاطرة أو راجع العملية يدوياً.', deleted };
      }
      currentBalances = deletion.balances;
      deleted.push({ id: dup.id, amount: dup.amount, creditor: dup.creditor, merchant: dup.merchant, date: dup.date, keptId: keep.id });
    }
  }

  return {
    success: true,
    deletedCount: deleted.length,
    deleted,
    message: deleted.length ? `حذفت ${deleted.length} قيد شراء بالدين مكرر وأبقيت النسخة الأصلية.` : 'لم أجد تكرار شراء بالدين مطابقاً للمعايير.',
    currentBalances
  };
}

export async function setCategoryBudget(args: any, userId: string, token: string) {
  const adminDb = getDb(token);
  console.log("TOOL CALL: setCategoryBudget", args);
  const category = args.category;
  const limit = parsePositiveFinancialAmount(args.limit) || 500;
  
  if (!category) return { error: "Category is required" };
  
  await adminDb.collection('users').doc(userId).collection('budgets').doc(category).set({
    category,
    limit,
    updatedAt: new Date().toISOString()
  });

  await addNotification(userId, `تم ضبط ميزانية بند [${category}] لتكون ${limit} ₪ شهرياً.`, 'success', adminDb);
  return { success: true, category, limit, message: `Budget for ${category} set to ${limit} ILS.` };
}

export async function getBudgetsOverview(args: any, userId: string, token: string) {
  const adminDb = getDb(token);
  const customBudgetDocs = await getUserCustomBudgetDocs(userId, adminDb);
  // Reuse the documents already fetched above. DEFAULT_BUDGETS is only an
  // onboarding/template suggestion; it is not an active user budget and must not
  // show as a fake 7300 ₪ monthly limit for users whose real income is lower.
  const userBudgets: Record<string, number> = {};
  customBudgetDocs.forEach((b) => {
    if (b.limit) userBudgets[b.category || b.id] = Number(b.limit);
  });
  
  const now = new Date();
  const salaryCycle = getCurrentSalaryCycle(now);
  const thisMonth = salaryCycle.id || now.toISOString().slice(0, 7);
  let partial = false;
  let queryError = '';
  let cycleTransactions: any[] = [];
  try {
    const txResult: any = await queryTransactions({ period: 'current_salary_cycle', includeTransactions: true, limit: 700 }, userId, token);
    cycleTransactions = Array.isArray(txResult.transactions) ? txResult.transactions : [];
    partial = Boolean(txResult.partial);
  } catch (rangeErr: any) {
    console.warn('[budgets] salary-cycle transaction query failed; returning partial budget totals:', rangeErr);
    partial = true;
    queryError = rangeErr?.message || 'salary-cycle budget transaction query failed';
    cycleTransactions = [];
  }

  const monthExpenses = cycleTransactions
    .filter((t: any) => String(t.type || '').toLowerCase() === 'expense');

  const categories = Object.keys(userBudgets);
  const budgets = categories.map(cat => {
    const limit = userBudgets[cat];
    const catExpenses = monthExpenses.filter(t => t.category === cat);
    const spent = catExpenses.reduce((sum, t) => sum + parsePositiveFinancialAmount(t.amount), 0);
    const ratio = limit > 0 ? spent / limit : 0;
    const percentage = Math.round(ratio * 100);
    const status = ratio >= 1.0 ? 'exceeded' : ratio >= 0.8 ? 'warning' : 'safe';
    return {
      category: cat,
      limit,
      spent,
      remaining: Math.max(0, limit - spent),
      percentage,
      status
    };
  });

  const totalBudget = Object.values(userBudgets).reduce((a, b) => a + b, 0);
  const totalSpent = monthExpenses.reduce((sum, t) => sum + parsePositiveFinancialAmount(t.amount), 0);

  return {
    budgets,
    totalBudget,
    totalSpent,
    month: thisMonth,
    customBudgetCount: customBudgetDocs.length,
    hasExplicitBudgets: customBudgetDocs.length > 0,
    defaultBudgetTemplateTotal: Object.values(DEFAULT_BUDGETS).reduce((a, b) => a + b, 0),
    defaultBudgetCount: Object.keys(DEFAULT_BUDGETS).length,
    note: customBudgetDocs.length > 0 ? undefined : 'لا توجد ميزانيات محفوظة؛ القالب الافتراضي ليس ميزانية فعلية.',
    partial,
    queryError: partial ? queryError : undefined
  };
}

export async function checkBudgetStatus(args: any, userId: string, token: string) {
  const adminDb = getDb(token);
  console.log("TOOL CALL: checkBudgetStatus", args);
  
  const userBudgets = await getUserBudgets(userId, adminDb);
  const txResult: any = await queryTransactions({ period: 'current_salary_cycle', includeTransactions: true, limit: 500 }, userId, token)
    .catch((err: any) => ({ success: false, transactions: [], partial: true, error: err?.message || String(err) }));
  const expenses = (Array.isArray(txResult.transactions) ? txResult.transactions : [])
    .filter((t: any) => String(t.type || '').toLowerCase() === 'expense');
  
  if (args.category) {
    const categoryExpenses = expenses.filter(t => t.category === args.category);
    const spent = categoryExpenses.reduce((sum, t) => sum + parsePositiveFinancialAmount(t.amount), 0);
    const limit = Number(userBudgets[args.category] || 0);
    if (!(limit > 0)) {
      return {
        category: args.category,
        spent,
        limit: 0,
        remaining: 0,
        percentage: null,
        warning: `لا يوجد حد ميزانية محفوظ لبند ${args.category}. القالب الافتراضي ليس ميزانية فعلية؛ اضبط حدًا للبند أولًا.`
      };
    }
    const percentage = Math.round((spent / limit) * 100);
    
    let warning = "الوضع ممتاز وفي نطاق الميزانية";
    if (spent >= limit) {
      warning = `انتبه يا صديقي، لقد تجاوزت سقف ميزانية ${args.category} لهذا الشهر (${spent} ₪ من أصل ${limit} ₪)!`;
    } else if (spent >= limit * 0.8) {
      warning = `انتبه يا صديقي، اقتربت من إقفال ميزانية ${args.category} لهذا الشهر (وصلت إلى ${percentage}% - ${spent} ₪ من أصل ${limit} ₪).`;
    }
    
    return { 
      category: args.category, 
      spent, 
      limit, 
      remaining: Math.max(0, limit - spent),
      percentage, 
      warning 
    };
  }
  
  const totalSpent = expenses.reduce((sum, t) => sum + parsePositiveFinancialAmount(t.amount), 0);
  const totalLimit = Object.values(userBudgets).reduce((a, b) => a + b, 0);
  if (!(totalLimit > 0)) {
    return {
      totalSpent,
      totalLimit: 0,
      totalPercentage: null,
      warning: 'لا توجد حدود ميزانية محفوظة حتى الآن. القالب الافتراضي ليس ميزانية فعلية؛ أنشئ أو طبّق ميزانية أولًا.'
    };
  }
  const totalPercentage = Math.round((totalSpent / totalLimit) * 100);
  
  let totalWarning = "الميزانية الشهرية العامة في وضع آمن ومستقر";
  if (totalSpent >= totalLimit) {
    totalWarning = `تحذير: إجمالي مصروفاتك للشهر تجاوز السقف المحدد للميزانية (${totalSpent} ₪ من ${totalLimit} ₪).`;
  } else if (totalSpent >= totalLimit * 0.8) {
    totalWarning = `تنبيه: اقتربت من إقفال الميزانية الإجمالية لهذا الشهر بنسبة ${totalPercentage}% (${totalSpent} ₪ من ${totalLimit} ₪).`;
  }

  return { 
    totalSpent, 
    totalLimit, 
    totalPercentage, 
    warning: totalWarning 
  };
}

function normalizeRecurringCommitmentFrequency(value: any) {
  const raw = normalizeArabicText(String(value || 'monthly')).toLowerCase();
  if (['weekly', 'اسبوعي', 'أسبوعي', 'كل اسبوع', 'كل أسبوع'].includes(raw)) return 'weekly';
  if (['biweekly', 'كل اسبوعين', 'كل أسبوعين', 'نصف شهري'].includes(raw)) return 'biweekly';
  if (['quarterly', 'ربع سنوي', 'كل 3 شهور', 'كل ثلاثة شهور'].includes(raw)) return 'quarterly';
  if (['yearly', 'annual', 'سنوي', 'سنوياً', 'كل سنة'].includes(raw)) return 'yearly';
  return 'monthly';
}

function recurringIntervalDays(frequency: string) {
  return frequency === 'weekly' ? 7 : frequency === 'biweekly' ? 14 : frequency === 'quarterly' ? 91 : frequency === 'yearly' ? 365 : 30;
}

function addRecurringDays(date: Date, days: number) {
  const next = new Date(date.getTime());
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function estimateNextRecurringDueDate(lastDate: any, frequency: string, now: Date = new Date()) {
  const interval = recurringIntervalDays(frequency);
  let next = addRecurringDays(auditAsDate(lastDate) || now, interval);
  let guard = 0;
  while (next.getTime() < now.getTime() && guard < 24) {
    next = addRecurringDays(next, interval);
    guard++;
  }
  return next.toISOString().slice(0, 10);
}

function medianNumber(values: number[]) {
  const sorted = values.filter(v => Number.isFinite(v)).sort((a, b) => a - b);
  if (!sorted.length) return 0;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function inferRecurringFrequencyFromIntervals(intervals: number[]) {
  const median = medianNumber(intervals);
  if (median >= 5 && median <= 9) return 'weekly';
  if (median >= 12 && median <= 18) return 'biweekly';
  if (median >= 24 && median <= 38) return 'monthly';
  if (median >= 75 && median <= 105) return 'quarterly';
  if (median >= 330 && median <= 400) return 'yearly';
  return 'irregular';
}

function recurringCandidateKey(tx: any) {
  const category = normalizeArabicText(String(tx.category || '')).toLowerCase();
  const subcategory = normalizeArabicText(String(tx.subcategory || '')).toLowerCase();
  const fullText = normalizeArabicText([
    tx.title,
    tx.name,
    tx.category,
    tx.subcategory,
    tx.merchant,
    tx.beneficiary,
    tx.purchaseItem,
    tx.description,
    tx.note,
    tx.notes,
  ].filter(Boolean).join(' ')).toLowerCase();

  // Group common local bills by semantic meaning, not exact wording. Users may
  // record the same obligation as "جوال", "فاتورة جوال", "هاتف", or provider
  // names across different categories.
  if (/جوال|هاتف|موبايل|اتصال|اتصالات|jawwal|ooredoo|mobile|phone/.test(fullText)) return 'service|phone_bill';
  if (/انترنت|إنترنت|نت|راوتر|فايبر|adsl|fiber|internet|wifi|wi-fi/.test(fullText)) return 'service|internet_bill';
  if (/امي|أمي|والدتي|مصروف امي|مصروف أمي|العيله|العائلة|اهلي|أهلي/.test(fullText)) return 'service|family_support_mother';
  if (/كهربا|كهرباء|ماء|مياه|بلدية|غاز/.test(fullText)) return 'service|utility_bill';
  if (/ايجار|إيجار|اجار|أجار|rent/.test(fullText)) return 'service|rent';

  const merchant = normalizeArabicText(String(tx.merchant || tx.beneficiary || '')).toLowerCase();
  const notes = normalizeArabicText(String(tx.purchaseItem || tx.description || tx.note || tx.notes || '')).toLowerCase().replace(/\d+/g, '').slice(0, 60);
  const anchor = merchant || notes || subcategory || category;
  if (!anchor) return '';
  return `${category || 'uncategorized'}|${subcategory || 'general'}|${anchor}`;
}

function recurringKeywordBoost(tx: any) {
  const text = normalizeArabicText(`${tx.category || ''} ${tx.subcategory || ''} ${tx.merchant || ''} ${tx.beneficiary || ''} ${tx.purchaseItem || ''} ${tx.description || ''} ${tx.note || ''} ${tx.notes || ''}`).toLowerCase();
  return /اشتراك|subscription|netflix|spotify|انترنت|إنترنت|internet|كهرباء|ماء|مياه|بلدية|غاز|ايجار|إيجار|اجار|أجار|rent|قسط|gym|نادي|مدرسة|جامعة|تامين|تأمين|هاتف|جوال|موبايل|فاتورة|امي|أمي|والدتي/.test(text) ? 0.15 : 0;
}

function buildRecurringCandidate(group: any[], key: string, now: Date) {
  const sorted = [...group].sort((a: any, b: any) => (transactionAnalysisDate(a)?.getTime() || 0) - (transactionAnalysisDate(b)?.getTime() || 0));
  const dated = sorted.map((tx: any) => ({ tx, date: transactionAnalysisDate(tx) })).filter((x: any) => x.date);
  if (dated.length < 2) return null;
  const intervals = dated.slice(1).map((x: any, idx: number) => Math.round((x.date.getTime() - dated[idx].date.getTime()) / 86400000)).filter((days: number) => days > 0);
  const frequency = inferRecurringFrequencyFromIntervals(intervals);
  if (frequency === 'irregular') return null;
  const amounts = sorted.map((tx: any) => parsePositiveFinancialAmount(tx.amount)).filter((n: number) => n > 0);
  const medianAmount = roundMoney(medianNumber(amounts));
  const amountDeviation = medianAmount > 0 ? Math.max(...amounts.map((n: number) => Math.abs(n - medianAmount) / medianAmount)) : 1;
  if (amountDeviation > 0.25) return null;
  const intervalMedian = medianNumber(intervals);
  const intervalDeviation = intervalMedian > 0 ? Math.max(...intervals.map((n: number) => Math.abs(n - intervalMedian) / intervalMedian)) : 1;
  const keywordBoost = Math.max(...sorted.map(recurringKeywordBoost));
  const confidence = Math.max(0, Math.min(1, 0.35 + Math.min(0.25, dated.length * 0.06) + (amountDeviation <= 0.08 ? 0.15 : 0.05) + (intervalDeviation <= 0.25 ? 0.15 : 0.05) + keywordBoost));
  if (confidence < 0.55) return null;
  const lastTx = sorted[sorted.length - 1];
  const title = lastTx.merchant || lastTx.beneficiary || lastTx.purchaseItem || lastTx.subcategory || lastTx.category || 'التزام متكرر';
  return {
    id: stableDocId(`recurring:${key}:${medianAmount}:${frequency}`),
    detectionKey: stableDocId(`recurring:${key}:${medianAmount}:${frequency}`),
    title,
    amount: medianAmount,
    frequency,
    confidence: Math.round(confidence * 100) / 100,
    category: lastTx.category || 'أقساط والتزامات',
    subcategory: lastTx.subcategory || '',
    account: lastTx.account || '',
    nextDueDate: estimateNextRecurringDueDate(lastTx.date || lastTx.localDay || lastTx.localDate || lastTx.dateKey || lastTx.createdAt, frequency, now),
    occurrenceCount: sorted.length,
    intervals,
    amountDeviation: Math.round(amountDeviation * 100) / 100,
    intervalDeviation: Math.round(intervalDeviation * 100) / 100,
    sourceTransactionIds: sorted.map((tx: any) => tx.id).filter(Boolean).slice(0, 20),
    sample: sorted.slice(-5).map((tx: any) => ({ id: tx.id, amount: tx.amount, date: tx.date || tx.localDay || tx.localDate || tx.dateKey || tx.createdAt, merchant: tx.merchant, category: tx.category })),
  };
}

export async function getCommitments(args: any, userId: string, token: string) {
  const adminDb = getDb(token);
  const limit = Math.max(1, Math.min(300, Number(args?.limit) || 100));
  const [orderedSnapshot, unorderedSnapshot] = await Promise.all([
    adminDb.collection('commitments')
      .where('userId', '==', userId)
      .orderBy('dueDate', 'asc')
      .limit(limit)
      .get()
      .catch((err: any) => ({ docs: [], partial: true, error: err })),
    adminDb.collection('commitments')
      .where('userId', '==', userId)
      .limit(limit)
      .get()
      .catch((err: any) => ({ docs: [], partial: true, error: err })),
  ]);
  const byId = new Map<string, any>();
  for (const doc of [...((orderedSnapshot as any).docs || []), ...((unorderedSnapshot as any).docs || [])]) {
    byId.set(doc.id, { id: doc.id, ...doc.data() });
  }
  const commitments = Array.from(byId.values());
  
  const now = new Date();
  const enriched = commitments.map((c: any) => {
    const due = auditAsDate(c.dueDate) || new Date(c.dueDate);
    const hasValidDueDate = Number.isFinite(due.getTime());
    const diffMs = hasValidDueDate ? due.getTime() - now.getTime() : 0;
    const daysRemaining = hasValidDueDate ? Math.ceil(diffMs / (1000 * 60 * 60 * 24)) : null;
    // V6: paid/cancelled commitments keep their explicit status — don't override with isOverdue.
    const explicitStatus = c.status && ['pending', 'paid', 'cancelled'].includes(c.status) ? c.status : null;
    const isDueSoon = explicitStatus === 'pending' && daysRemaining !== null && daysRemaining >= 0 && daysRemaining <= 3;
    const isOverdue = explicitStatus === 'pending' && daysRemaining !== null && daysRemaining < 0;
    return {
      ...c,
      daysRemaining,
      isDueSoon,
      isOverdue,
      status: explicitStatus || (isOverdue ? 'overdue' : isDueSoon ? 'due_soon' : 'upcoming')
    };
  });

  enriched.sort((a, b) => {
    const at = auditAsDate(a.dueDate)?.getTime() || Number.MAX_SAFE_INTEGER;
    const bt = auditAsDate(b.dueDate)?.getTime() || Number.MAX_SAFE_INTEGER;
    return at - bt;
  });
  return {
    commitments: enriched,
    partial: Boolean((orderedSnapshot as any).partial || (unorderedSnapshot as any).partial || commitments.length >= limit),
    limit,
    readEfficiency: { commitmentDocsRead: commitments.length, limit, orderedDocsRead: ((orderedSnapshot as any).docs || []).length, unorderedDocsRead: ((unorderedSnapshot as any).docs || []).length }
  };
}

export async function createCommitment(args: any, userId: string, token: string) {
  const adminDb = getDb(token);
  const docRef = adminDb.collection('commitments').doc();
  const recurringFrequency = normalizeRecurringCommitmentFrequency(args.recurringFrequency || args.frequency || args.interval);
  const isRecurring = parseBooleanLike(args.recurring) || Boolean(args.recurringFrequency || args.frequency || args.interval || args.recurringDetectionKey);
  const commitment: any = {
    userId,
    title: args.title || 'التزام مجدول',
    amount: parsePositiveFinancialAmount(args.amount),
    dueDate: args.dueDate || new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    category: args.category || 'أقساط والتزامات',
    notes: args.notes || '',
    recurring: isRecurring,
    recurringFrequency: isRecurring ? recurringFrequency : null,
    recurringDetectionKey: args.recurringDetectionKey || args.detectionKey || null,
    recurringConfidence: args.recurringConfidence !== undefined ? Math.max(0, Math.min(1, Number(args.recurringConfidence) || 0)) : null,
    sourceTransactionIds: Array.isArray(args.sourceTransactionIds) ? args.sourceTransactionIds.slice(0, 20) : [],
    // V6 (MF-1): explicit lifecycle status. Values: 'pending' | 'paid' | 'cancelled'.
    status: 'pending',
    createdAt: new Date().toISOString()
  };
  await docRef.set(commitment);
  await addNotification(userId, `تمت جدولة التزام "${commitment.title}" بقيمة ${commitment.amount} ₪ في موعد ${commitment.dueDate.slice(0, 10)}.`, 'success', adminDb);
  return { success: true, id: docRef.id, commitment };
}

/**
 * V6 (MF-1): update commitment lifecycle status.
 * Used to mark a commitment as paid (excludes from forecast) or cancelled.
 */
export async function detectRecurringCommitments(args: any, userId: string, token: string) {
  const adminDb = getDb(token);
  const now = args?.now ? new Date(String(args.now)) : new Date();
  const safeNow = Number.isFinite(now.getTime()) ? now : new Date();
  const limit = Math.max(100, Math.min(1000, Number(args?.limit) || 500));
  const minOccurrences = Math.max(2, Math.min(12, Number(args?.minOccurrences) || 2));
  let transactions: any[] = [];
  let readSource = 'date_desc_bounded';
  let partial = false;
  try {
    const snap = await adminDb.collection('transactions')
      .where('userId', '==', userId)
      .orderBy('date', 'desc')
      .limit(limit)
      .get();
    transactions = snap.docs.map((d: any) => ({ id: d.id, ...d.data() }));
    partial = Boolean((snap as any).partial || transactions.length >= limit);
    if (transactions.length === 0) throw new Error('NO_DATE_SORTED_TRANSACTIONS_FOR_RECURRING_DETECTION');
  } catch (err: any) {
    readSource = 'createdAt_desc_bounded_fallback';
    try {
      const snap = await adminDb.collection('transactions')
        .where('userId', '==', userId)
        .orderBy('createdAt', 'desc')
        .limit(limit)
        .get();
      transactions = snap.docs.map((d: any) => ({ id: d.id, ...d.data() }));
      partial = true;
    } catch (fallbackErr: any) {
      readSource = 'userId_bounded_fallback';
      const snap = await adminDb.collection('transactions').where('userId', '==', userId).limit(limit).get();
      transactions = snap.docs.map((d: any) => ({ id: d.id, ...d.data() }));
      partial = true;
    }
  }

  const existingSnap = await adminDb.collection('commitments')
    .where('userId', '==', userId)
    .orderBy('dueDate', 'asc')
    .limit(300)
    .get()
    .catch(() => ({ docs: [], partial: true }));
  const existingCommitments = ((existingSnap as any).docs || []).map((d: any) => ({ id: d.id, ...d.data() }));
  const existingKeys = new Set(existingCommitments.map((c: any) => String(c.recurringDetectionKey || '').trim()).filter(Boolean));
  const existingTitleAmounts = new Set(existingCommitments.map((c: any) => `${normalizeArabicText(String(c.title || '')).toLowerCase()}:${roundMoney(parsePositiveFinancialAmount(c.amount))}`));

  const expenses = transactions.filter((tx: any) => {
    if (String(tx.type || '').toLowerCase() !== 'expense') return false;
    const amount = parsePositiveFinancialAmount(tx.amount);
    if (amount < 10) return false;
    const status = String(tx.status || '').toLowerCase();
    return !['deleted', 'cancelled', 'void'].includes(status);
  });
  const groups = new Map<string, any[]>();
  for (const tx of expenses) {
    const key = recurringCandidateKey(tx);
    if (!key) continue;
    const arr = groups.get(key) || [];
    arr.push(tx);
    groups.set(key, arr);
  }
  const candidates = Array.from(groups.entries())
    .filter(([, group]) => group.length >= minOccurrences)
    .map(([key, group]) => buildRecurringCandidate(group, key, safeNow))
    .filter(Boolean)
    .filter((candidate: any) => !existingKeys.has(candidate.detectionKey) && !existingTitleAmounts.has(`${normalizeArabicText(String(candidate.title || '')).toLowerCase()}:${roundMoney(candidate.amount)}`))
    .sort((a: any, b: any) => b.confidence - a.confidence || b.occurrenceCount - a.occurrenceCount)
    .slice(0, Math.max(1, Math.min(25, Number(args?.candidateLimit) || 10)));

  if (parseBooleanLike(args?.persistAlerts)) {
    for (const candidate of candidates.filter((c: any) => c.confidence >= 0.7).slice(0, 5)) {
      await addNotification(userId, `🔁 اكتشفت مصروفاً متكرراً: ${candidate.title} بقيمة تقريبية ${candidate.amount} ₪ (${candidate.frequency}). هل تريد تحويله لالتزام؟`, 'warning', adminDb, {
        idempotencyKey: `advisor-recurring-detected:${candidate.detectionKey}`,
        advisorAlert: true,
        advisorStatus: 'open',
        severity: candidate.confidence >= 0.85 ? 'warning' : 'info',
        priority: candidate.confidence >= 0.85 ? 'medium' : 'low',
        category: 'recurring_commitment_candidate',
        source: 'detectRecurringCommitments',
        metadata: { candidate },
        actions: [
          { id: 'create_commitment', label: 'حوّل لالتزام', type: 'create' },
          { id: 'ignore_recurring', label: 'ليس متكرراً', type: 'dismiss' },
          { id: 'snooze', label: 'ذكرني لاحقاً', type: 'snooze' },
        ],
      });
    }
  }

  return {
    success: true,
    candidates,
    count: candidates.length,
    summary: {
      scannedTransactions: transactions.length,
      scannedExpenses: expenses.length,
      groupedKeys: groups.size,
      existingRecurringCommitments: existingKeys.size,
    },
    partial: Boolean(partial || (existingSnap as any).partial),
    readEfficiency: { transactionDocsRead: transactions.length, transactionLimit: limit, commitmentDocsRead: existingCommitments.length, readSource },
  };
}

export async function reviewRecurringCommitments(args: any, userId: string, token: string) {
  const adminDb = getDb(token);
  const now = args?.now ? new Date(String(args.now)) : new Date();
  const safeNow = Number.isFinite(now.getTime()) ? now : new Date();
  const lookAheadDays = Math.max(1, Math.min(60, Number(args?.lookAheadDays) || 7));
  const limit = Math.max(20, Math.min(300, Number(args?.limit) || 150));
  const end = new Date(safeNow.getTime());
  end.setUTCDate(end.getUTCDate() + lookAheadDays);
  const todayKey = safeNow.toISOString().slice(0, 10);
  const endKey = end.toISOString().slice(0, 10);
  const snap = await adminDb.collection('commitments')
    .where('userId', '==', userId)
    .orderBy('dueDate', 'asc')
    .limit(limit)
    .get();
  const commitments = snap.docs.map((d: any) => ({ id: d.id, ...d.data() }));
  const activeRecurring = commitments.filter((c: any) => {
    const status = String(c.status || 'pending').toLowerCase();
    if (['paid', 'cancelled'].includes(status)) return false;
    // Do not hide real commitments just because old records were not tagged
    // with recurring=true. Bills such as phone/internet/family support still
    // need due-soon and overdue review if they have a dueDate.
    return Boolean(c.dueDate || c.recurring || c.recurringFrequency || c.recurringDetectionKey);
  });
  const dueSoon = activeRecurring.filter((c: any) => {
    const dueKey = auditDateKey(c.dueDate);
    return /^\d{4}-\d{2}-\d{2}$/.test(dueKey) && dueKey >= todayKey && dueKey <= endKey;
  });
  const overdue = activeRecurring.filter((c: any) => {
    const dueKey = auditDateKey(c.dueDate);
    return /^\d{4}-\d{2}-\d{2}$/.test(dueKey) && dueKey < todayKey;
  });

  if (parseBooleanLike(args?.persistAlerts)) {
    for (const commitment of [...overdue, ...dueSoon].slice(0, 20)) {
      const dueKey = auditDateKey(commitment.dueDate);
      const isOverdue = dueKey < todayKey;
      await addNotification(userId, `${isOverdue ? '🚨' : '🔔'} ${isOverdue ? 'التزام متكرر متأخر' : 'التزام متكرر قريب'}: ${commitment.title || 'التزام'} بقيمة ${commitment.amount || 0} ₪ موعده ${dueKey}.`, 'warning', adminDb, {
        idempotencyKey: `advisor-recurring-due:${commitment.id}:${dueKey}`,
        advisorAlert: true,
        advisorStatus: 'open',
        severity: isOverdue ? 'critical' : 'warning',
        priority: isOverdue ? 'high' : 'medium',
        category: 'recurring_commitment_due',
        source: 'reviewRecurringCommitments',
        metadata: { commitmentId: commitment.id, dueDate: dueKey, amount: commitment.amount, recurringFrequency: commitment.recurringFrequency },
        actions: [
          { id: 'mark_paid', label: 'تم السداد', type: 'resolve' },
          { id: 'snooze', label: 'ذكرني لاحقاً', type: 'snooze' },
          { id: 'review_commitment', label: 'راجع الالتزام', type: 'review' },
        ],
      });
    }
  }

  return {
    success: true,
    dueSoon,
    overdue,
    count: dueSoon.length + overdue.length,
    lookAheadDays,
    window: { start: todayKey, end: endKey },
    partial: Boolean((snap as any).partial || commitments.length >= limit),
    readEfficiency: { commitmentDocsRead: commitments.length, commitmentLimit: limit },
  };
}

export async function createRecurringCommitmentFromCandidate(args: any, userId: string, token: string) {
  const adminDb = getDb(token);
  const candidateArg = args?.candidate && typeof args.candidate === 'object' ? args.candidate : null;
  let candidate = candidateArg;
  if (!candidate && args?.detectionKey) {
    const detected = await detectRecurringCommitments({ limit: args.limit || 500, candidateLimit: 25 }, userId, token);
    candidate = (detected.candidates || []).find((c: any) => c.detectionKey === args.detectionKey || c.id === args.detectionKey);
  }
  if (!candidate && args?.title && args?.amount) {
    candidate = {
      title: args.title,
      amount: parsePositiveFinancialAmount(args.amount),
      frequency: normalizeRecurringCommitmentFrequency(args.frequency || args.recurringFrequency || 'monthly'),
      nextDueDate: args.dueDate || estimateNextRecurringDueDate(new Date(), normalizeRecurringCommitmentFrequency(args.frequency || args.recurringFrequency || 'monthly')),
      category: args.category || 'أقساط والتزامات',
      confidence: Number(args.confidence || 0.6),
      detectionKey: args.detectionKey || stableDocId(`manual-recurring:${userId}:${args.title}:${args.amount}`),
      sourceTransactionIds: Array.isArray(args.sourceTransactionIds) ? args.sourceTransactionIds : [],
    };
  }
  if (!candidate) return { success: false, needsClarification: true, reason: 'MISSING_RECURRING_CANDIDATE', message: 'حدد المصروف المتكرر أو أعطني اسم الالتزام والمبلغ.' };
  const frequency = normalizeRecurringCommitmentFrequency(candidate.frequency || args.frequency || args.recurringFrequency);
  const detectionKey = candidate.detectionKey || candidate.id || args.detectionKey || stableDocId(`manual-recurring:${userId}:${candidate.title}:${candidate.amount}:${frequency}`);
  const existingSnap = await adminDb.collection('commitments')
    .where('userId', '==', userId)
    .orderBy('dueDate', 'asc')
    .limit(300)
    .get()
    .catch(() => ({ docs: [], partial: true }));
  const normalizedCandidateTitle = normalizeArabicText(String(args.title || candidate.title || '')).toLowerCase();
  const candidateAmount = roundMoney(parsePositiveFinancialAmount(args.amount || candidate.amount));
  const duplicate = ((existingSnap as any).docs || []).map((d: any) => ({ id: d.id, ...d.data() })).find((c: any) => {
    const sameDetection = detectionKey && String(c.recurringDetectionKey || '') === String(detectionKey);
    const sameRecurringShape = Boolean(c.recurring) && normalizeArabicText(String(c.title || '')).toLowerCase() === normalizedCandidateTitle && roundMoney(parsePositiveFinancialAmount(c.amount)) === candidateAmount && normalizeRecurringCommitmentFrequency(c.recurringFrequency) === frequency;
    return sameDetection || sameRecurringShape;
  });
  if (duplicate) {
    return { success: true, duplicate: true, id: duplicate.id, commitment: duplicate, candidate, message: `هذا الالتزام المتكرر موجود مسبقاً: ${duplicate.title || candidate.title}.` };
  }
  const created = await createCommitment({
    title: args.title || candidate.title,
    amount: args.amount || candidate.amount,
    dueDate: args.dueDate || candidate.nextDueDate || estimateNextRecurringDueDate(new Date(), frequency),
    category: args.category || candidate.category || 'أقساط والتزامات',
    notes: args.notes || `تم إنشاؤه من اكتشاف مصروف متكرر بثقة ${candidate.confidence || 'غير محددة'}.`,
    recurring: true,
    recurringFrequency: frequency,
    recurringDetectionKey: detectionKey,
    recurringConfidence: candidate.confidence || 0.6,
    sourceTransactionIds: candidate.sourceTransactionIds || [],
  }, userId, token);
  return { ...created, candidate, message: `حوّلت ${created.commitment?.title || candidate.title} إلى التزام متكرر ${frequency}.` };
}

export async function updateCommitmentStatus(args: any, userId: string, token: string) {
  const adminDb = getDb(token);
  if (!args.id) return { success: false, error: 'Commitment ID is required' };
  const status = String(args.status || '').toLowerCase();
  if (!['pending', 'paid', 'cancelled'].includes(status)) {
    return { success: false, error: "status must be 'pending', 'paid', or 'cancelled'" };
  }
  const ref = adminDb.collection('commitments').doc(args.id);
  const snap = await ref.get();
  if (!snap.exists) return { success: false, error: 'الالتزام غير موجود.' };
  if (snap.data()?.userId !== userId) return { success: false, error: 'غير مصرح.' };
  await ref.update({ status, statusUpdatedAt: new Date().toISOString() });
  await addNotification(userId, `تم تحديث حالة التزام "${snap.data()?.title || args.id}" إلى ${status}.`, 'success', adminDb);
  return { success: true, status };
}

export async function deleteCommitment(args: any, userId: string, token: string) {
  const adminDb = getDb(token);
  if (!args.id) return { success: false, error: "Commitment ID is required" };
  const ref = adminDb.collection('commitments').doc(args.id);
  const snap = await ref.get();
  if (!snap.exists) return { success: false, error: "الالتزام غير موجود." };
  if (snap.data()?.userId !== userId) return { success: false, error: "غير مصرح بحذف هذا الالتزام." };
  await ref.delete();
  await addNotification(userId, "تم حذف الالتزام المجدول.", 'success', adminDb);
  return { success: true };
}

const TREASURER_PROFILE_DEFAULTS: any = {
  profileVersion: 2,
  monthlySalary: 0,
  salaryDay: null,
  salaryCycleStartDay: 27,
  salaryCycleEndDay: 26,
  cashReserveTarget: 0,
  minimumCashFloor: 0,
  criticalLiquidityFloor: 0,
  criticalCoverageDays: 14,
  warningCoverageDays: 21,
  dailySpendingLimit: 0,
  weeklySpendingLimit: 0,
  discretionaryMonthlyLimit: 0,
  essentialMonthlyEstimate: 0,
  debtLimitRatio: 1,
  maxDebtBalance: 0,
  dependentsCount: 0,
  householdSize: 1,
  savingsRateTarget: 10,
  strictness: 'balanced',
  currency: 'ILS',
  locale: 'Gaza/Palestine',
  marketRegion: { primary: 'Gaza', secondary: 'Palestine', allowGlobalReference: true },
  alertPreferences: {
    safeSpendPulse: true,
    budgetThresholdPct: 80,
    criticalBudgetThresholdPct: 100,
    commitments: true,
    debts: true,
    goals: true,
    marketWatch: true,
    audit: true,
    notificationTone: 'balanced',
  },
  protectedCategories: ['طعام ومشتريات منزل', 'فواتير والتزامات', 'صحة وعلاج', 'تعليم وتدريب'],
  restrictedCategories: [],
  financialPriorities: [],
  financialGoals: [],
  notes: '',
  createdAt: null,
  updatedAt: null,
};

function clampFinancialDay(value: any): number | null {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.max(1, Math.min(31, Math.round(n)));
}

function normalizeTreasurerStrictness(value: any) {
  const raw = normalizeArabicText(String(value || 'balanced')).toLowerCase();
  if (['strict', 'صارم', 'شديد', 'حازم'].includes(raw)) return 'strict';
  if (['gentle', 'خفيف', 'لين', 'مرن'].includes(raw)) return 'gentle';
  return 'balanced';
}

function normalizeTreasurerStringList(value: any, fallback: string[] = [], maxItems = 20): string[] {
  const arr = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[،,\n]/) : fallback;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of arr) {
    const item = String(raw || '').trim();
    if (!item || seen.has(item)) continue;
    seen.add(item);
    out.push(item.slice(0, 80));
    if (out.length >= maxItems) break;
  }
  return out;
}

function normalizeTreasurerPriorityList(value: any): any[] {
  const arr = Array.isArray(value) ? value : [];
  return arr.slice(0, 20).map((item: any, index: number) => {
    if (typeof item === 'string') return { title: item.slice(0, 120), priority: index + 1, status: 'active' };
    return {
      title: String(item?.title || item?.name || '').slice(0, 120),
      priority: Math.max(1, Math.min(20, Number(item?.priority) || index + 1)),
      targetAmount: parsePositiveFinancialAmount(item?.targetAmount),
      dueDate: item?.dueDate || '',
      status: String(item?.status || 'active'),
      notes: String(item?.notes || '').slice(0, 240),
    };
  }).filter((item: any) => item.title);
}

function normalizeTreasurerMarketRegion(value: any, fallback: any = TREASURER_PROFILE_DEFAULTS.marketRegion) {
  if (typeof value === 'string') return { ...fallback, primary: value || fallback.primary };
  const raw = value && typeof value === 'object' ? value : {};
  return {
    primary: String(raw.primary || fallback.primary || 'Gaza'),
    secondary: String(raw.secondary || fallback.secondary || 'Palestine'),
    allowGlobalReference: raw.allowGlobalReference === undefined ? Boolean(fallback.allowGlobalReference) : parseBooleanLike(raw.allowGlobalReference),
  };
}

function normalizeTreasurerAlertPreferences(value: any, fallback: any = TREASURER_PROFILE_DEFAULTS.alertPreferences) {
  const raw = value && typeof value === 'object' ? value : {};
  const threshold = Math.max(50, Math.min(99, Number(raw.budgetThresholdPct ?? fallback.budgetThresholdPct ?? 80) || 80));
  const critical = Math.max(threshold + 1, Math.min(150, Number(raw.criticalBudgetThresholdPct ?? fallback.criticalBudgetThresholdPct ?? 100) || 100));
  return {
    safeSpendPulse: raw.safeSpendPulse === undefined ? Boolean(fallback.safeSpendPulse) : parseBooleanLike(raw.safeSpendPulse),
    budgetThresholdPct: threshold,
    criticalBudgetThresholdPct: critical,
    commitments: raw.commitments === undefined ? Boolean(fallback.commitments) : parseBooleanLike(raw.commitments),
    debts: raw.debts === undefined ? Boolean(fallback.debts) : parseBooleanLike(raw.debts),
    goals: raw.goals === undefined ? Boolean(fallback.goals) : parseBooleanLike(raw.goals),
    marketWatch: raw.marketWatch === undefined ? Boolean(fallback.marketWatch) : parseBooleanLike(raw.marketWatch),
    audit: raw.audit === undefined ? Boolean(fallback.audit) : parseBooleanLike(raw.audit),
    notificationTone: String(raw.notificationTone || fallback.notificationTone || 'balanced'),
  };
}

function normalizeTreasurerProfile(raw: any = {}) {
  const profile: any = { ...TREASURER_PROFILE_DEFAULTS, ...(raw || {}) };
  profile.profileVersion = 2;
  profile.monthlySalary = parsePositiveFinancialAmount(profile.monthlySalary);
  profile.salaryDay = clampFinancialDay(profile.salaryDay);
  profile.salaryCycleStartDay = clampFinancialDay(profile.salaryCycleStartDay) || 27;
  profile.salaryCycleEndDay = clampFinancialDay(profile.salaryCycleEndDay) || 26;
  profile.cashReserveTarget = parsePositiveFinancialAmount(profile.cashReserveTarget);
  profile.minimumCashFloor = parsePositiveFinancialAmount(profile.minimumCashFloor);
  profile.criticalLiquidityFloor = parsePositiveFinancialAmount(profile.criticalLiquidityFloor);
  profile.criticalCoverageDays = Math.max(0, Math.min(90, Number(profile.criticalCoverageDays) || 14));
  profile.warningCoverageDays = Math.max(profile.criticalCoverageDays, Math.min(120, Number(profile.warningCoverageDays) || 21));
  profile.dailySpendingLimit = parsePositiveFinancialAmount(profile.dailySpendingLimit);
  profile.weeklySpendingLimit = parsePositiveFinancialAmount(profile.weeklySpendingLimit);
  profile.discretionaryMonthlyLimit = parsePositiveFinancialAmount(profile.discretionaryMonthlyLimit);
  profile.essentialMonthlyEstimate = parsePositiveFinancialAmount(profile.essentialMonthlyEstimate);
  profile.debtLimitRatio = Math.max(0, Math.min(5, Number(profile.debtLimitRatio) || 1));
  profile.maxDebtBalance = parsePositiveFinancialAmount(profile.maxDebtBalance);
  profile.dependentsCount = Math.max(0, Math.min(30, Math.round(Number(profile.dependentsCount) || 0)));
  profile.householdSize = Math.max(1, Math.min(40, Math.round(Number(profile.householdSize) || 1)));
  profile.savingsRateTarget = Math.max(0, Math.min(80, Number(profile.savingsRateTarget) || 0));
  profile.strictness = normalizeTreasurerStrictness(profile.strictness);
  profile.currency = String(profile.currency || 'ILS');
  profile.locale = String(profile.locale || 'Gaza/Palestine');
  profile.marketRegion = normalizeTreasurerMarketRegion(profile.marketRegion);
  profile.alertPreferences = normalizeTreasurerAlertPreferences(profile.alertPreferences);
  profile.protectedCategories = normalizeTreasurerStringList(profile.protectedCategories, TREASURER_PROFILE_DEFAULTS.protectedCategories, 30);
  profile.restrictedCategories = normalizeTreasurerStringList(profile.restrictedCategories, [], 30);
  const hasFinancialPriorities = Object.prototype.hasOwnProperty.call(raw || {}, 'financialPriorities');
  const hasFinancialGoals = Object.prototype.hasOwnProperty.call(raw || {}, 'financialGoals');
  profile.financialPriorities = normalizeTreasurerPriorityList(hasFinancialPriorities ? raw.financialPriorities : (raw?.priorities ?? profile.financialPriorities));
  profile.financialGoals = normalizeTreasurerPriorityList(hasFinancialGoals ? raw.financialGoals : (raw?.goals ?? profile.financialGoals));
  profile.notes = String(profile.notes || '').slice(0, 1000);
  return profile;
}

function buildTreasurerProfileCompleteness(profile: any) {
  const checks = [
    { key: 'monthlySalary', label: 'الراتب الشهري', ok: parsePositiveFinancialAmount(profile.monthlySalary) > 0, prompt: 'كم راتبك أو دخلك الشهري المتوقع؟' },
    { key: 'salaryDay', label: 'يوم الراتب', ok: Boolean(profile.salaryDay), prompt: 'في أي يوم ينزل الراتب عادة؟' },
    { key: 'cashReserveTarget', label: 'احتياطي الأمان', ok: parsePositiveFinancialAmount(profile.cashReserveTarget || profile.criticalLiquidityFloor || profile.minimumCashFloor) > 0, prompt: 'كم أقل مبلغ لازم يظل محمي كاحتياطي؟' },
    { key: 'debtLimitRatio', label: 'حد الدين المقبول', ok: Number(profile.debtLimitRatio) > 0 || parsePositiveFinancialAmount(profile.maxDebtBalance) > 0, prompt: 'ما أقصى دين مقبول كنسبة من دخلك أو كمبلغ؟' },
    { key: 'financialPriorities', label: 'الأولويات المالية', ok: Array.isArray(profile.financialPriorities) && profile.financialPriorities.length > 0, prompt: 'ما أهم أولوياتك المالية الآن؟' },
    { key: 'alertPreferences', label: 'تفضيلات التنبيه', ok: Boolean(profile.alertPreferences), prompt: 'هل تريد تنبيهات صارمة أم متوازنة أم لطيفة؟' },
  ];
  const missing = checks.filter(c => !c.ok).map(({ key, label, prompt }) => ({ key, label, prompt }));
  const score = Math.round((checks.length - missing.length) / checks.length * 100);
  return {
    score,
    status: score >= 85 ? 'ready' : score >= 55 ? 'partial' : 'needs_onboarding',
    missing,
    nextPrompt: missing[0]?.prompt || '',
  };
}

function buildTreasurerProfilePatch(args: any, existing: any = {}) {
  const patch: any = { profileVersion: 2, updatedAt: new Date().toISOString() };
  if (args.monthlySalary !== undefined || args.salary !== undefined || args.monthlyIncome !== undefined) patch.monthlySalary = parsePositiveFinancialAmount(args.monthlySalary ?? args.salary ?? args.monthlyIncome);
  if (args.salaryDay !== undefined || args.payday !== undefined) patch.salaryDay = clampFinancialDay(args.salaryDay ?? args.payday);
  if (args.salaryCycleStartDay !== undefined) patch.salaryCycleStartDay = clampFinancialDay(args.salaryCycleStartDay) || 27;
  if (args.salaryCycleEndDay !== undefined) patch.salaryCycleEndDay = clampFinancialDay(args.salaryCycleEndDay) || 26;
  if (args.cashReserveTarget !== undefined || args.reserveTarget !== undefined) patch.cashReserveTarget = parsePositiveFinancialAmount(args.cashReserveTarget ?? args.reserveTarget);
  if (args.minimumCashFloor !== undefined) patch.minimumCashFloor = parsePositiveFinancialAmount(args.minimumCashFloor);
  if (args.criticalLiquidityFloor !== undefined || args.liquidityFloor !== undefined) patch.criticalLiquidityFloor = parsePositiveFinancialAmount(args.criticalLiquidityFloor ?? args.liquidityFloor);
  if (args.criticalCoverageDays !== undefined) patch.criticalCoverageDays = Math.max(0, Math.min(90, Number(args.criticalCoverageDays) || 0));
  if (args.warningCoverageDays !== undefined) patch.warningCoverageDays = Math.max(0, Math.min(120, Number(args.warningCoverageDays) || 0));
  if (args.dailySpendingLimit !== undefined) patch.dailySpendingLimit = parsePositiveFinancialAmount(args.dailySpendingLimit);
  if (args.weeklySpendingLimit !== undefined) patch.weeklySpendingLimit = parsePositiveFinancialAmount(args.weeklySpendingLimit);
  if (args.discretionaryMonthlyLimit !== undefined) patch.discretionaryMonthlyLimit = parsePositiveFinancialAmount(args.discretionaryMonthlyLimit);
  if (args.essentialMonthlyEstimate !== undefined) patch.essentialMonthlyEstimate = parsePositiveFinancialAmount(args.essentialMonthlyEstimate);
  if (args.debtLimitRatio !== undefined) patch.debtLimitRatio = Math.max(0, Math.min(5, Number(args.debtLimitRatio) || 0));
  if (args.maxDebtBalance !== undefined || args.maxDebt !== undefined) patch.maxDebtBalance = parsePositiveFinancialAmount(args.maxDebtBalance ?? args.maxDebt);
  if (args.dependentsCount !== undefined || args.dependents !== undefined) patch.dependentsCount = Math.max(0, Math.min(30, Math.round(Number(args.dependentsCount ?? args.dependents) || 0)));
  if (args.householdSize !== undefined || args.familySize !== undefined) patch.householdSize = Math.max(1, Math.min(40, Math.round(Number(args.householdSize ?? args.familySize) || 1)));
  if (args.savingsRateTarget !== undefined) patch.savingsRateTarget = Math.max(0, Math.min(80, Number(args.savingsRateTarget) || 0));
  if (args.strictness !== undefined) patch.strictness = normalizeTreasurerStrictness(args.strictness);
  if (args.currency !== undefined) patch.currency = String(args.currency || 'ILS');
  if (args.locale !== undefined) patch.locale = String(args.locale || 'Gaza/Palestine');
  if (args.marketRegion !== undefined || args.marketPrimary !== undefined || args.marketSecondary !== undefined || args.allowGlobalReference !== undefined) {
    patch.marketRegion = normalizeTreasurerMarketRegion({
      ...(existing.marketRegion || {}),
      ...(typeof args.marketRegion === 'object' ? args.marketRegion : {}),
      primary: args.marketPrimary ?? (typeof args.marketRegion === 'string' ? args.marketRegion : undefined) ?? existing.marketRegion?.primary,
      secondary: args.marketSecondary ?? existing.marketRegion?.secondary,
      allowGlobalReference: args.allowGlobalReference ?? existing.marketRegion?.allowGlobalReference,
    }, existing.marketRegion || TREASURER_PROFILE_DEFAULTS.marketRegion);
  }
  if (args.alertPreferences !== undefined || args.notificationTone !== undefined || args.budgetThresholdPct !== undefined || args.criticalBudgetThresholdPct !== undefined) {
    patch.alertPreferences = normalizeTreasurerAlertPreferences({
      ...(existing.alertPreferences || {}),
      ...(args.alertPreferences && typeof args.alertPreferences === 'object' ? args.alertPreferences : {}),
      notificationTone: args.notificationTone ?? existing.alertPreferences?.notificationTone,
      budgetThresholdPct: args.budgetThresholdPct ?? existing.alertPreferences?.budgetThresholdPct,
      criticalBudgetThresholdPct: args.criticalBudgetThresholdPct ?? existing.alertPreferences?.criticalBudgetThresholdPct,
    }, existing.alertPreferences || TREASURER_PROFILE_DEFAULTS.alertPreferences);
  }
  if (args.protectedCategories !== undefined) patch.protectedCategories = normalizeTreasurerStringList(args.protectedCategories, existing.protectedCategories || TREASURER_PROFILE_DEFAULTS.protectedCategories, 30);
  if (args.restrictedCategories !== undefined || args.blockedCategories !== undefined) patch.restrictedCategories = normalizeTreasurerStringList(args.restrictedCategories ?? args.blockedCategories, existing.restrictedCategories || [], 30);
  if (args.financialPriorities !== undefined || args.priorities !== undefined) patch.financialPriorities = normalizeTreasurerPriorityList(args.financialPriorities ?? args.priorities);
  if (args.financialGoals !== undefined || args.goals !== undefined) patch.financialGoals = normalizeTreasurerPriorityList(args.financialGoals ?? args.goals);
  if (args.notes !== undefined) patch.notes = String(args.notes || '').slice(0, 1000);
  return patch;
}

export async function getTreasurerProfile(args: any, userId: string, token: string) {
  const adminDb = getDb(token);
  const ref = adminDb.collection('users').doc(userId).collection('treasurer').doc('profile');
  const snap = await ref.get();
  const profile = normalizeTreasurerProfile(snap.exists ? snap.data() : {});
  return { success: true, profile, completeness: buildTreasurerProfileCompleteness(profile) };
}

export async function updateTreasurerProfile(args: any, userId: string, token: string) {
  const adminDb = getDb(token);
  const ref = adminDb.collection('users').doc(userId).collection('treasurer').doc('profile');
  const snap = await ref.get();
  const existing = normalizeTreasurerProfile(snap.exists ? snap.data() : {});
  const patch = buildTreasurerProfilePatch(args || {}, existing);
  if (!snap.exists) patch.createdAt = new Date().toISOString();
  await ref.set({ ...existing, ...patch }, { merge: true });
  const profile = normalizeTreasurerProfile({ ...existing, ...patch });
  const completeness = buildTreasurerProfileCompleteness(profile);
  return { success: true, profile, completeness, message: completeness.status === 'ready' ? 'تم تحديث ملف أمين الصندوق وأصبح جاهزاً لاتخاذ قرارات أدق.' : `تم تحديث الملف. بقي ${completeness.missing.length} عنصر لتحسين دقة المستشار.` };
}

export async function getSavingsGoals(args: any, userId: string, token: string) {
  const adminDb = firebaseAdminDb;
  const now = args?.now ? new Date(String(args.now)) : new Date();
  const savingsCycle = getCurrentSalaryCycle(now);
  const [snap, txSnap] = await Promise.all([
    adminDb.collection('users').doc(userId).collection('savingsGoals').limit(100).get(),
    adminDb.collection('transactions')
      .where('userId', '==', userId)
      .where('date', '>=', savingsCycle.startIso)
      .where('date', '<', savingsCycle.endExclusiveIso)
      .limit(300)
      .get()
      .catch(() => ({ docs: [], partial: true }))
  ]);
  const txs = (txSnap as any).docs.map((d: any) => ({ id: d.id, ...d.data() }));
  const rawGoals = snap.docs.map((d: any) => ({ id: d.id, ...d.data() }))
    .sort((a: any, b: any) => String(a.dueDate || '').localeCompare(String(b.dueDate || '')));

  const goals = [];
  for (const goal of rawGoals) {
    let contributions: any[] = [];
    try {
      const contributionSnap = await adminDb.collection('users').doc(userId).collection('savingsGoals').doc(goal.id).collection('contributions')
        .where('createdAt', '>=', savingsCycle.startIso)
        .where('createdAt', '<', savingsCycle.endExclusiveIso)
        .limit(100)
        .get();
      contributions = contributionSnap.docs.map((d: any) => ({ id: d.id, ...d.data() }));
    } catch {}
    const plan = buildSavingsGoalPlan({
      goal,
      transactions: txs,
      contributions,
      now,
      period: { startIso: savingsCycle.startIso, endExclusiveIso: savingsCycle.endExclusiveIso, label: savingsCycle.name },
    });
    goals.push(plan);
    if (plan.alertLevel === 'critical') {
      await addNotification(userId, plan.alertMessage, 'danger', adminDb, {
        idempotencyKey: `savings-critical:${goal.id}:${savingsCycle.cycleId}`,
        metadata: { goalId: goal.id, monthlyRequired: plan.monthlyRequired, monthlyNetAvailable: plan.monthlyNetAvailable, salaryCycleId: savingsCycle.cycleId }
      });
    }
  }

  return {
    success: true,
    goals,
    salaryCycle: savingsCycle,
    partial: Boolean((snap as any).partial || (txSnap as any).partial || snap.docs.length >= 100 || txs.length >= 300),
    readEfficiency: { savingsGoalLimit: 100, transactionDocsRead: txs.length, transactionLimit: 300, salaryCycleId: savingsCycle.cycleId },
  };
}

export async function createSavingsGoal(args: any, userId: string, token: string) {
  const adminDb = firebaseAdminDb;
  const name = String(args.name || args.title || '').trim();
  const built = buildSavingsGoalRecord({
    userId,
    name,
    targetAmount: args.targetAmount || args.amount,
    savedAmount: args.savedAmount || args.initialAmount,
    dueDate: args.dueDate,
    durationMonths: args.durationMonths || args.months,
    priority: args.priority,
    notes: args.notes,
  });
  if (built.ok === false) return { success: false, needsClarification: true, reason: built.reason, message: built.message };
  const goal = built.goal as any;
  const docRef = adminDb.collection('users').doc(userId).collection('savingsGoals').doc();
  await docRef.set(goal);
  await addNotification(userId, `تم إنشاء هدف ادخار "${name}" بمبلغ ${goal.targetAmount} ₪. المطلوب شهرياً: ${goal.monthlyRequired || 0} ₪.`, 'success', adminDb);
  return { success: true, id: docRef.id, goal: { id: docRef.id, ...goal } };
}

export async function addSavingsContribution(args: any, userId: string, token: string) {
  const adminDb = firebaseAdminDb;
  const amount = parsePositiveFinancialAmount(args.amount);
  if (amount <= 0) return { success: false, needsClarification: true, reason: 'INVALID_SAVINGS_AMOUNT', message: 'كم المبلغ الذي تريد ادخاره؟' };
  const snap = await adminDb.collection('users').doc(userId).collection('savingsGoals').get();
  const goals = snap.docs.map((d: any) => ({ id: d.id, ...d.data() }));
  const explicitId = String(args.id || args.goalId || '').trim();
  const selection = explicitId
    ? selectSavingsGoalForContribution(goals.filter((g: any) => String(g.id) === explicitId), String(args.goalName || args.name || ''))
    : selectSavingsGoalForContribution(goals, args.goalName || args.name || args.title);
  if (selection.ok === false) {
    return { success: false, needsClarification: true, reason: selection.reason, options: selection.options, message: selection.message };
  }
  const id = String(selection.selected.id || explicitId);
  const cloudRef = firebaseAdminDb.collection('users').doc(userId).collection('savingsGoals').doc(id);
  const contributionRef = cloudRef.collection('contributions').doc();
  const now = new Date().toISOString();
  const txResult = await firebaseAdminDb.runTransaction(async (tx: any) => {
    const currentSnap = await tx.get(cloudRef as any);
    if (!currentSnap.exists) return { ok: false as const, reason: 'SAVINGS_GOAL_NOT_FOUND' };
    const current = currentSnap.data() || {};
    const targetAmount = parsePositiveFinancialAmount(current.targetAmount);
    const savedAmount = roundMoney(parsePositiveFinancialAmount(current.savedAmount) + amount);
    const status = savedAmount >= targetAmount ? 'completed' : (current.status || 'active');
    tx.set(contributionRef as any, { userId, goalId: id, amount, createdAt: now, notes: String(args.notes || '') });
    tx.update(cloudRef as any, { savedAmount, status, lastContributionAt: now, updatedAt: now });
    return { ok: true as const, goalName: String(current.name || 'هدف ادخار'), targetAmount, savedAmount, status };
  });
  if (!txResult.ok) return { success: false, error: 'هدف الادخار غير موجود.' };
  await addNotification(userId, `تمت إضافة ${amount} ₪ إلى هدف ادخار "${txResult.goalName}". المجموع الآن ${txResult.savedAmount} ₪.`, 'success', adminDb, {
    idempotencyKey: `savings-contribution:${id}:${amount}:${now}`,
    metadata: { goalId: id, amount }
  });
  return { success: true, id, savedAmount: txResult.savedAmount, status: txResult.status, remaining: Math.max(0, txResult.targetAmount - txResult.savedAmount) };
}

export async function updateSavingsGoal(args: any, userId: string, token: string) {
  const adminDb = firebaseAdminDb;
  const id = String(args.id || args.goalId || '').trim();
  if (!id) return { success: false, error: 'Savings goal id is required' };
  const ref = adminDb.collection('users').doc(userId).collection('savingsGoals').doc(id);
  const snap = await ref.get();
  if (!snap.exists) return { success: false, error: 'هدف الادخار غير موجود.' };
  const patch: any = { updatedAt: new Date().toISOString() };
  if (args.name || args.title) patch.name = String(args.name || args.title).trim();
  if (args.targetAmount !== undefined || args.amount !== undefined) patch.targetAmount = parsePositiveFinancialAmount(args.targetAmount || args.amount);
  if (args.savedAmount !== undefined) patch.savedAmount = parsePositiveFinancialAmount(args.savedAmount);
  if (args.dueDate !== undefined) patch.dueDate = args.dueDate || '';
  if (args.durationMonths !== undefined || args.months !== undefined) {
    const months = parsePositiveFinancialAmount(args.durationMonths ?? args.months);
    patch.durationMonths = months || null;
    patch.dueDate = months > 0 ? normalizeSavingsDueDate({ durationMonths: months }) : patch.dueDate || '';
  }
  if (args.priority !== undefined) patch.priority = args.priority;
  if (args.notes !== undefined) patch.notes = args.notes;
  if (args.status !== undefined) patch.status = args.status;
  const projected = { ...(snap.data() || {}), ...patch };
  patch.monthlyRequired = buildSavingsGoalPlan({ goal: projected }).monthlyRequired;
  await ref.update(patch);
  return { success: true, id, updated: patch };
}

const SALARY_CYCLE_TRANSACTION_QUERY_LIMIT = 2000;
const VAULT_HISTORY_DEFAULT_LIMIT = 12;
const VAULT_HISTORY_MAX_LIMIT = 60;
const VAULT_ADJUSTMENT_BOOTSTRAP_LIMIT = 1000;

function logFirestoreReadDiagnostics(event: string, meta: Record<string, any>) {
  try {
    const safeMeta = { ...meta };
    if (safeMeta.userId) {
      safeMeta.userHash = stableDocId(String(safeMeta.userId));
      delete safeMeta.userId;
    }
    delete safeMeta.transactions;
    delete safeMeta.docs;
    console.log('[firestore-read-diagnostics]', { event, ...safeMeta });
  } catch {
    // Diagnostics must never affect financial behavior.
  }
}

function summarizeTransactionsForTool(transactions: any[]) {
  const byCategory: Record<string, { count: number; totalAmount: number }> = {};
  const byType: Record<string, { count: number; totalAmount: number }> = {};
  for (const tx of transactions || []) {
    const amount = parsePositiveFinancialAmount(tx.amount);
    const category = String(tx.category || 'غير مصنف');
    const type = String(tx.type || 'unknown');
    byCategory[category] = byCategory[category] || { count: 0, totalAmount: 0 };
    byCategory[category].count += 1;
    byCategory[category].totalAmount = roundMoney(byCategory[category].totalAmount + amount);
    byType[type] = byType[type] || { count: 0, totalAmount: 0 };
    byType[type].count += 1;
    byType[type].totalAmount = roundMoney(byType[type].totalAmount + amount);
  }
  return { byCategory, byType };
}

async function readTransactionsForSalaryCycle(period: SalaryCyclePeriod, userId: string, token: string, limit = SALARY_CYCLE_TRANSACTION_QUERY_LIMIT) {
  const startedAt = Date.now();
  const boundedLimit = Math.max(1, Math.min(SALARY_CYCLE_TRANSACTION_QUERY_LIMIT, Number(limit) || SALARY_CYCLE_TRANSACTION_QUERY_LIMIT));

  // Do NOT issue userId + date range here. Firestore requires a composite
  // index for that shape, and the vault UI must work safely even before
  // firestore.indexes.json is deployed. This query is still bounded by one
  // salary cycle (27→26), never the full ledger. We filter ownership after
  // the bounded date read and mark the result partial if the broad date window
  // reaches the limit. We intentionally query both date-key strings and local
  // UTC instants because older rows may be stored as `YYYY-MM-DD`, ISO strings,
  // or timestamps that display as the local Gaza financial day.
  const docsById = new Map<string, any>();
  const queryStats: any[] = [];
  const localStartUtc = getFinancialLocalDayUtcStart(period.cycleStart);
  const localEndUtc = getFinancialLocalDayUtcStart(period.cycleEndExclusive);

  const runRangeQuery = async (label: string, startValue: any, endValue: any) => {
    try {
      const snap = await firebaseAdminDb.collection('transactions')
        .where('date', '>=', startValue)
        .where('date', '<', endValue)
        .limit(boundedLimit)
        .get();
      queryStats.push({ label, docsRead: snap.docs.length });
      for (const doc of snap.docs || []) docsById.set(doc.id, doc);
      return snap.docs.length >= boundedLimit;
    } catch (error: any) {
      queryStats.push({ label, error: error?.message || String(error) });
      return false;
    }
  };

  const limitHits = [
    await runRangeQuery('date_key_or_iso_string_range', period.cycleStart, period.cycleEndExclusive),
  ];
  if (localStartUtc && localEndUtc) {
    limitHits.push(await runRangeQuery('local_day_iso_utc_range', localStartUtc.toISOString(), localEndUtc.toISOString()));
    limitHits.push(await runRangeQuery('local_day_timestamp_range', localStartUtc, localEndUtc));
  }

  const broadDocs = Array.from(docsById.values());
  const transactions = broadDocs
    .filter((d: any) => d.data()?.userId === userId)
    .map((d: any) => ({ id: d.id, ...d.data() }))
    .filter((t: any) => {
      const key = transactionDateKey(t);
      return key >= period.cycleStart && key < period.cycleEndExclusive;
    })
    .sort((a: any, b: any) => transactionDateKey(a).localeCompare(transactionDateKey(b)));
  const limitReached = limitHits.some(Boolean);
  logFirestoreReadDiagnostics('salary_cycle_transactions_query', {
    userId,
    queryType: 'transactions_by_date_range_then_user_filter_no_composite_index_multi_storage_format',
    cycleId: period.cycleId,
    start: period.cycleStart,
    endExclusive: period.cycleEndExclusive,
    returnedDocs: transactions.length,
    scannedDateWindowDocs: broadDocs.length,
    queryStats,
    limit: boundedLimit,
    limitReached,
    durationMs: Date.now() - startedAt,
    fallback: false,
  });
  return { transactions, partial: limitReached, boundedFallback: false, error: '', limit: boundedLimit, limitReached, queryStats };
}

function calculateVaultLockAllocations(transactions: any[], targetVaultAmount: number) {
  const available = { cash: 0, palPay: 0 };
  for (const tx of transactions || []) {
    const amount = parsePositiveFinancialAmount(tx?.amount);
    if (!amount) continue;
    const type = String(tx?.type || '');
    const category = String(tx?.category || '');
    const transactionType = String(tx?.transactionType || '');
    if (transactionType === 'VAULT_LOCK' || transactionType === 'VAULT_RELEASE') continue;
    if (type === 'transfer') {
      const from = normalizeLedgerAccount(tx?.fromAccount || tx?.account);
      const to = normalizeLedgerAccount(tx?.toAccount);
      if (from === 'vault' || to === 'vault') continue;
      if (from === 'cash') available.cash = roundMoney(available.cash - amount);
      if (from === 'palPay') available.palPay = roundMoney(available.palPay - amount);
      if (to === 'cash') available.cash = roundMoney(available.cash + amount);
      if (to === 'palPay') available.palPay = roundMoney(available.palPay + amount);
      continue;
    }
    if (type === 'income') {
      const account = normalizeLedgerAccount(tx?.account);
      if (account === 'cash') available.cash = roundMoney(available.cash + amount);
      if (account === 'palPay') available.palPay = roundMoney(available.palPay + amount);
      continue;
    }
    if (type === 'expense') {
      if (transactionType === 'CREDIT_PURCHASE' || category === 'دين') continue;
      const account = normalizeLedgerAccount(tx?.account);
      if (account === 'cash') available.cash = roundMoney(available.cash - amount);
      if (account === 'palPay') available.palPay = roundMoney(available.palPay - amount);
    }
  }
  const cashAvailable = Math.max(0, roundMoney(available.cash));
  const palPayAvailable = Math.max(0, roundMoney(available.palPay));
  const target = Math.max(0, roundMoney(targetVaultAmount));
  const fromCash = Math.min(cashAvailable, target);
  const fromPalPay = Math.min(palPayAvailable, roundMoney(target - fromCash));
  return {
    cash: roundMoney(fromCash),
    palPay: roundMoney(fromPalPay),
    availableCash: cashAvailable,
    availablePalPay: palPayAvailable,
    totalAvailable: roundMoney(cashAvailable + palPayAvailable),
    lockedTotal: roundMoney(fromCash + fromPalPay),
    shortfall: roundMoney(Math.max(0, target - fromCash - fromPalPay)),
  };
}

function vaultLockTransactionForCycle(userId: string, period: SalaryCyclePeriod, sourceAccount: 'cash' | 'palPay', amount: number, now: string, existingCreatedAt?: string) {
  const sourceName = sourceAccount === 'palPay' ? 'PalPay' : 'نقدي';
  return {
    userId,
    amount: roundMoney(amount),
    type: 'transfer',
    account: sourceAccount,
    fromAccount: sourceAccount,
    toAccount: 'vault',
    category: 'تحويل للخزنة',
    subcategory: `إغلاق ${period.name} من ${sourceName}`,
    notes: `ترحيل فائض ${period.name} إلى الخزنة من ${sourceName}`,
    merchant: 'الخزنة',
    creditor: '',
    creditorKey: '',
    transactionType: 'VAULT_LOCK',
    salaryCycleId: period.cycleId,
    vaultCycleId: period.cycleId,
    necessity: '',
    date: `${period.cycleEnd}T23:59:00.000Z`,
    dateSource: 'salary_cycle_close',
    operationId: `vault_lock_${period.cycleId}_${sourceAccount}`,
    createdAt: existingCreatedAt || now,
    updatedAt: now,
  };
}

function normalizeAccountBalanceSnapshotForVault(data: any = {}) {
  const cash = roundMoney(Number(data.cash || 0));
  const palPay = roundMoney(Number(data.palPay || 0));
  const debt = roundMoney(Number(data.debt || 0));
  const vault = roundMoney(Number(data.vault || 0));
  return { cash, palPay, debt, vault, total: roundMoney(cash + palPay) };
}

function accountBalanceSnapshotPayloadForVault(userId: string, balances: any, source: string, extra: any = {}) {
  return {
    userId,
    cash: roundMoney(Number(balances.cash || 0)),
    palPay: roundMoney(Number(balances.palPay || 0)),
    debt: roundMoney(Number(balances.debt || 0)),
    vault: roundMoney(Number(balances.vault || 0)),
    total: roundMoney(Number(balances.cash || 0) + Number(balances.palPay || 0)),
    source,
    updatedAt: new Date().toISOString(),
    version: 2,
    ...extra,
  };
}

async function commitSalaryCycleAndVaultMeta(args: any, userId: string, period: SalaryCyclePeriod, summary: any, readResult: any) {
  const now = new Date().toISOString();
  const cycleRef = firebaseAdminDb.collection('users').doc(userId).collection('salaryCycles').doc(period.cycleId);
  const metaRef = firebaseAdminDb.collection('users').doc(userId).collection('meta').doc('savingsVault');
  const accountBalanceRef = firebaseAdminDb.collection('users').doc(userId).collection('meta').doc('accountBalances');
  const vaultLockRefs = {
    cash: firebaseAdminDb.collection('transactions').doc(stableDocId(`${userId}:vault_lock:${period.cycleId}:cash`)),
    palPay: firebaseAdminDb.collection('transactions').doc(stableDocId(`${userId}:vault_lock:${period.cycleId}:palPay`)),
  };

  return firebaseAdminDb.runTransaction(async (tx: any) => {
    const existingSnap = await tx.get(cycleRef as any);
    const metaSnap = await tx.get(metaRef as any);
    const accountBalanceSnap = await tx.get(accountBalanceRef as any);
    const existingCashLockSnap = await tx.get(vaultLockRefs.cash as any);
    const existingPalPayLockSnap = await tx.get(vaultLockRefs.palPay as any);
    const balanceBootstrapSnap = accountBalanceSnap.exists ? null : await tx.get(firebaseAdminDb.collection('transactions').where('userId', '==', userId).limit(5000) as any);
    if (balanceBootstrapSnap && ((balanceBootstrapSnap as any).docs || []).length >= 5000) throw new Error('ACCOUNT_BALANCE_BOOTSTRAP_LIMIT_REACHED');
    const existing = existingSnap.exists ? (existingSnap.data() || {}) : {};
    const previousVaultContribution = roundMoney(Number(existing.vaultContribution || 0));
    const explicitVaultLock = Boolean(args?.lockVault || args?.closeCycle || args?.transferToVault || args?.commitVault || args?.vaultLock || args?.finalize);
    const previouslyLocked = Boolean(previousVaultContribution > 0 || existing.vaultLedgerLocked || existingCashLockSnap.exists || existingPalPayLockSnap.exists);
    const shouldLockVault = explicitVaultLock || previouslyLocked;
    const requestedVaultContribution = shouldLockVault && period.status === 'closed' && summary.surplus > 0 ? roundMoney(summary.surplus) : 0;
    const vaultLockAllocation = calculateVaultLockAllocations(readResult.transactions, requestedVaultContribution);
    const nextVaultContribution = vaultLockAllocation.lockedTotal;
    const adjustmentDelta = roundMoney(nextVaultContribution - previousVaultContribution);
    let metaBootstrapCyclesRead = 0;
    let previousVaultBalance = roundMoney(Number(metaSnap.exists ? metaSnap.data()?.currentBalance : 0));
    if (!metaSnap.exists) {
      const bootstrapSnap = await tx.get(firebaseAdminDb.collection('users').doc(userId).collection('salaryCycles').limit(1000) as any);
      const adjustmentSnap = await tx.get(firebaseAdminDb.collection('users').doc(userId).collection('savingsVaultAdjustments').limit(VAULT_ADJUSTMENT_BOOTSTRAP_LIMIT) as any);
      const bootstrapDocs = (bootstrapSnap as any).docs || [];
      const adjustmentDocs = (adjustmentSnap as any).docs || [];
      if (bootstrapDocs.length >= 1000 || adjustmentDocs.length >= VAULT_ADJUSTMENT_BOOTSTRAP_LIMIT) {
        throw new Error('VAULT_META_BOOTSTRAP_LIMIT_REACHED');
      }
      metaBootstrapCyclesRead = bootstrapDocs.length;
      const manualAdjustmentsTotal = roundMoney(adjustmentDocs
        .map((d: any) => d.data())
        .reduce((sum: number, adjustment: any) => sum + Number(adjustment.amount || 0), 0));
      previousVaultBalance = roundMoney(manualAdjustmentsTotal + bootstrapDocs
        .map((d: any) => ({ id: d.id, ...d.data() }))
        .filter((cycle: any) => cycle.id !== period.cycleId && cycle.cycleId !== period.cycleId)
        .reduce((sum: number, cycle: any) => sum + Number(cycle.vaultContribution || 0), 0));
    }
    const currentBalance = roundMoney(previousVaultBalance + (metaSnap.exists ? adjustmentDelta : nextVaultContribution));
    const adjustments = Array.isArray(existing.adjustments) ? existing.adjustments.slice(-20) : [];
    if (Math.abs(adjustmentDelta) >= 0.005) {
      adjustments.push({
        at: now,
        reason: String(args?.reason || 'cycle_recalculation'),
        previousVaultContribution,
        newVaultContribution: nextVaultContribution,
        delta: adjustmentDelta,
      });
    }

    const existingLockTxs = {
      cash: existingCashLockSnap.exists ? { id: vaultLockRefs.cash.id, ...(existingCashLockSnap.data() || {}) } : null,
      palPay: existingPalPayLockSnap.exists ? { id: vaultLockRefs.palPay.id, ...(existingPalPayLockSnap.data() || {}) } : null,
    };
    const nextLockTxs = {
      cash: vaultLockAllocation.cash > 0 ? vaultLockTransactionForCycle(userId, period, 'cash', vaultLockAllocation.cash, now, existingLockTxs.cash?.createdAt) : null,
      palPay: vaultLockAllocation.palPay > 0 ? vaultLockTransactionForCycle(userId, period, 'palPay', vaultLockAllocation.palPay, now, existingLockTxs.palPay?.createdAt) : null,
    };
    const bootstrappedBalances = accountBalanceSnap.exists
      ? null
      : calculateBalances(((balanceBootstrapSnap as any)?.docs || []).map((d: any) => ({ id: d.id, ...d.data() })));
    const baseAccountBalances = accountBalanceSnap.exists
      ? normalizeAccountBalanceSnapshotForVault(accountBalanceSnap.data() || {})
      : normalizeAccountBalanceSnapshotForVault(bootstrappedBalances || {});
    const balanceAfterCashLock = addBalanceDelta(baseAccountBalances, transactionReplacementDelta(existingLockTxs.cash, nextLockTxs.cash));
    const nextAccountBalances = addBalanceDelta(balanceAfterCashLock, transactionReplacementDelta(existingLockTxs.palPay, nextLockTxs.palPay));

    const record = {
      userId,
      cycleId: period.cycleId,
      name: period.name,
      year: period.year,
      month: period.month,
      cycleStart: period.cycleStart,
      cycleEnd: period.cycleEnd,
      cycleEndExclusive: period.cycleEndExclusive,
      totalIncome: summary.totalIncome,
      realIncome: summary.totalIncome,
      totalInflow: summary.totalInflow,
      debtCashInflow: summary.debtCashInflow,
      totalExpense: summary.totalExpense,
      surplus: summary.surplus,
      vaultEligibleSurplus: summary.surplus,
      deficit: summary.surplus < 0 ? roundMoney(Math.abs(summary.surplus)) : 0,
      vaultContribution: nextVaultContribution,
      requestedVaultContribution,
      vaultLockShortfall: vaultLockAllocation.shortfall,
      vaultSourceBreakdown: {
        cash: vaultLockAllocation.cash,
        palPay: vaultLockAllocation.palPay,
        availableCash: vaultLockAllocation.availableCash,
        availablePalPay: vaultLockAllocation.availablePalPay,
      },
      vaultLedgerLocked: nextVaultContribution > 0,
      transferDate: nextVaultContribution > 0 ? (existing.transferDate || now) : null,
      transferSource: nextVaultContribution > 0 ? 'salary_cycle_surplus_locked_transfer' : null,
      status: period.status,
      calculatedAt: now,
      updatedAt: now,
      transactionCount: summary.transactionCount,
      incomeCount: summary.incomeCount,
      expenseCount: summary.expenseCount,
      transferCount: summary.transferCount,
      debtBorrowingCount: summary.debtBorrowingCount,
      debtCreated: summary.debtCreated,
      debtPaid: summary.debtPaid,
      debtPaymentLiquidityOutflow: summary.debtPaymentLiquidityOutflow,
      netDebtChange: summary.netDebtChange,
      sourceVersion: stableDocId(`${period.cycleId}:${summary.totalIncome}:${summary.totalInflow}:${summary.debtCashInflow}:${summary.totalExpense}:${summary.debtCreated}:${summary.debtPaid}:${summary.debtPaymentLiquidityOutflow}:${summary.transactionCount}:${nextVaultContribution}`),
      adjustments,
      cumulativeVaultBalance: currentBalance,
      readEfficiency: {
        boundedByDateRange: true,
        transactionDocsRead: readResult.transactions.length,
        transactionQueryLimit: readResult.limit,
        salaryCycleDocsRead: 1,
        metaDocsRead: 1,
        metaBootstrapCyclesRead,
        accountBalanceSnapshotRead: 1,
        accountBalanceBootstrapDocsRead: ((balanceBootstrapSnap as any)?.docs || []).length || 0,
        vaultLockDocsRead: 2,
        vaultLockDocsWritten: [nextLockTxs.cash, nextLockTxs.palPay].filter(Boolean).length,
        fallback: false,
        transactionalCommit: true,
      },
    };
    if (nextLockTxs.cash) tx.set(vaultLockRefs.cash as any, { ...nextLockTxs.cash, id: vaultLockRefs.cash.id }, { merge: false });
    else if (existingCashLockSnap.exists) tx.delete(vaultLockRefs.cash as any);
    if (nextLockTxs.palPay) tx.set(vaultLockRefs.palPay as any, { ...nextLockTxs.palPay, id: vaultLockRefs.palPay.id }, { merge: false });
    else if (existingPalPayLockSnap.exists) tx.delete(vaultLockRefs.palPay as any);
    tx.set(accountBalanceRef as any, accountBalanceSnapshotPayloadForVault(userId, nextAccountBalances, 'salary_cycle_vault_lock', {
      lastCycleId: period.cycleId,
      lastVaultLockAmount: nextVaultContribution,
      lastVaultLockCash: vaultLockAllocation.cash,
      lastVaultLockPalPay: vaultLockAllocation.palPay,
      accountBalanceReadSource: accountBalanceSnap.exists ? 'snapshot' : 'bootstrap_full_ledger',
      accountBalanceBootstrapDocsRead: ((balanceBootstrapSnap as any)?.docs || []).length || 0,
    }), { merge: true });
    tx.set(cycleRef as any, record, { merge: true });
    tx.set(metaRef as any, {
      userId,
      currentBalance,
      updatedAt: now,
      lastCycleId: period.cycleId,
      lastAdjustment: adjustmentDelta,
      source: 'salaryCycles',
      version: 2,
      transactionalCommit: true,
    }, { merge: true });
    return { record, currentBalance, delta: adjustmentDelta };
  });
}

export async function recalculateSalaryCycle(args: any, userId: string, token: string) {
  const hasExplicitCycleArg = Boolean(
    args?.__period || args?.cycleId || args?.id || args?.date || args?.transactionDate ||
    args?.salaryMonth || args?.month || args?.monthNumber || String(args?.period || '').trim() === 'previous'
  );
  const effectiveArgs = !hasExplicitCycleArg && (args?.activeSalaryCycleId || args?.activeSalaryCycleMonth)
    ? {
        ...(args || {}),
        cycleId: args?.activeSalaryCycleId || args?.cycleId,
        month: args?.activeSalaryCycleMonth || args?.month,
        year: args?.activeSalaryCycleYear || args?.year,
      }
    : args;
  const period: SalaryCyclePeriod = args?.__period || resolveSalaryCycleFromArgs(effectiveArgs || {}, new Date());
  const readResult = await readTransactionsForSalaryCycle(period, userId, token, args?.limit);
  if (readResult.partial || readResult.boundedFallback || readResult.limitReached) {
    return {
      success: false,
      retryable: true,
      partial: true,
      bounded: true,
      reason: readResult.limitReached ? 'SALARY_CYCLE_TRANSACTION_LIMIT_REACHED' : 'AUTHORITATIVE_FIRESTORE_READ_REQUIRED',
      message: readResult.limitReached
        ? 'لم أُحدّث الخزنة لأن عدد معاملات دورة الراتب وصل حد الاستعلام، ولا يمكن ضمان أن الفائض كامل. زِد الحد أو استخدم مسار تجميع موثوق قبل حفظ الخزنة.'
        : 'لم أُحدّث الخزنة لأن قراءة معاملات دورة الراتب لم تكن مؤكدة من Firestore. هذا يمنع تسجيل فائض غير صحيح من بيانات جزئية.',
      query: { collection: 'transactions', userId: 'current-user', date: { gte: period.startIso, lt: period.endExclusiveIso }, limit: readResult.limit },
    };
  }
  const summary = summarizeSalaryCycleTransactions(readResult.transactions);
  try {
    const committed = await commitSalaryCycleAndVaultMeta(args, userId, period, summary, readResult);
    return {
      success: true,
      salaryCycle: committed.record,
      vaultBalance: committed.currentBalance,
      adjustment: committed.delta,
      affectedCycleId: period.cycleId,
      affectedCycleIds: [period.cycleId],
      message: committed.record?.vaultContribution > 0
        ? `تم إقفال ${period.name} وترحيل ${Number(committed.record.vaultContribution || 0).toLocaleString()} ₪ إلى الخزنة.`
        : `تم تحديث ${period.name}. لا يوجد فائض موجب جديد لترحيله إلى الخزنة.`,
      partial: false,
      durability: 'committed',
      bounded: true,
      query: { collection: 'transactions', userId: 'current-user', date: { gte: period.startIso, lt: period.endExclusiveIso }, limit: readResult.limit },
    };
  } catch (commitErr: any) {
    return {
      success: false,
      retryable: true,
      partial: false,
      bounded: true,
      durability: 'failed',
      reason: 'VAULT_TRANSACTION_COMMIT_FAILED',
      message: 'تم حساب الدورة من Firestore، لكن لم أُحدّث الخزنة لأن commit الذري فشل. لم يتم حفظ رصيد خزنة غير مؤكد.',
      error: commitErr?.message || 'Savings Vault transaction commit failed',
      query: { collection: 'transactions', userId: 'current-user', date: { gte: period.startIso, lt: period.endExclusiveIso }, limit: readResult.limit },
    };
  }
}

function wantsCycleDebtSummary(args: any): boolean {
  const text = normalizeArabicText(`${args?.userText || ''} ${args?.currentUserText || ''} ${args?.question || ''} ${args?.category || ''} ${args?.account || ''} ${args?.type || ''}`);
  return text.includes('دين') || text.includes('ديون') || args?.account === 'debt' || args?.includeDebtSummary === true;
}

async function buildCurrentDebtSummaryForCycle(userId: string, cycleTransactions: any[]) {
  const cycleDebtTransactions = (cycleTransactions || []).filter((t: any) => {
    const kind = String(t.transactionType || '');
    return kind === 'CREDIT_PURCHASE'
      || kind === 'DEBT_PAYMENT'
      || normalizeLedgerAccount(t.account) === 'debt'
      || normalizeLedgerAccount(t.toAccount) === 'debt'
      || normalizeLedgerAccount(t.fromAccount) === 'debt';
  });
  const creditorKeys = Array.from(new Set(cycleDebtTransactions
    .map((t: any) => normalizeCreditorName(t.creditor || t.merchant || ''))
    .filter(Boolean)))
    .slice(0, 10);
  if (creditorKeys.length === 0) {
    return {
      creditorKeys: [],
      debtCreatedInCycle: 0,
      debtPaidInCycle: 0,
      currentRemainingForCycleCreditors: 0,
      creditors: [],
      partial: false,
      readEfficiency: { creditorHistoryDocsRead: 0, creditorLimit: 0 },
    };
  }

  let debtHistoryDocs: any[] = [];
  let partial = false;
  try {
    const snap = await firebaseAdminDb.collection('transactions')
      .where('userId', '==', userId)
      .where('creditorKey', 'in', creditorKeys)
      .limit(500)
      .get();
    partial = Boolean((snap as any).partial || snap.docs.length >= 500);
    debtHistoryDocs = snap.docs;
  } catch (err: any) {
    console.warn('[salary_cycle_debt_summary] compound creditor query failed; using per-creditor bounded fallback', { error: err?.message });
    for (const creditorKey of creditorKeys) {
      const snap = await firebaseAdminDb.collection('transactions')
        .where('creditorKey', '==', creditorKey)
        .limit(120)
        .get();
      if ((snap as any).partial || snap.docs.length >= 120) partial = true;
      debtHistoryDocs.push(...snap.docs.filter((d: any) => d.data()?.userId === userId));
    }
  }

  const currentDebtByCreditor = calculateOpenCreditorDebts(debtHistoryDocs);
  return {
    creditorKeys,
    debtCreatedInCycle: roundMoney(cycleDebtTransactions
      .filter((t: any) => String(t.transactionType || '') === 'CREDIT_PURCHASE' || (t.type === 'expense' && normalizeLedgerAccount(t.account) === 'debt') || String(t.transactionType || '') === 'DEBT_BORROWING')
      .reduce((sum: number, t: any) => sum + parsePositiveFinancialAmount(t.amount), 0)),
    debtPaidInCycle: roundMoney(cycleDebtTransactions
      .filter((t: any) => String(t.transactionType || '') === 'DEBT_PAYMENT' || (t.type === 'transfer' && normalizeLedgerAccount(t.toAccount) === 'debt'))
      .reduce((sum: number, t: any) => sum + parsePositiveFinancialAmount(t.amount), 0)),
    currentRemainingForCycleCreditors: roundMoney(currentDebtByCreditor.reduce((sum: number, item: any) => sum + Number(item.remaining || 0), 0)),
    creditors: currentDebtByCreditor,
    note: 'المتبقي الحالي يحسب تاريخ دائنين دورة الراتب كاملة، لذلك يعترف بالسداد الذي حدث بعد نهاية الدورة.',
    partial,
    readEfficiency: { cycleDebtTransactions: cycleDebtTransactions.length, creditorHistoryDocsRead: debtHistoryDocs.length, creditorLimit: 500 },
  };
}

async function recalculateCyclesForTransactionChange(userId: string, token: string, beforeTx: any | null, afterTx: any | null, reason: string) {
  const periods = new Map<string, SalaryCyclePeriod>();
  const now = new Date();
  for (const tx of [beforeTx, afterTx]) {
    const date = tx?.date || tx?.createdAt;
    if (!date) continue;
    const period = getSalaryCycleForDate(date, now);
    periods.set(period.cycleId, period);
  }
  const results = [];
  for (const period of periods.values()) {
    results.push(await recalculateSalaryCycle({ __period: period, reason }, userId, token));
  }
  return results;
}

export async function getSalaryCycleSummary(args: any, userId: string, token: string) {
  const userText = `${args?.userText || ''} ${args?.currentUserText || ''} ${args?.question || ''} ${args?.query || ''}`;
  const inferredMonth = parseSalaryCycleMonth(userText);
  const summaryArgs = inferredMonth && !parseSalaryCycleMonth(args?.salaryMonth ?? args?.month ?? args?.monthNumber)
    ? { ...(args || {}), month: inferredMonth }
    : args;
  const period: SalaryCyclePeriod = resolveSalaryCycleFromArgs(summaryArgs || {}, new Date());
  const first = await recalculateSalaryCycle({ ...(summaryArgs || {}), __period: period, reason: 'salary_cycle_summary_tool' }, userId, token);
  if (first.success && wantsCycleDebtSummary(summaryArgs)) {
    try {
      const debtRead = await readTransactionsForSalaryCycle(period, userId, token, args?.limit || 500);
      (first as any).debtSummary = await buildCurrentDebtSummaryForCycle(userId, debtRead.transactions);
    } catch (err: any) {
      (first as any).debtSummary = { partial: true, error: err?.message || 'debt summary unavailable' };
    }
  }
  const compareMonth = args?.compareToMonth || args?.secondMonth || args?.otherMonth;
  if (!compareMonth) return first;
  if (!first.success || !first.salaryCycle) {
    return {
      ...first,
      success: false,
      compareSkipped: true,
      reason: first.reason || 'FIRST_SALARY_CYCLE_UNAVAILABLE',
      message: first.message || 'تعذر حساب دورة الراتب الأولى، لذلك لم أجرِ المقارنة حتى لا أعرض فرقاً غير صحيح.',
    };
  }

  const firstPeriod = first.salaryCycle;
  const second = await recalculateSalaryCycle({ month: compareMonth, year: args?.compareToYear || args?.year, reason: 'salary_cycle_comparison_tool' }, userId, token);
  if (!second.success || !second.salaryCycle) {
    return {
      success: false,
      salaryCycle: firstPeriod,
      compareWith: second.salaryCycle || null,
      compareSkipped: true,
      reason: second.reason || 'SECOND_SALARY_CYCLE_UNAVAILABLE',
      message: second.message || 'تم حساب الدورة الأولى، لكن تعذر حساب دورة المقارنة من مصدر موثوق.',
      first,
      second,
      bounded: true,
    };
  }

  return {
    success: true,
    salaryCycle: firstPeriod,
    compareWith: second.salaryCycle,
    difference: {
      income: roundMoney(Number(firstPeriod.totalIncome || 0) - Number(second.salaryCycle.totalIncome || 0)),
      expense: roundMoney(Number(firstPeriod.totalExpense || 0) - Number(second.salaryCycle.totalExpense || 0)),
      surplus: roundMoney(Number(firstPeriod.surplus || 0) - Number(second.salaryCycle.surplus || 0)),
      vaultContribution: roundMoney(Number(firstPeriod.vaultContribution || 0) - Number(second.salaryCycle.vaultContribution || 0)),
    },
    vaultBalance: second.vaultBalance,
    bounded: true,
  };
}

function classifyCashTraceReason(tx: any, delta: any): string {
  const type = String(tx?.type || '');
  const transactionType = String(tx?.transactionType || '');
  const account = normalizeLedgerAccount(tx?.account);
  const fromAccount = normalizeLedgerAccount(tx?.fromAccount || tx?.account);
  const toAccount = normalizeLedgerAccount(tx?.toAccount);
  if (transactionType === 'CREDIT_PURCHASE' || (type === 'expense' && account === 'debt')) return 'شراء دين/آجل: يظهر كمصروف لكنه لا يخصم النقدي';
  if (transactionType === 'DEBT_PAYMENT' || (type === 'transfer' && toAccount === 'debt')) return 'سداد دين من السيولة';
  if (transactionType === 'VAULT_LOCK' || (type === 'transfer' && toAccount === 'vault')) return 'ترحيل/قفل خزنة';
  if (type === 'transfer' && fromAccount === 'cash') return `تحويل من النقدي إلى ${toAccount || 'حساب آخر'}`;
  if (type === 'transfer' && toAccount === 'cash') return `تحويل إلى النقدي من ${fromAccount || 'حساب آخر'}`;
  if (type === 'income' && delta.cash > 0) return 'دخل نقدي';
  if (type === 'expense' && delta.cash < 0) return 'مصروف نقدي';
  return 'أثر على النقدي';
}

function summarizeCashTrace(transactions: any[]) {
  const rows: any[] = [];
  let cashIn = 0;
  let cashOut = 0;
  let palPayIn = 0;
  let palPayOut = 0;
  let debtDelta = 0;
  let vaultDelta = 0;
  let ignoredDebtPurchases = 0;
  for (const tx of transactions || []) {
    const delta = txBalanceDelta(tx);
    const amount = parsePositiveFinancialAmount(tx?.amount);
    const affectsCashOrPalPay = delta.cash !== 0 || delta.palPay !== 0;
    const isDebtPurchase = String(tx?.transactionType || '') === 'CREDIT_PURCHASE' || (String(tx?.type || '') === 'expense' && normalizeLedgerAccount(tx?.account) === 'debt');
    if (delta.cash > 0) cashIn += delta.cash;
    if (delta.cash < 0) cashOut += Math.abs(delta.cash);
    if (delta.palPay > 0) palPayIn += delta.palPay;
    if (delta.palPay < 0) palPayOut += Math.abs(delta.palPay);
    debtDelta += delta.debt;
    vaultDelta += delta.vault;
    if (isDebtPurchase && delta.cash === 0 && delta.palPay === 0) ignoredDebtPurchases += amount;
    if (affectsCashOrPalPay || isDebtPurchase) {
      rows.push({
        id: tx.id,
        date: tx.date || tx.createdAt || '',
        createdAt: tx.createdAt || '',
        amount,
        type: tx.type || '',
        account: normalizeLedgerAccount(tx.account || ''),
        fromAccount: normalizeLedgerAccount(tx.fromAccount || ''),
        toAccount: normalizeLedgerAccount(tx.toAccount || ''),
        transactionType: tx.transactionType || '',
        category: tx.category || '',
        subcategory: tx.subcategory || '',
        merchant: tx.merchant || '',
        creditor: tx.creditor || '',
        notes: tx.notes || '',
        cashDelta: roundMoney(delta.cash),
        palPayDelta: roundMoney(delta.palPay),
        debtDelta: roundMoney(delta.debt),
        vaultDelta: roundMoney(delta.vault),
        reason: classifyCashTraceReason(tx, delta),
      });
    }
  }
  return {
    cashIn: roundMoney(cashIn),
    cashOut: roundMoney(cashOut),
    netCashDelta: roundMoney(cashIn - cashOut),
    palPayIn: roundMoney(palPayIn),
    palPayOut: roundMoney(palPayOut),
    netPalPayDelta: roundMoney(palPayIn - palPayOut),
    netLiquidDelta: roundMoney(cashIn - cashOut + palPayIn - palPayOut),
    debtDelta: roundMoney(debtDelta),
    vaultDelta: roundMoney(vaultDelta),
    ignoredDebtPurchases: roundMoney(ignoredDebtPurchases),
    rows,
    note: 'هذا التتبع يستخدم عمليات دورة الراتب فقط. مشتريات الدين تظهر كمصروفات لكنها لا تخصم من cash/PalPay. أي نقص في النقدي يظهر هنا كصف cashDelta سالب أو كاختلاف في snapshot الرصيد العام.',
  };
}

function summarizeCycleTransactionLists(transactions: any[]) {
  const income: any[] = [];
  const expenses: any[] = [];
  const transfers: any[] = [];
  const debtBorrowing: any[] = [];
  const debtPurchases: any[] = [];
  const byCategory: Record<string, { count: number; totalAmount: number }> = {};

  for (const tx of transactions || []) {
    const amount = parsePositiveFinancialAmount(tx.amount);
    const type = String(tx.type || '');
    const category = String(tx.category || 'غير مصنف');
    const transactionType = String(tx.transactionType || '');
    const item = {
      id: tx.id,
      date: tx.date || tx.createdAt || '',
      amount,
      type,
      account: normalizeLedgerAccount(tx.account || tx.toAccount || tx.fromAccount),
      category,
      subcategory: tx.subcategory || '',
      merchant: tx.merchant || '',
      notes: tx.notes || '',
      transactionType,
    };
    if (transactionType === 'DEBT_BORROWING') {
      debtBorrowing.push(item);
      continue;
    }
    if (type === 'transfer' || category === 'تحويل' || category === 'تحويل داخلي') {
      transfers.push(item);
      continue;
    }
    if (type === 'income') income.push(item);
    if (type === 'expense') {
      const isDebtPurchaseItem = transactionType === 'CREDIT_PURCHASE' || normalizeLedgerAccount(tx.account) === 'debt';
      if (isDebtPurchaseItem) debtPurchases.push({ ...item, creditor: tx.creditor || tx.merchant || '' });
      expenses.push(item);
      const categoryKey = isDebtPurchaseItem ? 'دين / مشتريات آجلة' : category;
      byCategory[categoryKey] = byCategory[categoryKey] || { count: 0, totalAmount: 0 };
      byCategory[categoryKey].count += 1;
      byCategory[categoryKey].totalAmount = roundMoney(byCategory[categoryKey].totalAmount + amount);
    }
  }
  return { income, expenses, transfers, debtBorrowing, debtPurchases, byCategory };
}

function incomeGuardRefForTransaction(userId: string, tx: any, now: Date) {
  if (String(tx?.type || '') !== 'income') return null;
  const amount = parsePositiveFinancialAmount(tx.amount);
  const account = normalizeAccount(tx.account || 'cash');
  const category = String(tx.category || 'دخل');
  const subcategory = String(tx.subcategory || '');
  const notes = String(tx.notes || '');
  const isSalary = /راتب|salary|قبض/i.test(`${category} ${subcategory} ${notes}`);
  if (isSalary) {
    const cycle = getSalaryCycleForDate(tx.date || tx.createdAt, now);
    return firebaseAdminDb.collection('users').doc(userId).collection('salaryIncomeGuards').doc(stableDocId(`${cycle.cycleId}:${account}:${amount}`));
  }
  const dateKey = String(tx.date || tx.createdAt || '').slice(0, 10);
  return firebaseAdminDb.collection('users').doc(userId).collection('incomeGuards').doc(stableDocId(`income:${dateKey}:${account}:${amount}:${category}:${subcategory}`));
}

export async function getSalaryCycleDetails(args: any, userId: string, token: string) {
  const period = resolveSalaryCycleFromArgs(args || {}, new Date());
  const detailLimit = Math.max(1, Math.min(SALARY_CYCLE_TRANSACTION_QUERY_LIMIT, Number(args?.limit) || 500));
  const [readResult, cycleSnap] = await Promise.all([
    readTransactionsForSalaryCycle(period, userId, token, detailLimit),
    firebaseAdminDb.collection('users').doc(userId).collection('salaryCycles').doc(period.cycleId).get(),
  ]);
  const summary = summarizeSalaryCycleTransactions(readResult.transactions);
  const lists = summarizeCycleTransactionLists(readResult.transactions);
  const cashTrace = summarizeCashTrace(readResult.transactions);
  const cycleDoc = cycleSnap.exists ? (cycleSnap.data() || {}) : null;
  const detailsPartial = Boolean(readResult.partial || readResult.limitReached);
  return {
    success: !detailsPartial,
    partial: detailsPartial,
    fallbackUsed: Boolean(readResult.boundedFallback),
    reason: readResult.limitReached ? 'SALARY_CYCLE_DETAILS_LIMIT_REACHED' : (readResult.partial ? 'SALARY_CYCLE_DETAILS_PARTIAL' : null),
    period,
    salaryCycle: cycleDoc ? { id: period.cycleId, ...cycleDoc } : null,
    summary,
    vaultContribution: roundMoney(Number(cycleDoc?.vaultContribution || 0)),
    cumulativeVaultBalance: roundMoney(Number(cycleDoc?.cumulativeVaultBalance || 0)),
    income: lists.income,
    expenses: lists.expenses,
    transfers: lists.transfers,
    debtBorrowing: lists.debtBorrowing,
    debtPurchases: lists.debtPurchases,
    cashTrace,
    byCategory: lists.byCategory,
    counts: {
      total: readResult.transactions.length,
      income: lists.income.length,
      expenses: lists.expenses.length,
      transfers: lists.transfers.length,
      debtBorrowing: lists.debtBorrowing.length,
      debtPurchases: lists.debtPurchases.length,
    },
    bounded: true,
    query: { collection: 'transactions', userId: 'current-user', date: { gte: period.startIso, lt: period.endExclusiveIso }, limit: readResult.limit },
    readEfficiency: { transactionDocsRead: readResult.transactions.length, salaryCycleDocsRead: 1, limit: readResult.limit },
  };
}

export async function deleteSalaryCycleTransactions(args: any, userId: string, token: string) {
  const confirmed = args?.confirm === true || args?.confirmation === 'DELETE_SALARY_CYCLE' || args?.confirmation === 'حذف دورة الراتب';
  const period = resolveSalaryCycleFromArgs(args || {}, new Date());
  if (!confirmed) {
    return {
      success: false,
      needsConfirmation: true,
      reason: 'DELETE_SALARY_CYCLE_REQUIRES_CONFIRMATION',
      message: `سيتم حذف معاملات دورة الراتب ${period.name} فقط (${period.cycleStart} → ${period.cycleEnd}). أرسل confirmation=DELETE_SALARY_CYCLE للتأكيد.`,
      period,
    };
  }
  const deleteLimit = Math.max(1, Math.min(430, Number(args?.limit) || 300));
  const readResult = await readTransactionsForSalaryCycle(period, userId, token, deleteLimit);
  if (readResult.partial || readResult.boundedFallback || readResult.limitReached) {
    return {
      success: false,
      retryable: true,
      partial: true,
      bounded: true,
      reason: readResult.limitReached ? 'SALARY_CYCLE_DELETE_LIMIT_REACHED' : 'AUTHORITATIVE_FIRESTORE_READ_REQUIRED',
      message: readResult.limitReached
        ? `الدورة تحتوي ${readResult.transactions.length} معاملة أو أكثر. لن أحذفها دفعة واحدة حتى لا نكسر الذرية. احذف على دفعات أصغر أو ارفع الحد بعد مراجعة.`
        : 'لن أحذف دورة راتب من قراءة غير مؤكدة من Firestore. هذا يمنع حذف بيانات خاطئة أو جزئية.',
      period,
      query: { collection: 'transactions', date: { gte: period.startIso, lt: period.endExclusiveIso }, limit: readResult.limit },
    };
  }
  const transactionIds = readResult.transactions.map((tx: any) => tx.id).filter(Boolean);
  if (transactionIds.length === 0) {
    const recalculated = await recalculateSalaryCycle({ __period: period, reason: 'delete_empty_salary_cycle_transactions' }, userId, token);
    return {
      success: true,
      period,
      deletedCount: 0,
      deletedTransactionIds: [],
      recalculated,
      bounded: true,
      message: 'هذه الدورة لا تحتوي معاملات للحذف.',
      query: { collection: 'transactions', date: { gte: period.startIso, lt: period.endExclusiveIso }, limit: readResult.limit },
    };
  }
  const now = new Date();
  const guardRefs = readResult.transactions.map((tx: any) => incomeGuardRefForTransaction(userId, tx, now)).filter(Boolean);
  const deleteResult = await atomicDeleteTransactions(userId, transactionIds, { guardRefs, reason: `delete_salary_cycle:${period.cycleId}` });
  if (!deleteResult.ok) {
    const failedDeleteResult = deleteResult as { ok: false; reason: string; found?: number; requested?: number };
    return { success: false, reason: failedDeleteResult.reason, period, found: failedDeleteResult.found, requested: failedDeleteResult.requested };
  }
  const recalculated = await recalculateSalaryCycle({ __period: period, reason: 'delete_salary_cycle_transactions' }, userId, token);
  return {
    success: true,
    period,
    deletedCount: transactionIds.length,
    deletedTransactionIds: transactionIds,
    balances: deleteResult.balances,
    recalculated,
    bounded: true,
    query: { collection: 'transactions', date: { gte: period.startIso, lt: period.endExclusiveIso }, limit: readResult.limit },
    readEfficiency: { transactionDocsRead: readResult.transactions.length, guardDocsDeleted: guardRefs.length, atomicTransactionReads: transactionIds.length + 1 },
  };
}

export async function addSavingsVaultAdjustment(args: any, userId: string, token: string) {
  const entries = normalizeVaultAdjustmentEntries(args);
  if (!entries.length) {
    return { success: false, needsClarification: true, reason: 'INVALID_VAULT_ADJUSTMENT_AMOUNT', message: 'كم المبلغ القديم/المرحل الذي تريد إضافته للخزنة؟ اذكر المبلغ والعملة مثل: 1000 شيكل، 300 دولار، 200 يورو.' };
  }

  await refreshExchangeRatesToIls();
  const convertedEntries = entries.map((entry: VaultAdjustmentEntry) => {
    const providedRate = Number(args?.exchangeRates?.[entry.currency] || args?.exchangeRates?.[entry.currency.toLowerCase()] || 0);
    const explicitRate = Number(args?.exchangeRate || args?.fxRate || 0);
    const manualRate = providedRate > 0 ? providedRate : explicitRate > 0 ? explicitRate : 0;
    const autoConvertedIls = normalizeCurrencyToIls(entry.amount, entry.currency);
    const normalizedAmountIls = entry.currency === 'ILS'
      ? entry.amount
      : manualRate > 0
        ? roundMoney(entry.amount * manualRate)
        : Number(autoConvertedIls || 0);
    return {
      ...entry,
      normalizedAmountIls: roundMoney(normalizedAmountIls),
      fx: manualRate > 0 ? { source: 'user_provided', rateToIls: manualRate } : getFxConversionMetadata(entry.currency),
    };
  });

  const missingFx = convertedEntries.find((entry: any) => entry.currency !== 'ILS' && (!Number.isFinite(Number(entry.normalizedAmountIls)) || Number(entry.normalizedAmountIls) <= 0));
  if (missingFx) {
    return { success: false, retryable: true, reason: 'VAULT_FX_RATE_UNAVAILABLE', message: `لا أستطيع حفظ ${missingFx.amount} ${missingFx.currency} في الخزنة الآن لأن سعر الصرف للشيكل غير متاح. أعطني سعر الصرف أو جرّب لاحقاً؛ لن أخزن قيمة مخترعة.` };
  }

  const source = String(args.source || args.reason || convertedEntries[0]?.source || 'manual_carryover').trim();
  const notes = String(args.notes || convertedEntries.map((e: any) => e.notes).filter(Boolean).join(' | ') || '').trim();
  const operationSeed = convertedEntries.map((e: any) => `${e.amount}:${e.currency}:${e.source}`).join('|');
  const operationId = String(args.operationId || `vault_adjustment_${source}_${operationSeed}_${args.date || new Date().toISOString().slice(0, 10)}`);
  const adjustmentId = stableDocId(`${userId}:savingsVaultAdjustment:${operationId}`);
  const adjustmentRef = firebaseAdminDb.collection('users').doc(userId).collection('savingsVaultAdjustments').doc(adjustmentId);
  const metaRef = firebaseAdminDb.collection('users').doc(userId).collection('meta').doc('savingsVault');
  const accountBalanceRef = firebaseAdminDb.collection('users').doc(userId).collection('meta').doc('accountBalances');
  const now = new Date().toISOString();
  const amountIlsEquivalent = roundMoney(convertedEntries.reduce((sum: number, entry: any) => sum + Number(entry.normalizedAmountIls || 0), 0));
  const currencyDelta = convertedEntries.reduce((map: Record<string, number>, entry: any) => addVaultCurrencyAmount(map, entry.currency, entry.amount), {} as Record<string, number>);

  const result = await firebaseAdminDb.runTransaction(async (tx: any) => {
    const [existingAdjustmentSnap, metaSnap, accountBalanceSnap] = await Promise.all([
      tx.get(adjustmentRef as any),
      tx.get(metaRef as any),
      tx.get(accountBalanceRef as any),
    ]);
    const metaData = metaSnap.exists ? (metaSnap.data() || {}) : {};
    const accountBalances = normalizeAccountBalanceSnapshotForVault(accountBalanceSnap.exists ? (accountBalanceSnap.data() || {}) : {});
    if (existingAdjustmentSnap.exists) {
      const existing = existingAdjustmentSnap.data() || {};
      return {
        replay: true,
        vaultBalance: roundMoney(Number(metaData.currentBalance ?? existing.cumulativeVaultBalance ?? amountIlsEquivalent)),
        vaultBalanceByCurrency: metaData.balanceByCurrency || existing.cumulativeBalanceByCurrency || {},
        adjustment: existing,
      };
    }
    const previousBalance = roundMoney(Number(metaData.currentBalance || 0));
    const previousByCurrency = (metaData.balanceByCurrency || {}) as Record<string, number>;
    const nextBalance = roundMoney(previousBalance + amountIlsEquivalent);
    const nextByCurrency = mergeVaultCurrencyDeltas(previousByCurrency, currencyDelta);
    const adjustment = {
      userId,
      amount: amountIlsEquivalent,
      amountIlsEquivalent,
      currency: convertedEntries.length === 1 ? convertedEntries[0].currency : 'MIXED',
      originalAmount: convertedEntries.length === 1 ? convertedEntries[0].amount : undefined,
      originalCurrency: convertedEntries.length === 1 ? convertedEntries[0].currency : undefined,
      entries: convertedEntries,
      currencyDelta,
      type: 'manual_carryover',
      source,
      notes,
      operationId,
      createdAt: now,
      updatedAt: now,
      affectsCash: false,
      affectsPalPay: false,
      affectsDebt: false,
      cumulativeVaultBalance: nextBalance,
      cumulativeBalanceByCurrency: nextByCurrency,
    };
    tx.set(adjustmentRef as any, adjustment);
    tx.set(accountBalanceRef as any, accountBalanceSnapshotPayloadForVault(userId, {
      ...accountBalances,
      vault: roundMoney(Number(accountBalances.vault || 0) + amountIlsEquivalent),
    }, 'manual_vault_carryover', {
      lastVaultAdjustmentId: adjustmentId,
      lastManualVaultDelta: amountIlsEquivalent,
      accountBalanceReadSource: accountBalanceSnap.exists ? 'snapshot' : 'empty_bootstrap',
    }), { merge: true });
    tx.set(metaRef as any, {
      userId,
      currentBalance: nextBalance,
      currentBalanceIlsEquivalent: nextBalance,
      balanceByCurrency: nextByCurrency,
      updatedAt: now,
      lastAdjustment: amountIlsEquivalent,
      lastAdjustmentEntries: convertedEntries,
      lastAdjustmentId: adjustmentId,
      source: 'salaryCycles+manualAdjustments',
      version: 5,
      transactionalCommit: true,
    }, { merge: true });
    return { replay: false, vaultBalance: nextBalance, vaultBalanceByCurrency: nextByCurrency, adjustment };
  });

  const details = convertedEntries.map((entry: any) => `${entry.amount} ${entry.currency}`).join(' + ');
  return {
    success: true,
    id: adjustmentId,
    idempotentReplay: result.replay,
    vaultBalance: result.vaultBalance,
    vaultBalanceByCurrency: result.vaultBalanceByCurrency,
    amountIlsEquivalent,
    adjustment: result.adjustment,
    message: result.replay ? 'هذا المبلغ المرحل محفوظ سابقاً ولم أكرره.' : `أضفت للخزنة: ${details}. المكافئ التقديري ${amountIlsEquivalent} ₪، بدون تغيير أرصدة الكاش أو PalPay أو الديون.`,
  };
}

export async function repairSavingsVaultMeta(args: any, userId: string, token: string) {
  const cycleLimit = Math.max(1, Math.min(1000, Number(args?.limit) || 1000));
  const now = new Date().toISOString();
  const adjustmentLimit = Math.max(1, Math.min(VAULT_ADJUSTMENT_BOOTSTRAP_LIMIT, Number(args?.adjustmentLimit) || VAULT_ADJUSTMENT_BOOTSTRAP_LIMIT));
  const [cyclesSnap, adjustmentsSnap] = await Promise.all([
    firebaseAdminDb.collection('users').doc(userId).collection('salaryCycles')
      .limit(cycleLimit)
      .get(),
    firebaseAdminDb.collection('users').doc(userId).collection('savingsVaultAdjustments')
      .limit(adjustmentLimit)
      .get(),
  ]);
  const cycles = cyclesSnap.docs.map((d: any) => ({ id: d.id, ...d.data() }));
  const manualAdjustments = adjustmentsSnap.docs.map((d: any) => ({ id: d.id, ...d.data() }));
  if ((cyclesSnap as any).partial || (adjustmentsSnap as any).partial || cycles.length >= cycleLimit || manualAdjustments.length >= adjustmentLimit) {
    return {
      success: false,
      retryable: true,
      partial: true,
      bounded: true,
      reason: 'VAULT_META_REPAIR_LIMIT_REACHED',
      message: 'لم أصلح رصيد الخزنة لأن عدد دورات الراتب أو تعديلات الخزنة وصل حد القراءة أو كانت القراءة جزئية. لن أحفظ رصيداً قد يكون ناقصاً.',
      readEfficiency: { salaryCycleDocsRead: cycles.length, vaultAdjustmentDocsRead: manualAdjustments.length, transactionDocsRead: 0, limit: cycleLimit, adjustmentLimit },
    };
  }
  const cycleVaultTotal = roundMoney(cycles.reduce((sum: number, c: any) => sum + Number(c.vaultContribution || 0), 0));
  const manualAdjustmentTotalIls = roundMoney(manualAdjustments.reduce((sum: number, a: any) => sum + Number(a.amountIlsEquivalent ?? a.amount ?? 0), 0));
  const repairedBalance = roundMoney(cycleVaultTotal + manualAdjustmentTotalIls);
  const repairedBalanceByCurrency = manualAdjustments.reduce(
    (map: Record<string, number>, adjustment: any) => mergeVaultCurrencyDeltas(map, deriveVaultAdjustmentCurrencyDelta(adjustment)),
    cycleVaultTotal > 0 ? { ILS: cycleVaultTotal } : {} as Record<string, number>,
  );
  const metaRef = firebaseAdminDb.collection('users').doc(userId).collection('meta').doc('savingsVault');
  await firebaseAdminDb.runTransaction(async (tx: any) => {
    tx.set(metaRef as any, {
      userId,
      currentBalance: repairedBalance,
      currentBalanceIlsEquivalent: repairedBalance,
      balanceByCurrency: repairedBalanceByCurrency,
      updatedAt: now,
      repairedAt: now,
      repairSource: 'salaryCycles+savingsVaultAdjustments',
      repairedCycleCount: cycles.length,
      repairedAdjustmentCount: manualAdjustments.length,
      source: 'salaryCycles+manualAdjustments',
      version: 5,
      transactionalCommit: true,
    }, { merge: true });
  });
  return {
    success: true,
    vaultBalance: repairedBalance,
    vaultBalanceByCurrency: repairedBalanceByCurrency,
    repairedCycleCount: cycles.length,
    repairedAdjustmentCount: manualAdjustments.length,
    bounded: true,
    readEfficiency: { salaryCycleDocsRead: cycles.length, vaultAdjustmentDocsRead: manualAdjustments.length, transactionDocsRead: 0, limit: cycleLimit, adjustmentLimit },
  };
}

export async function getSavingsVault(args: any, userId: string, token: string) {
  const adminDb = getDb(token);
  const limit = Math.max(1, Math.min(VAULT_HISTORY_MAX_LIMIT, Number(args?.limit) || VAULT_HISTORY_DEFAULT_LIMIT));
  const metaRef = adminDb.collection('users').doc(userId).collection('meta').doc('savingsVault');
  const adjustmentLimit = Math.max(1, Math.min(60, Number(args?.adjustmentLimit) || 12));
  const [metaSnap, cyclesSnap, adjustmentsSnap] = await Promise.all([
    metaRef.get(),
    adminDb.collection('users').doc(userId).collection('salaryCycles')
      .orderBy('cycleEnd', 'desc')
      .limit(limit)
      .get(),
    adminDb.collection('users').doc(userId).collection('savingsVaultAdjustments')
      .orderBy('createdAt', 'desc')
      .limit(adjustmentLimit)
      .get(),
  ]);
  const cycles = cyclesSnap.docs.map((d: any) => ({ id: d.id, ...d.data() }));
  const manualAdjustments = adjustmentsSnap.docs.map((d: any) => ({ id: d.id, ...d.data() }));
  const metaData = metaSnap.exists ? (metaSnap.data() || {}) : {};
  let vaultBalance = roundMoney(Number(metaData.currentBalance || 0) || 0);
  let vaultBalanceByCurrency: Record<string, number> = metaData.balanceByCurrency || {};
  let balanceSource = metaSnap.exists ? 'meta' : 'salaryCycles_bootstrap';
  let balanceCycleDocsRead = 0;
  let balanceAdjustmentDocsRead = 0;
  let balancePartial = false;
  let balanceLimitReached = false;
  if (!metaSnap.exists) {
    const [allCyclesSnap, allAdjustmentsSnap] = await Promise.all([
      adminDb.collection('users').doc(userId).collection('salaryCycles')
        .limit(1000)
        .get(),
      adminDb.collection('users').doc(userId).collection('savingsVaultAdjustments')
        .limit(VAULT_ADJUSTMENT_BOOTSTRAP_LIMIT)
        .get(),
    ]);
    const allCycles = allCyclesSnap.docs.map((d: any) => ({ id: d.id, ...d.data() }));
    const allAdjustments = allAdjustmentsSnap.docs.map((d: any) => ({ id: d.id, ...d.data() }));
    balanceCycleDocsRead = allCycles.length;
    balanceAdjustmentDocsRead = allAdjustments.length;
    balancePartial = Boolean((allCyclesSnap as any).partial || (allAdjustmentsSnap as any).partial);
    balanceLimitReached = balanceCycleDocsRead >= 1000 || balanceAdjustmentDocsRead >= VAULT_ADJUSTMENT_BOOTSTRAP_LIMIT;
    const cycleVaultTotal = roundMoney(allCycles.reduce((sum: number, c: any) => sum + Number(c.vaultContribution || 0), 0));
    vaultBalance = roundMoney(
      cycleVaultTotal
      + allAdjustments.reduce((sum: number, a: any) => sum + Number(a.amountIlsEquivalent ?? a.amount ?? 0), 0)
    );
    vaultBalanceByCurrency = allAdjustments.reduce(
      (map: Record<string, number>, adjustment: any) => mergeVaultCurrencyDeltas(map, deriveVaultAdjustmentCurrencyDelta(adjustment)),
      cycleVaultTotal > 0 ? { ILS: cycleVaultTotal } : {} as Record<string, number>,
    );
  }
  const currentCycle = getCurrentSalaryCycle(new Date());
  return {
    success: true,
    vaultBalance,
    vaultBalanceByCurrency,
    currentCycle,
    cycles,
    manualAdjustments,
    bounded: true,
    limit,
    adjustmentLimit,
    balanceSource,
    balanceNeedsMetaCommit: !metaSnap.exists,
    balanceLimitReached,
    partial: Boolean((metaSnap as any).partial || (cyclesSnap as any).partial || (adjustmentsSnap as any).partial || balancePartial || balanceLimitReached),
    readEfficiency: { metaDocsRead: 1, salaryCycleDocsRead: cycles.length, adjustmentDocsRead: manualAdjustments.length, balanceCycleDocsRead, balanceAdjustmentDocsRead, transactionDocsRead: 0 },
  };
}

export async function queryTransactions(args: any, userId: string, token: string) {
  console.log("TOOL CALL: queryTransactions", args);
  // Historical entry can create many documents quickly. Do not read the full
  // user ledger on every assistant turn; bounded Firestore reads prevent quota
  // exhaustion that leaves the UI stuck on "thinking".
  const startedAt = Date.now();
  const now = new Date();
  const detailsRequested = Boolean(args.includeTransactions || args.returnTransactions || args.details || args.includeDetails);
  const limit = Math.max(1, Math.min(detailsRequested ? 300 : 120, Number(args.limit) || (detailsRequested ? 120 : 80)));
  const period = String(args.period || '').trim();
  const explicitCalendarMonth = Boolean(args.calendarMonth || args.useCalendarMonth || /الشهر\s+الميلادي/i.test(String(args.userText || args.currentUserText || '')));
  let startIso = '';
  let endExclusiveIso = '';
  let salaryCyclePeriod: SalaryCyclePeriod | null = null;

  if (period === 'custom' && (!args.startDate || !args.endDate)) {
    return {
      success: false,
      needsClarification: true,
      reason: 'CUSTOM_PERIOD_REQUIRES_DATES',
      message: 'إذا كانت الفترة custom فلازم تحدد startDate و endDate بوضوح حتى لا أقرأ نطاقاً واسعاً من السجل.',
      bounded: true,
    };
  }

  const rawUserText = `${args.userText || ''} ${args.currentUserText || ''} ${args.question || ''} ${args.query || ''}`;
  const normalizedUserText = normalizeArabicText(rawUserText);
  const explicitDateKey = parseSmartDeleteDateKey(args.date ?? args.transactionDate ?? args.operationDate, now) || parseSmartDeleteDateKey(rawUserText, now);
  const salaryCycleWordsRequested = /دورة|راتب|salary\s*cycle|cycle/i.test(normalizedUserText);
  // Do not interpret the month part of an exact date (e.g. 30/8) as salary-cycle
  // month 8 unless the user actually asked for a salary cycle.
  const inferredMonthFromText = explicitDateKey && !salaryCycleWordsRequested ? null : parseSalaryCycleMonth(rawUserText);
  const inferredQueryType = !args.type && (normalizedUserText.includes('مصروف') || normalizedUserText.includes('مصروفات') || normalizedUserText.includes('مشتريات') || normalizedUserText.includes('صرف') || normalizedUserText.includes('اشتريت'))
    ? 'expense'
    : !args.type && (normalizedUserText.includes('دخل') || normalizedUserText.includes('راتب'))
      ? 'income'
      : '';
  const explicitSalaryCycleArgs = Boolean(args.salaryCycle || args.cycleId || args.salaryMonth || args.monthNumber || inferredMonthFromText);
  const periodRequestsSalaryCycle = period === 'salary_cycle'
    || period === 'current_salary_cycle'
    || period === 'previous_salary_cycle'
    || (period === 'this_month' && !explicitCalendarMonth);
  const monthRequested = parseSalaryCycleMonth(args.salaryMonth ?? args.month ?? args.monthNumber) !== null || inferredMonthFromText !== null;
  const exactDateShouldOverrideCycle = Boolean(explicitDateKey && !salaryCycleWordsRequested && !args.salaryCycle && !args.cycleId && !args.salaryMonth && !args.monthNumber);
  const salaryCycleRequested = !exactDateShouldOverrideCycle && (explicitSalaryCycleArgs
    || periodRequestsSalaryCycle
    || (monthRequested && !explicitCalendarMonth));

  if (salaryCycleRequested) {
    const cycleArgs = period === 'previous_salary_cycle'
      ? { ...(args || {}), period: 'previous' }
      : inferredMonthFromText && !parseSalaryCycleMonth(args.salaryMonth ?? args.month ?? args.monthNumber)
        ? { ...(args || {}), month: inferredMonthFromText }
        : args;
    salaryCyclePeriod = resolveSalaryCycleFromArgs(cycleArgs || {}, now);
    startIso = salaryCyclePeriod.startIso;
    endExclusiveIso = salaryCyclePeriod.endExclusiveIso;
  } else if (explicitDateKey) {
    startIso = explicitDateKey;
    endExclusiveIso = addDaysToDateKey(explicitDateKey, 1);
  } else if (period === 'today') {
    const today = now.toISOString().split('T')[0];
    startIso = `${today}T00:00:00.000Z`;
    const tomorrow = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
    endExclusiveIso = `${tomorrow.toISOString().slice(0, 10)}T00:00:00.000Z`;
  } else if (period === 'this_week') {
    startIso = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
  } else if (period === 'this_month') {
    const thisMonth = now.toISOString().slice(0, 7);
    startIso = `${thisMonth}-01T00:00:00.000Z`;
  } else if (args.startDate || args.endDate) {
    if (args.startDate) startIso = new Date(`${String(args.startDate).slice(0, 10)}T00:00:00.000Z`).toISOString();
    if (args.endDate) {
      const end = new Date(args.endDate);
      if (/^\d{4}-\d{2}-\d{2}$/.test(String(args.endDate))) {
        end.setUTCHours(0, 0, 0, 0);
        end.setUTCDate(end.getUTCDate() + 1);
      }
      endExclusiveIso = end.toISOString();
    }
  }

  let snapshot: any = { docs: [], partial: false };
  let boundedFallback = false;
  let filtered: any[] = [];

  if (salaryCyclePeriod) {
    // Salary-cycle reads must use the no-composite-index-safe reader shared by
    // the vault UI. The older userId+date+orderBy query could fall into
    // fallback:true and return 0 rows even though the cycle had transactions.
    const cycleRead = await readTransactionsForSalaryCycle(salaryCyclePeriod, userId, token, limit);
    filtered = cycleRead.transactions || [];
    snapshot = { docs: [], partial: cycleRead.partial, error: cycleRead.error || '', queryStats: cycleRead.queryStats || [] };
    boundedFallback = Boolean(cycleRead.boundedFallback);
  } else if (explicitDateKey) {
    // Exact day questions such as "شو في مصروفات بتاريخ 30/8" must use the
    // same local-day multi-format reader used by smart delete, otherwise rows
    // stored as UTC instants/Timestamps can be missed.
    const dayRead = await readTransactionsForSmartDeleteDate(explicitDateKey, userId, limit);
    filtered = dayRead.transactions || [];
    snapshot = { docs: [], partial: dayRead.limitReached, error: '', queryStats: dayRead.queryStats || [] };
    boundedFallback = false;
  } else {
    try {
      let q: any = firebaseAdminDb.collection('transactions').where('userId', '==', userId);
      if (startIso) q = q.where('date', '>=', startIso);
      if (endExclusiveIso) q = q.where('date', '<', endExclusiveIso);
      if (startIso || endExclusiveIso) q = q.orderBy('date', 'desc');
      q = q.limit(limit);
      const cloudSnap = await q.get();
      snapshot = { docs: cloudSnap.docs, partial: false };
    } catch (cloudErr: any) {
      try {
        // Keep fallbacks bounded by the same requested date window. A userId-only
        // fallback would be cheaper than a full scan but could still return the
        // wrong month for date-specific questions, so it is deliberately rejected.
        if (!startIso && !endExclusiveIso) throw cloudErr;
        const localDb = getDb(token);
        let fallbackQuery: any = localDb.collection('transactions').where('userId', '==', userId);
        if (startIso) fallbackQuery = fallbackQuery.where('date', '>=', startIso);
        if (endExclusiveIso) fallbackQuery = fallbackQuery.where('date', '<', endExclusiveIso);
        fallbackQuery = fallbackQuery.orderBy('date', 'desc').limit(limit);
        const fallbackSnap = await fallbackQuery.get();
        snapshot = {
          docs: fallbackSnap.docs || [],
          partial: true,
          error: cloudErr?.message || 'Firestore bounded transaction read failed',
        };
        boundedFallback = true;
      } catch (fallbackErr: any) {
        snapshot = {
          docs: [],
          partial: true,
          error: fallbackErr?.message || cloudErr?.message || 'Firestore transaction read failed',
        };
        boundedFallback = true;
      }
    }

    filtered = snapshot.docs.map((d: any) => ({ id: d.id, ...d.data() }));
  }
  const debtQuestionText = normalizeArabicText(`${args.userText || ''} ${args.currentUserText || ''} ${args.question || ''} ${args.query || ''} ${args.category || ''} ${args.account || ''} ${args.type || ''}`);
  const debtQueryRequested = Boolean(salaryCyclePeriod && (debtQuestionText.includes('دين') || debtQuestionText.includes('ديون') || args.account === 'debt'));
  
  const effectiveTypeFilter = debtQueryRequested ? '' : (args.type || inferredQueryType);
  if (effectiveTypeFilter) {
    filtered = filtered.filter((t: any) => t.type === effectiveTypeFilter);
  }

  if (args.category && args.category !== 'all' && args.category !== 'الكل' && args.category !== 'كافة البنود') {
    filtered = filtered.filter((t: any) => matchesArabicCategory(t, args.category));
  }

  if (args.account && !debtQueryRequested) {
    filtered = filtered.filter((t: any) => t.account === args.account);
  }

  if (args.necessity) {
    filtered = filtered.filter((t: any) => t.necessity === args.necessity);
  }

  if (explicitDateKey && !salaryCyclePeriod) {
    filtered = filtered.filter((t: any) => transactionDateKey(t) === explicitDateKey);
  } else if (!salaryCyclePeriod) {
    if (startIso) filtered = filtered.filter((t: any) => String(t.date || t.createdAt || '') >= startIso);
    if (endExclusiveIso) filtered = filtered.filter((t: any) => String(t.date || t.createdAt || '') < endExclusiveIso);
  }
  // Salary-cycle reads are already filtered by transactionDateKey inside
  // readTransactionsForSalaryCycle. Re-filtering here with String(t.date)
  // can erase valid rows stored as Firestore Timestamp objects, which made
  // "مصروفات الشهر هذا / دورة شهر 9" falsely return no expenses.

  filtered.sort((a: any, b: any) => (transactionAnalysisDate(b)?.getTime() || 0) - (transactionAnalysisDate(a)?.getTime() || 0));

  const total = roundMoney(filtered.reduce((sum, t: any) => sum + parsePositiveFinancialAmount(t.amount), 0));
  const summary = summarizeTransactionsForTool(filtered);
  const salaryCycleCashFlow = salaryCyclePeriod ? summarizeSalaryCycleTransactions(filtered) : null;
  const wantsDebtSummary = debtQueryRequested;
  let debtSummary: any = null;
  if (wantsDebtSummary) {
    const cycleDebtTransactions = filtered.filter((t: any) => {
      const kind = String(t.transactionType || '');
      return kind === 'CREDIT_PURCHASE' || kind === 'DEBT_PAYMENT' || normalizeLedgerAccount(t.account) === 'debt' || normalizeLedgerAccount(t.toAccount) === 'debt' || normalizeLedgerAccount(t.fromAccount) === 'debt';
    });
    const creditorKeys = Array.from(new Set(cycleDebtTransactions
      .map((t: any) => normalizeCreditorName(t.creditor || t.merchant || ''))
      .filter(Boolean)))
      .slice(0, 10);
    let debtHistoryDocs: any[] = [];
    let debtHistoryPartial = false;
    if (creditorKeys.length > 0) {
      try {
        const debtHistorySnap = await firebaseAdminDb.collection('transactions')
          .where('userId', '==', userId)
          .where('creditorKey', 'in', creditorKeys)
          .limit(500)
          .get();
        debtHistoryPartial = Boolean((debtHistorySnap as any).partial || debtHistorySnap.docs.length >= 500);
        debtHistoryDocs = debtHistorySnap.docs;
      } catch (debtHistoryErr: any) {
        console.warn('[query_transactions] creditor debt history compound query failed; using bounded per-creditor fallback', { error: debtHistoryErr?.message });
        const perCreditorDocs: any[] = [];
        for (const creditorKey of creditorKeys) {
          const creditorSnap = await firebaseAdminDb.collection('transactions')
            .where('creditorKey', '==', creditorKey)
            .limit(120)
            .get();
          if ((creditorSnap as any).partial || creditorSnap.docs.length >= 120) debtHistoryPartial = true;
          perCreditorDocs.push(...creditorSnap.docs.filter((d: any) => d.data()?.userId === userId));
        }
        debtHistoryDocs = perCreditorDocs;
      }
    }
    const currentDebtByCreditor = calculateOpenCreditorDebts(debtHistoryDocs);
    debtSummary = {
      creditorKeys,
      debtCreatedInCycle: roundMoney(cycleDebtTransactions
        .filter((t: any) => String(t.transactionType || '') === 'CREDIT_PURCHASE' || (t.type === 'expense' && normalizeLedgerAccount(t.account) === 'debt'))
        .reduce((sum: number, t: any) => sum + parsePositiveFinancialAmount(t.amount), 0)),
      debtPaidInCycle: roundMoney(cycleDebtTransactions
        .filter((t: any) => String(t.transactionType || '') === 'DEBT_PAYMENT' || (t.type === 'transfer' && normalizeLedgerAccount(t.toAccount) === 'debt'))
        .reduce((sum: number, t: any) => sum + parsePositiveFinancialAmount(t.amount), 0)),
      currentRemainingForCycleCreditors: roundMoney(currentDebtByCreditor.reduce((sum: number, item: any) => sum + Number(item.remaining || 0), 0)),
      creditors: currentDebtByCreditor,
      note: 'المتبقي الحالي يحسب تاريخ دائنين دورة الراتب كاملة، لذلك يعترف بالسداد الذي حدث بعد نهاية الدورة.',
      partial: debtHistoryPartial,
      readEfficiency: { cycleDebtTransactions: cycleDebtTransactions.length, creditorHistoryDocsRead: debtHistoryDocs.length, creditorLimit: 500 },
    };
  }
  logFirestoreReadDiagnostics('query_transactions', {
    userId,
    queryType: salaryCyclePeriod ? 'salary_cycle_transactions' : 'transactions_bounded',
    period: salaryCyclePeriod?.cycleId || period || 'bounded_default',
    start: startIso || null,
    endExclusive: endExclusiveIso || null,
    returnedDocs: filtered.length,
    limit,
    durationMs: Date.now() - startedAt,
    fallback: boundedFallback,
    queryStats: (snapshot as any).queryStats || undefined,
  });
  
  return { 
    success: true, 
    count: filtered.length,
    totalAmount: total,
    summary,
    transactions: detailsRequested ? filtered : undefined,
    omittedTransactions: detailsRequested ? 0 : filtered.length,
    salaryCycle: salaryCyclePeriod ? {
      cycleId: salaryCyclePeriod.cycleId,
      name: salaryCyclePeriod.name,
      cycleStart: salaryCyclePeriod.cycleStart,
      cycleEnd: salaryCyclePeriod.cycleEnd,
      status: salaryCyclePeriod.status,
      totalIncome: salaryCycleCashFlow?.totalIncome,
      totalInflow: salaryCycleCashFlow?.totalInflow,
      debtCashInflow: salaryCycleCashFlow?.debtCashInflow,
      totalExpense: salaryCycleCashFlow?.totalExpense,
      surplus: salaryCycleCashFlow?.surplus,
      debtSummary,
    } : undefined,
    debtSummary,
    period: { startIso: startIso || null, endExclusiveIso: endExclusiveIso || null },
    partial: (snapshot as any).partial,
    bounded: true,
    limit,
    boundedFallback
  };
}

export async function wipeAllUserData(userId: string, token: string) {
  // Root-cause fix: wipe must use the authoritative Admin Firestore client and
  // must not swallow errors. The previous implementation used getDb(token) and
  // empty catch blocks, so it could return success after deleting nothing.
  const adminDb = firebaseAdminDb;
  const deletedCounts: Record<string, number> = {};

  const deleteRefs = async (label: string, refs: any[]) => {
    deletedCounts[label] = (deletedCounts[label] || 0) + refs.length;
    let batch = adminDb.batch();
    let opCount = 0;
    for (const ref of refs) {
      batch.delete(ref);
      opCount += 1;
      if (opCount >= 450) {
        await batch.commit();
        batch = adminDb.batch();
        opCount = 0;
      }
    }
    if (opCount > 0) await batch.commit();
  };

  const deleteQuery = async (label: string, query: any) => {
    const snap = await query.get();
    if ((snap as any).partial === true) throw new Error(`WIPE_PARTIAL_READ:${label}`);
    await deleteRefs(label, snap.docs.map((d: any) => d.ref));
    return snap.docs.length;
  };

  const userDoc = adminDb.collection('users').doc(userId);

  await deleteQuery('transactions', adminDb.collection('transactions').where('userId', '==', userId));
  await deleteQuery('commitments', adminDb.collection('commitments').where('userId', '==', userId));
  await deleteQuery('reports', adminDb.collection('reports').where('userId', '==', userId));
  await deleteQuery('idempotency_keys', adminDb.collection('idempotency_keys').where('userId', '==', userId));
  await deleteQuery('receiptIdempotency', adminDb.collection('receiptIdempotency').where('userId', '==', userId));
  await deleteQuery('notifications', userDoc.collection('notifications'));
  await deleteQuery('memory', userDoc.collection('memory'));
  await deleteQuery('budgets', userDoc.collection('budgets'));
  await deleteQuery('marketDirectory', userDoc.collection('marketDirectory'));
  await deleteQuery('marketWatchlist', userDoc.collection('marketWatchlist'));
  await deleteQuery('advisorAudits', userDoc.collection('advisorAudits'));
  await deleteQuery('advisorScenarios', userDoc.collection('advisorScenarios'));
  await deleteQuery('advisorHabitReports', userDoc.collection('advisorHabitReports'));
  await deleteQuery('advisorWeeklyPlans', userDoc.collection('advisorWeeklyPlans'));
  await deleteQuery('advisorBudgetPlans', userDoc.collection('advisorBudgetPlans'));
  await deleteQuery('advisorMonthEndForecasts', userDoc.collection('advisorMonthEndForecasts'));
  await deleteQuery('advisorDailyPulses', userDoc.collection('advisorDailyPulses'));
  await deleteQuery('salaryCycles', userDoc.collection('salaryCycles'));
  await deleteQuery('salaryIncomeGuards', userDoc.collection('salaryIncomeGuards'));
  await deleteQuery('incomeGuards', userDoc.collection('incomeGuards'));
  await deleteQuery('savingsVaultAdjustments', userDoc.collection('savingsVaultAdjustments'));
  await deleteQuery('meta', userDoc.collection('meta'));
  await deleteQuery('treasurer', userDoc.collection('treasurer'));

  const savingsSnap = await userDoc.collection('savingsGoals').get();
  if ((savingsSnap as any).partial === true) throw new Error('WIPE_PARTIAL_READ:savingsGoals');
  for (const goalDoc of savingsSnap.docs) {
    await deleteQuery(`savingsGoals/${goalDoc.id}/contributions`, goalDoc.ref.collection('contributions'));
  }
  await deleteRefs('savingsGoals', savingsSnap.docs.map((d: any) => d.ref));

  const verify = async (label: string, query: any) => {
    const snap = await query.limit(1).get();
    return [label, snap.docs.length] as const;
  };
  const remainingEntries = await Promise.all([
    verify('transactions', adminDb.collection('transactions').where('userId', '==', userId)),
    verify('commitments', adminDb.collection('commitments').where('userId', '==', userId)),
    verify('reports', adminDb.collection('reports').where('userId', '==', userId)),
    verify('idempotency_keys', adminDb.collection('idempotency_keys').where('userId', '==', userId)),
    verify('receiptIdempotency', adminDb.collection('receiptIdempotency').where('userId', '==', userId)),
    verify('notifications', userDoc.collection('notifications')),
    verify('memory', userDoc.collection('memory')),
    verify('budgets', userDoc.collection('budgets')),
    verify('savingsGoals', userDoc.collection('savingsGoals')),
    verify('marketDirectory', userDoc.collection('marketDirectory')),
    verify('marketWatchlist', userDoc.collection('marketWatchlist')),
    verify('advisorAudits', userDoc.collection('advisorAudits')),
    verify('advisorScenarios', userDoc.collection('advisorScenarios')),
    verify('advisorHabitReports', userDoc.collection('advisorHabitReports')),
    verify('advisorWeeklyPlans', userDoc.collection('advisorWeeklyPlans')),
    verify('advisorBudgetPlans', userDoc.collection('advisorBudgetPlans')),
    verify('advisorMonthEndForecasts', userDoc.collection('advisorMonthEndForecasts')),
    verify('advisorDailyPulses', userDoc.collection('advisorDailyPulses')),
    verify('salaryCycles', userDoc.collection('salaryCycles')),
    verify('salaryIncomeGuards', userDoc.collection('salaryIncomeGuards')),
    verify('incomeGuards', userDoc.collection('incomeGuards')),
    verify('savingsVaultAdjustments', userDoc.collection('savingsVaultAdjustments')),
    verify('meta', userDoc.collection('meta')),
    verify('treasurer', userDoc.collection('treasurer')),
  ]);
  const remaining = Object.fromEntries(remainingEntries);
  const verifiedEmpty = Object.values(remaining).every((count) => Number(count) === 0);
  if (!verifiedEmpty) {
    throw new Error(`WIPE_VERIFICATION_FAILED:${JSON.stringify(remaining)}`);
  }

  clearAllLocalUserData(userId);

  return {
    success: true,
    verifiedEmpty: true,
    deletedCounts,
    remaining,
    message: "تم مسح وتصفير كافة البيانات من النظام والذاكرة والسحابة بنجاح."
  };
}

export async function generateTreasurerReport(args: any, userId: string, token: string) {
  const adminDb = getDb(token);
  console.log('TOOL CALL: generateTreasurerReport', args);
  const now = new Date();
  const rawTimeframe = String(args?.timeframe || args?.period || 'month');
  const calendarMonthRequested = args?.calendarMonth === true || String(args?.calendarMonth || '').toLowerCase() === 'true';
  const hasExplicitTreasurerMonth = args?.month !== undefined && args?.month !== null && String(args.month).trim() !== '';
  const timeframe = !calendarMonthRequested && (rawTimeframe === 'this_month' || rawTimeframe === 'month')
    ? (hasExplicitTreasurerMonth ? 'salary_cycle' : 'current_salary_cycle')
    : rawTimeframe;
  if (timeframe === 'all' && !args?.allowFullLedgerReport) {
    return {
      success: false,
      needsConfirmation: true,
      reason: 'FULL_LEDGER_REPORT_REQUIRES_CONFIRMATION',
      message: 'تقرير كل التاريخ يحتاج قراءة واسعة. حدد شهر/أسبوع/يوم أو أكد صراحة أنك تريد تقرير كل السجل.',
    };
  }
  let startIso = '';
  let endExclusiveIso = now.toISOString();
  let salaryCycleForTreasurer: SalaryCyclePeriod | null = null;
  if (timeframe === 'current_salary_cycle' || timeframe === 'salary_cycle') {
    const treasurerMonthFromText = parseSalaryCycleMonth(`${args?.title || ''} ${args?.userText || ''} ${args?.currentUserText || ''} ${args?.query || ''} ${args?.question || ''}`);
    salaryCycleForTreasurer = resolveSalaryCycleFromArgs({
      ...args,
      ...(treasurerMonthFromText && !hasExplicitTreasurerMonth ? { month: treasurerMonthFromText } : {}),
      period: timeframe === 'current_salary_cycle' && !treasurerMonthFromText ? undefined : args.period,
    }, now);
    startIso = salaryCycleForTreasurer.startIso;
    endExclusiveIso = salaryCycleForTreasurer.endExclusiveIso;
  } else if (timeframe === 'today') {
    const today = now.toISOString().slice(0, 10);
    const tomorrow = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
    startIso = `${today}T00:00:00.000Z`;
    endExclusiveIso = `${tomorrow.toISOString().slice(0, 10)}T00:00:00.000Z`;
  } else if (timeframe === 'week') {
    startIso = new Date(now.getTime() - 7 * 86400000).toISOString();
  } else if (timeframe === 'month') {
    const thisMonth = now.toISOString().slice(0, 7);
    const nextMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
    startIso = `${thisMonth}-01T00:00:00.000Z`;
    endExclusiveIso = `${nextMonth.toISOString().slice(0, 10)}T00:00:00.000Z`;
  } else if (args?.startDate && args?.endDate) {
    startIso = new Date(`${String(args.startDate).slice(0, 10)}T00:00:00.000Z`).toISOString();
    const end = new Date(`${String(args.endDate).slice(0, 10)}T00:00:00.000Z`);
    end.setUTCDate(end.getUTCDate() + 1);
    endExclusiveIso = end.toISOString();
  }

  const treasurerReadLimit = SALARY_CYCLE_TRANSACTION_QUERY_LIMIT;
  const [budgets, savingsSnap] = await Promise.all([
    getUserBudgets(userId, adminDb),
    adminDb.collection('users').doc(userId).collection('savingsGoals').limit(100).get().catch(() => ({ docs: [] }))
  ]);
  let txs: any[] = [];
  let treasurerReadPartial = false;
  let treasurerQueryStats: any[] = [];
  if (salaryCycleForTreasurer) {
    // Use the same salary-cycle reader as query_transactions/vault. Direct
    // userId+date range reads can miss rows stored as date keys or Firestore
    // Timestamps and made "أكثر مصروفات دورة شهر 9" falsely return empty.
    const cycleRead = await readTransactionsForSalaryCycle(salaryCycleForTreasurer, userId, token, treasurerReadLimit);
    txs = cycleRead.transactions || [];
    treasurerReadPartial = Boolean(cycleRead.partial || cycleRead.limitReached);
    treasurerQueryStats = cycleRead.queryStats || [];
  } else {
    let txQuery: any = adminDb.collection('transactions').where('userId', '==', userId);
    if (startIso) txQuery = txQuery.where('date', '>=', startIso);
    if (endExclusiveIso && timeframe !== 'all') txQuery = txQuery.where('date', '<', endExclusiveIso);
    if (timeframe !== 'all') txQuery = txQuery.limit(treasurerReadLimit);
    const txSnapshot = await txQuery.get();
    treasurerReadPartial = Boolean((txSnapshot as any).partial === true || (timeframe !== 'all' && txSnapshot.docs.length >= treasurerReadLimit));
    txs = txSnapshot.docs.map((d: any) => ({ id: d.id, ...d.data() }));
  }
  const savingsGoals = (savingsSnap as any).docs.map((d: any) => ({ id: d.id, ...d.data() }));
  const reportArgs = salaryCycleForTreasurer
    ? {
        ...args,
        timeframe: 'custom',
        period: 'custom',
        startDate: startIso.slice(0, 10),
        endDate: new Date(new Date(endExclusiveIso).getTime() - 86400000).toISOString().slice(0, 10),
        prefiltered: true,
        title: args?.title || `تحليل دورة راتب ${salaryCycleForTreasurer.name}`,
      }
    : { ...args, timeframe };
  const report = buildTreasurerReport(reportArgs, txs, budgets, savingsGoals);
  if (args?.save !== false) {
    const reportRef = adminDb.collection('reports').doc();
    await reportRef.set({
      userId,
      type: 'treasurer',
      title: report.title,
      content: JSON.stringify(report, null, 2),
      data: report,
      createdAt: new Date().toISOString(),
      readEfficiency: { timeframe, startIso: startIso || null, endExclusiveIso: timeframe === 'all' ? null : endExclusiveIso, transactionDocsRead: txs.length, limit: treasurerReadLimit, partial: treasurerReadPartial, queryStats: treasurerQueryStats, savingsGoalLimit: 100 }
    });
    return { success: true, reportId: reportRef.id, report, partial: treasurerReadPartial, readEfficiency: { transactionDocsRead: txs.length, limit: treasurerReadLimit, partial: treasurerReadPartial, timeframe, queryStats: treasurerQueryStats }, message: treasurerReadPartial ? 'أنشأت التقرير/التحليل بالبيانات المقروءة ضمن الحد الآمن، ولم أرفض الطلب بسبب كثرة البيانات.' : undefined };
  }
  return { success: true, report, partial: treasurerReadPartial, readEfficiency: { transactionDocsRead: txs.length, limit: treasurerReadLimit, partial: treasurerReadPartial, timeframe, queryStats: treasurerQueryStats }, message: treasurerReadPartial ? 'أنشأت التحليل بالبيانات المقروءة ضمن الحد الآمن، ولم أرفض الطلب بسبب كثرة البيانات.' : undefined };
}

// In-memory cache to guard against rapid duplicate tool calls
const recentMutations = new Map<string, { result: any; timestamp: number }>();

function getMutationKey(name: string, args: any, userId: string): string {
  const cleanArgs: any = {};
  for (const k of Object.keys(args || {}).sort()) {
    // Ignore volatile creation timestamps only. Transaction date is part of the
    // user's intent for add/update/delete, so it must remain in the mutation key.
    if (k === 'createdAt') continue;
    if (args[k] !== undefined && args[k] !== null && args[k] !== '') {
      cleanArgs[k] = typeof args[k] === 'number' ? Math.round(args[k] * 100) / 100 : String(args[k]).trim().toLowerCase();
    }
  }
  // For money transfers or debts or transactions, ensure amount and accounts create a strong deduplication key
  return `${userId}:${name}:${JSON.stringify(cleanArgs)}`;
}

function wrapWithDeduplication(name: string, fn: (args: any, userId: string, token: string) => Promise<any>) {
  const mutatingTools = ['add_transaction', 'transfer_money', 'pay_debt', 'send_palpay_payment', 'create_commitment', 'detect_recurring_commitments', 'review_recurring_commitments', 'create_recurring_commitment_from_candidate', 'delete_transaction', 'delete_recent_transactions', 'update_transaction', 'repair_misrouted_vault_close', 'repair_misrecorded_credit_purchase', 'repair_duplicate_income', 'repair_duplicate_credit_purchase', 'repair_account_balance_snapshot', 'update_treasurer_profile', 'create_savings_goal', 'add_savings_contribution', 'update_savings_goal', 'recalculate_salary_cycle', 'add_savings_vault_adjustment', 'repair_savings_vault_meta', 'save_market_offer', 'create_market_watch_item', 'update_market_watch_item', 'review_market_watchlist', 'simulate_financial_scenario', 'apply_adaptive_budget_plan', 'update_advisor_alert'];
  if (!mutatingTools.includes(name)) return fn;

  return async (args: any, userId: string, token: string) => {
    // V6 (CF-6): persistent idempotency via Firestore. The args may carry an
    // explicit operationId (preferred). If absent, derive one from args hash
    // so duplicate identical calls within a short window still dedupe.
    const operationId = args?.operationId
      || `${name}_${getMutationKey(name, args, userId)}`;
    return runIdempotent(userId, operationId, () => fn(args, userId, token)).then(outcome => {
      if (outcome.kind === 'cache_hit') return outcome.cachedResult;
      return outcome.result;
    });
  };
}

const rawToolHandlers: Record<string, (args: any, userId: string, token: string) => Promise<any>> = {
  add_transaction: addTransaction,
  update_transaction: updateTransaction,
  delete_transaction: deleteTransaction,
  delete_recent_transactions: deleteRecentTransactions,
  repair_misrouted_vault_close: repairMisroutedVaultClose,
  repair_misrecorded_credit_purchase: repairMisrecordedCreditPurchase,
  repair_duplicate_income: repairDuplicateIncome,
  repair_duplicate_credit_purchase: repairDuplicateCreditPurchase,
  repair_account_balance_snapshot: repairAccountBalanceSnapshot,
  get_balance: getBalance,
  get_financial_decision_context: getFinancialDecisionContext,
  get_safe_spending_limit: getSafeSpendingLimit,
  assess_financial_goal_impact: assessFinancialGoalImpact,
  simulate_financial_scenario: simulateFinancialScenario,
  get_financial_scenarios: getFinancialScenarios,
  analyze_financial_habits: analyzeFinancialHabits,
  get_financial_habit_reports: getFinancialHabitReports,
  generate_weekly_financial_recommendations: generateWeeklyFinancialRecommendations,
  get_weekly_financial_recommendations: getWeeklyFinancialRecommendations,
  generate_adaptive_budget_plan: generateAdaptiveBudgetPlan,
  get_adaptive_budget_plans: getAdaptiveBudgetPlans,
  apply_adaptive_budget_plan: applyAdaptiveBudgetPlan,
  forecast_month_end_financial_position: forecastMonthEndFinancialPosition,
  get_month_end_forecasts: getMonthEndForecasts,
  generate_daily_financial_pulse: generateDailyFinancialPulse,
  get_daily_financial_pulses: getDailyFinancialPulses,
  get_advisor_alerts: getAdvisorAlerts,
  update_advisor_alert: updateAdvisorAlert,
  assess_purchase: assessPurchase,
  search_local_market: searchLocalMarket,
  get_market_directory: getMarketDirectory,
  create_market_watch_item: createMarketWatchItem,
  get_market_watchlist: getMarketWatchlist,
  update_market_watch_item: updateMarketWatchItem,
  review_market_watchlist: reviewMarketWatchlist,
  save_market_offer: saveMarketOffer,
  transfer_money: transferMoney,
  pay_debt: payDebt,
  get_recent_transactions: getRecentTransactions,
  getRecentTransactions: getRecentTransactions,
  audit_financial_duplicates: auditFinancialDuplicates,
  run_financial_audit: runFinancialAudit,
  check_budget_status: checkBudgetStatus,
  set_category_budget: setCategoryBudget,
  get_budgets_overview: getBudgetsOverview,
  get_commitments: getCommitments,
  create_commitment: createCommitment,
  detect_recurring_commitments: detectRecurringCommitments,
  review_recurring_commitments: reviewRecurringCommitments,
  create_recurring_commitment_from_candidate: createRecurringCommitmentFromCandidate,
  update_commitment_status: updateCommitmentStatus,
  delete_commitment: deleteCommitment,
  get_treasurer_profile: getTreasurerProfile,
  update_treasurer_profile: updateTreasurerProfile,
  get_savings_goals: getSavingsGoals,
  create_savings_goal: createSavingsGoal,
  add_savings_contribution: addSavingsContribution,
  update_savings_goal: updateSavingsGoal,
  get_savings_vault: getSavingsVault,
  get_salary_cycle_summary: getSalaryCycleSummary,
  get_salary_cycle_details: getSalaryCycleDetails,
  delete_salary_cycle_transactions: deleteSalaryCycleTransactions,
  recalculate_salary_cycle: recalculateSalaryCycle,
  add_savings_vault_adjustment: addSavingsVaultAdjustment,
  repair_savings_vault_meta: repairSavingsVaultMeta,
  query_transactions: queryTransactions,
  // Gemini Live logs/normalizes some tool names as camelCase. Keep aliases only
  // for report/read tools so scope guards and handlers behave identically.
  queryTransactions: queryTransactions,
  memory_save: memorySave,
  memory_search: memorySearch,
  memorySearch: memorySearch,
  create_recurring_item: createRecurringItem,
  search_market_information: searchMarketInformation,
  send_palpay_payment: sendPalPayPayment,
  generate_report: generateReport,
  generateReport: generateReport,
  generate_treasurer_report: generateTreasurerReport,
  generateTreasurerReport: generateTreasurerReport,
  delete_report: deleteReport,
  deleteReport: deleteReport,
  clear_all_reports: clearAllReports
};

export const toolHandlers: Record<string, (args: any, userId: string, token: string) => Promise<any>> = Object.fromEntries(
  Object.entries(rawToolHandlers).map(([name, fn]) => [name, wrapWithDeduplication(name, fn)])
);

export const functionDeclarations = [
  {
    name: "pay_debt",
    description: "يسدد ديناً قائماً لدائن محدد. السداد العادي بدون تاريخ يسجل بتاريخ اليوم. إذا قال المستخدم من رصيد شهر/دورة معيّنة، أو لدورة شهر معيّن، أو بتاريخ/لحظة الدين، فهذا طلب تسوية تاريخية: مرّر salaryMonth/fromSalaryCycleBalance/useDebtDate أو date كي تُسجل عملية السداد داخل دورة الراتب المقصودة لا دورة اليوم. إذا كان لدى المستخدم أكثر من دائن ولم يحدد لمن السداد، لا تخمن ولا تنفذ: اسأل لمن يريد السداد. اسأل أيضاً عن حساب الدفع إن لم يذكره. لا تستخدم add_transaction لسداد الديون.",
    parameters: {
      type: "object",
      properties: {
        amount: { type: "number", description: "المبلغ المسدد بالشيكل" },
        paymentMethod: { type: "string", description: "طريقة السداد والحساب المدفوع منه: 'cash' (نقداً/كاش) أو 'palPay' (محفظة بال باي)" },
        creditor: { type: "string", description: "اسم الدائن كما ذكره المستخدم؛ لا تخمن الاسم عند وجود أكثر من دائن." },
        date: { type: "string", description: "تاريخ السداد الصريح إذا ذكره المستخدم بصيغة YYYY-MM-DD أو تاريخ مفهوم" },
        salaryMonth: { type: "number", description: "رقم شهر دورة الراتب المقصودة إذا قال المستخدم من رصيد شهر 8 أو لدورة أغسطس؛ دورة الشهر تبدأ 27 من الشهر السابق وتنتهي 26 من نفس الشهر" },
        salaryYear: { type: "number", description: "سنة دورة الراتب إن ذكرها المستخدم" },
        fromSalaryCycleBalance: { type: "boolean", description: "true إذا قال المستخدم من رصيد شهر/دورة معيّنة، أي تسوية تاريخية لا سداد اليوم" },
        useDebtDate: { type: "boolean", description: "true إذا قال بتاريخ الدين أو لحظة الدين أو وقت الدين" },
        paymentDateMode: { type: "string", description: "current إذا كان السداد اليوم، historical إذا كان تسوية من دورة قديمة أو بتاريخ الدين" },
        operationId: { type: "string", description: "معرف ثابت اختياري للعملية عند إعادة المحاولة أو المزامنة" },
        userText: { type: "string", description: "النص الأصلي للمستخدم لتحسين فهم شهر الدورة وتاريخ السداد" },
        notes: { type: "string", description: "ملاحظات إضافية عن سداد الدين" }
      },
      required: ["amount", "paymentMethod"]
    }
  },
  {
    name: "delete_report",
    description: "يحذف تقريراً مالياً محفوظاً من حافظة المهام للمستخدم لتجنب تراكم وتكدس التقارير.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "معرف التقرير المراد حذفه" }
      },
      required: ["id"]
    }
  },
  {
    name: "clear_all_reports",
    description: "يمسح ويحذف كافة التقارير المحفوظة في حافظة المهام دفعة واحدة لمنع تكدسها.",
    parameters: {
      type: "object",
      properties: {}
    }
  },
  {
    name: "set_category_budget",
    description: "يحدد أو يعدل سقف الميزانية الشهرية لبند رئيسي معين (مثال: الأبناء 1500 شيكل، طعام ومشتريات 2000 شيكل).",
    parameters: {
      type: "object",
      properties: {
        category: { type: "string", description: "اسم البند الرئيسي (مثال: 'الأبناء', 'طعام ومشتريات منزل', 'زيارات وضيافة', 'مواصلات')" },
        limit: { type: "number", description: "سقف الميزانية الشهري بالشيكل" }
      },
      required: ["category", "limit"]
    }
  },
  {
    name: "create_commitment",
    description: "يجدول موعد استحقاق التزام مالي أو دين أو قسط أو رسوم جامعية أو فاتورة دورية لتذكير المستخدم بها.",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: "اسم الالتزام أو القسط (مثال: قسط جامعة، إيجار البيت، دين تاجر)" },
        amount: { type: "number", description: "المبلغ المطلوب سداده بالشيكل" },
        dueDate: { type: "string", description: "تاريخ الاستحقاق بصيغة YYYY-MM-DD" },
        category: { type: "string", description: "التصنيف" }
      },
      required: ["title", "amount", "dueDate"]
    }
  },
  {
    name: "detect_recurring_commitments",
    description: "يفحص آخر العمليات المالية بقراءة محدودة لاكتشاف مصاريف متكررة مثل اشتراك، إيجار، إنترنت، فاتورة أو قسط، ويقترح تحويلها إلى التزامات متكررة. لا يحولها تلقائياً إلا إذا طلب المستخدم ذلك.",
    parameters: {
      type: "object",
      properties: {
        limit: { type: "number", description: "عدد العمليات المقروءة، الافتراضي 500 والأقصى 1000" },
        minOccurrences: { type: "number", description: "أقل عدد تكرارات لاكتشاف النمط" },
        candidateLimit: { type: "number", description: "عدد المرشحات المرجعة" },
        persistAlerts: { type: "boolean", description: "تحويل المرشحات عالية الثقة إلى تنبيهات دائمة" }
      }
    }
  },
  {
    name: "review_recurring_commitments",
    description: "يراجع الالتزامات المتكررة المحفوظة وينبه لما هو قريب أو متأخر خلال نافذة محددة. استخدمه عندما يسأل المستخدم عن الاشتراكات القادمة أو الفواتير القريبة.",
    parameters: {
      type: "object",
      properties: {
        lookAheadDays: { type: "number", description: "عدد الأيام القادمة للمراجعة، الافتراضي 7" },
        limit: { type: "number", description: "عدد الالتزامات المقروءة، بحد أقصى 300" },
        persistAlerts: { type: "boolean", description: "إنشاء تنبيهات دائمة للالتزامات القريبة أو المتأخرة" }
      }
    }
  },
  {
    name: "create_recurring_commitment_from_candidate",
    description: "يحوّل مرشح مصروف متكرر إلى التزام متكرر محفوظ. استخدمه فقط بعد موافقة المستخدم على المرشح أو عندما يعطي المستخدم اسم الالتزام والمبلغ والتكرار صراحة.",
    parameters: {
      type: "object",
      properties: {
        detectionKey: { type: "string", description: "معرف المرشح من detect_recurring_commitments" },
        candidate: { type: "object", description: "مرشح كامل من detect_recurring_commitments" },
        title: { type: "string", description: "اسم الالتزام عند الإدخال اليدوي" },
        amount: { type: "number", description: "قيمة الالتزام" },
        dueDate: { type: "string", description: "موعد الاستحقاق القادم YYYY-MM-DD" },
        frequency: { type: "string", description: "weekly أو biweekly أو monthly أو quarterly أو yearly" },
        category: { type: "string", description: "تصنيف الالتزام" },
        notes: { type: "string", description: "ملاحظات اختيارية" }
      }
    }
  },
  {
    name: "update_commitment_status",
    description: "V6: يحدّث حالة التزام (pending/paid/cancelled). الالتزامات المدفوعة لا تُخصم مرة أخرى من توقع 30 يوماً. استخدمها بعد تنفيذ سداد الالتزام فعلياً.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "معرف الالتزام" },
        status: { type: "string", description: "'pending' أو 'paid' أو 'cancelled'" }
      },
      required: ["id", "status"]
    }
  },
  {
    name: "send_palpay_payment",
    description: "يقوم بتحويل مبلغ مالي لشخص عبر رقم الهاتف باستخدام محفظة PalPay. (مهم: اسأل عن رقم الهاتف قبل التحويل إن لم يذكره).",
    parameters: {
      type: "object",
      properties: {
        amount: { type: "number", description: "المبلغ المراد تحويله" },
        recipientName: { type: "string", description: "اسم المستلم" },
        phoneNumber: { type: "string", description: "رقم جوال المستلم (مطلوب)" },
        description: { type: "string", description: "سبب التحويل (مثال: شراء خضار وفواكه)" }
      },
      required: ["amount", "recipientName", "phoneNumber", "description"]
    }
  },
  {
    name: "get_treasurer_profile",
    description: "يجلب الملف المالي الشخصي الموسع لأمين الصندوق مع درجة الاكتمال: الراتب، يوم الراتب، دورة الراتب، الاحتياطي، حدود السيولة، حدود الدين، تفضيلات التنبيه، السوق المحلي، والأولويات المالية.",
    parameters: { type: "object", properties: {} }
  },
  {
    name: "update_treasurer_profile",
    description: "يحدث ملف أمين الصندوق الشخصي. استخدمه في onboarding أو عندما يذكر المستخدم دخله، يوم الراتب، حدود الأمان، الصرامة، الديون المقبولة، الأولويات، أو تفضيلات التنبيه.",
    parameters: {
      type: "object",
      properties: {
        monthlySalary: { type: "number", description: "الراتب/الدخل الشهري المتوقع" },
        salaryDay: { type: "number", description: "يوم نزول الراتب من 1 إلى 31" },
        salaryCycleStartDay: { type: "number", description: "بداية دورة الراتب، الافتراضي 27" },
        salaryCycleEndDay: { type: "number", description: "نهاية دورة الراتب، الافتراضي 26" },
        cashReserveTarget: { type: "number", description: "هدف احتياطي الأمان" },
        minimumCashFloor: { type: "number", description: "أقل سيولة لا يجوز النزول تحتها" },
        criticalLiquidityFloor: { type: "number", description: "حد سيولة حرج يوقف الصرف الخطر" },
        criticalCoverageDays: { type: "number", description: "عدد أيام التغطية التي تعتبر حرجة" },
        warningCoverageDays: { type: "number", description: "عدد أيام التغطية التي تعتبر تحذيرية" },
        dailySpendingLimit: { type: "number", description: "سقف صرف يومي اختياري" },
        weeklySpendingLimit: { type: "number", description: "سقف صرف أسبوعي اختياري" },
        discretionaryMonthlyLimit: { type: "number", description: "سقف المصروفات الكمالية الشهرية" },
        essentialMonthlyEstimate: { type: "number", description: "تقدير المصاريف الأساسية الشهرية" },
        debtLimitRatio: { type: "number", description: "أقصى نسبة دين إلى الدخل، مثال 0.5 أو 1" },
        maxDebtBalance: { type: "number", description: "أقصى إجمالي دين مقبول" },
        householdSize: { type: "number", description: "عدد أفراد البيت" },
        dependentsCount: { type: "number", description: "عدد المعالين" },
        savingsRateTarget: { type: "number", description: "نسبة الادخار المستهدفة من الدخل" },
        strictness: { type: "string", description: "gentle أو balanced أو strict" },
        locale: { type: "string", description: "المنطقة/السوق المحلي" },
        marketPrimary: { type: "string", description: "السوق الأساسي، مثل Gaza" },
        marketSecondary: { type: "string", description: "السوق البديل، مثل Palestine" },
        allowGlobalReference: { type: "boolean", description: "السماح بالسوق العالمي كمرجع فقط" },
        budgetThresholdPct: { type: "number", description: "نسبة تنبيه الميزانية، الافتراضي 80" },
        criticalBudgetThresholdPct: { type: "number", description: "نسبة التنبيه الحرج، الافتراضي 100" },
        notificationTone: { type: "string", description: "لطيف/متوازن/صارم" },
        protectedCategories: { type: "array", items: { type: "string" }, description: "بنود محمية لا يجب تخفيضها بسهولة" },
        restrictedCategories: { type: "array", items: { type: "string" }, description: "بنود تحتاج تأكيد أو تقييد" },
        financialPriorities: { type: "array", items: { type: "object" }, description: "الأولويات المالية الحالية مرتبة" },
        financialGoals: { type: "array", items: { type: "object" }, description: "أهداف مالية شخصية عامة بجانب أهداف الادخار" },
        notes: { type: "string", description: "ملاحظات شخصية مالية" }
      }
    }
  },
  {
    name: "get_savings_goals",
    description: "يعرض أهداف الادخار الحالية ومقدار المحفوظ والمتبقي لكل هدف.",
    parameters: { type: "object", properties: {} }
  },
  {
    name: "create_savings_goal",
    description: "ينشئ هدف ادخار مثل احتياطي طوارئ أو شراء آيفون أو تعليم الأبناء. إذا قال المستخدم: هدفي أصل إلى 5000 خلال سنة، استخدم targetAmount=5000 وdurationMonths=12. احسب له المطلوب شهرياً ولا تسجلها كمصروف.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "اسم هدف الادخار" },
        targetAmount: { type: "number", description: "المبلغ المستهدف بالشيكل" },
        savedAmount: { type: "number", description: "المبلغ المحفوظ حالياً إن وجد" },
        dueDate: { type: "string", description: "موعد مستهدف اختياري YYYY-MM-DD" },
        durationMonths: { type: "number", description: "مدة الهدف بالشهور عند قول المستخدم خلال سنة/6 شهور/شهرين" },
        priority: { type: "string", description: "low, medium, high" },
        notes: { type: "string", description: "ملاحظات" }
      },
      required: ["name", "targetAmount"]
    }
  },
  {
    name: "add_savings_contribution",
    description: "يضيف مبلغاً إلى هدف ادخار موجود. إذا كان للمستخدم هدف نشط واحد فقط فاختره تلقائياً. إذا تعددت الأهداف ولم يحدد الاسم، اسأل أي هدف. لا تعتبر المساهمة مصروفاً إلا إذا طلب المستخدم نقلها من حساب مالي؛ هي تحديث لهدف الادخار.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "معرف هدف الادخار إن كان معروفاً" },
        goalId: { type: "string", description: "معرف هدف الادخار البديل" },
        goalName: { type: "string", description: "اسم الهدف إذا قال: ادخر 200 لهدف الطوارئ" },
        amount: { type: "number", description: "المبلغ المضاف للادخار" },
        notes: { type: "string", description: "ملاحظات اختيارية" }
      },
      required: ["amount"]
    }
  },
  {
    name: "update_savings_goal",
    description: "يعدل هدف ادخار: الاسم، المبلغ المستهدف، المحفوظ، الموعد، الأولوية أو الحالة.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "معرف هدف الادخار" },
        name: { type: "string" },
        targetAmount: { type: "number" },
        savedAmount: { type: "number" },
        dueDate: { type: "string" },
        durationMonths: { type: "number", description: "مدة جديدة بالشهور لإعادة حساب الموعد والمطلوب شهرياً" },
        priority: { type: "string" },
        status: { type: "string" },
        notes: { type: "string" }
      },
      required: ["id"]
    }
  },
  {
    name: "generate_report",
    description: "يستخرج وينشئ تقريراً مالياً كتابياً هيكلياً مفصلاً جداً يحتوي على بند الصرف الرئيسي وتحته بنود الصرف الفرعية وكل بند فرعي تحته تفصيل الدفع. استخدمه لأي طلب: تقرير كامل/شامل/مفصل/كل المصروفات، ولا ترفض بسبب كثرة البيانات؛ احفظ التقرير وأرجع reportId. مهم جداً: تقرير شهر 8 يعني timeframe='salary_cycle' و month=8. لا تستخدم timeframe='all' لعبارة 'كافة البنود/كل البنود'؛ هذه تعني category='all' فقط. timeframe='all' مسموح فقط إذا قال المستخدم كل التاريخ/كل السنوات/كل البيانات من البداية.",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: "عنوان التقرير (مثال: 'التقرير المالي التفصيلي الشامل', 'تقرير مصروفات الأبناء', 'تقرير زيارات وضيافة')" },
        timeframe: { type: "string", description: "الفترة: 'current_salary_cycle' أو 'salary_cycle' أو 'custom' أو 'today' أو 'week' أو 'all'. عند ذكر شهر محدد استخدم salary_cycle. لا تستخدم all إلا لكل التاريخ/كل السنوات، وليس لكل البنود." },
        month: { type: "string", description: "رقم/اسم شهر دورة الراتب للتقرير؛ شهر 8 يعني 27/07→26/08، وشهر 9 يعني 27/08→26/09" },
        year: { type: "number", description: "سنة دورة الراتب أو التقرير" },
        startDate: { type: "string", description: "بداية فترة مخصصة YYYY-MM-DD، مطلوبة إذا timeframe=custom" },
        endDate: { type: "string", description: "نهاية فترة مخصصة YYYY-MM-DD، مطلوبة إذا timeframe=custom" },
        calendarMonth: { type: "boolean", description: "true فقط إذا قال المستخدم صراحة الشهر الميلادي" },
        type: { type: "string", description: "expense أو income أو transfer" },
        category: { type: "string", description: "التصنيف الرئيسي مثل الأبناء أو الطعام أو الزيارات" },
        subcategory: { type: "string", description: "البند الفرعي مثل ملابس، علاج، ضيافة، تموين" },
        allowFullLedgerReport: { type: "boolean", description: "true فقط إذا أكد المستخدم صراحة تقرير كل التاريخ" }
      },
      required: ["title"]
    }
  },
  {
    name: "generate_treasurer_report",
    description: "ينشئ تقرير أمين الصندوق المتقدم للتحليل والاستشارة: شهري/ربعي/سنوي/مخصص، مع البنود الرئيسية والفرعية، المتاجر، طرق الدفع، الضروري والكمالي، أعلى المصروفات، التجاوزات، مؤشرات الادخار، وبيانات جاهزة للرسم البياني. لا تستخدمه لطلب تقرير كتابي كامل يسرد كل المصروفات؛ لذلك استخدم generate_report. استخدمه للأسئلة التحليلية مثل: كم صرفت على الأبناء/الأولاد؟ ما أكثر المصروفات الشهر هذا؟ أين التجاوزات؟ ما التوصيات؟ لا ترفض بسبب كثرة البيانات؛ الأداة ترجع تقريراً ملخصاً ضمن حد آمن وتضع partial عند الحاجة.",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: "عنوان التقرير" },
        period: { type: "string", description: "today, week, month, current_salary_cycle, salary_cycle, quarter, year, all أو custom. عبارة الشهر هذا في سياق المصروفات تعني current_salary_cycle إلا إذا قال الشهر الميلادي." },
        year: { type: "number", description: "السنة عند التقرير السنوي أو الربعي أو شهر محدد" },
        quarter: { type: "number", description: "رقم الربع 1-4" },
        month: { type: "number", description: "رقم شهر دورة الراتب 1-12؛ لا تجعله شهراً ميلادياً إلا إذا calendarMonth=true" },
        calendarMonth: { type: "boolean", description: "true فقط إذا قال المستخدم صراحة الشهر الميلادي؛ غير ذلك الشهر يعني دورة الراتب" },
        startDate: { type: "string", description: "بداية فترة مخصصة YYYY-MM-DD" },
        endDate: { type: "string", description: "نهاية فترة مخصصة YYYY-MM-DD" },
        category: { type: "string", description: "بند رئيسي أو فرعي مثل الأبناء، الزيارات، الطعام" },
        type: { type: "string", description: "expense أو income أو transfer" },
        necessity: { type: "string", description: "ضروري أو كمالي" },
        save: { type: "boolean", description: "احفظ التقرير في حافظة التقارير، الافتراضي true" },
        allowFullLedgerReport: { type: "boolean", description: "true فقط إذا أكد المستخدم صراحة أنه يريد تقرير كل التاريخ رغم تكلفة القراءة" }
      }
    }
  },
  {
    name: "get_financial_decision_context",
    description: "يجلب سياقاً مالياً موحداً لاتخاذ القرار: الأرصدة، متوسط الصرف اليومي، توقع 30 يوماً، الالتزامات والموازنات. استخدمه عند المناقشة المالية المهمة، وليس مع كل سؤال بسيط.",
    parameters: { type: "object", properties: {} }
  },
  {
    name: "get_safe_spending_limit",
    description: "يحسب المبلغ الآمن للصرف اليوم/الأسبوع/حتى الراتب القادم بعد حماية الالتزامات القريبة، احتياطي الأمان، أهداف الادخار، ونمط الصرف المعتاد. استخدمه عند سؤال المستخدم: كم أقدر أصرف؟ هل أقدر أشتري؟ ما الحد الآمن؟ أو عند تقديم نبض مالي يومي.",
    parameters: { type: "object", properties: {
      period: { type: "string", description: "today أو week أو next_30_days أو salary_cycle. الافتراضي salary_cycle حتى نهاية دورة الراتب الحالية" },
      untilDate: { type: "string", description: "تاريخ نهاية مخصص YYYY-MM-DD إن أراد المستخدم حد الصرف حتى يوم محدد" },
      reserveTarget: { type: "number", description: "احتياطي أمان اختياري بالشيكل يتجاوز أو يعوض الموجود في ملف أمين الصندوق" },
      strictness: { type: "string", description: "gentle أو balanced أو strict لتحديد هامش الأمان السلوكي" }
    } }
  },
  {
    name: "assess_financial_goal_impact",
    description: "يقيس أثر مصروف أو شراء مقترح على أهداف الادخار والأولويات المالية: هل يؤخر هدفاً، كم يوم تقريباً، وهل يحتاج تأكيداً أو تعويضاً. لا يسجل مصروفاً. استخدمه قبل الشراء أو المصروف المهم، وخاصة الكماليات أو المبالغ التي قد تكسر الحد الآمن.",
    parameters: { type: "object", properties: {
      amount: { type: "number", description: "قيمة المصروف أو الشراء المراد تقييمه" },
      category: { type: "string", description: "بند المصروف" },
      item: { type: "string", description: "اسم السلعة أو الغرض" },
      product: { type: "string", description: "اسم المنتج إن كان قرار شراء" },
      necessity: { type: "string", description: "ضروري أو كمالي" },
      period: { type: "string", description: "salary_cycle أو today أو week أو next_30_days" },
      goalLimit: { type: "number", description: "عدد الأهداف المتأثرة المطلوب إرجاعها" },
      persistAlert: { type: "boolean", description: "تحويل الأثر الخطر إلى تنبيه دائم عند الحاجة" },
      riskConfirmed: { type: "boolean", description: "تأكيد المستخدم للمخاطرة إذا كان القرار يؤثر على هدف مهم" }
    }, required: ["amount"] }
  },
  {
    name: "simulate_financial_scenario",
    description: "يحاكي سيناريو مالي افتراضي بدون تسجيل أي عملية: لو صرفت/دخلت/سددت/ادخرت مبلغاً، ماذا يحدث للرصيد المتوقع، الحد الآمن، الأهداف، وخطة التعويض حتى نهاية دورة الراتب أو أفق محدد. استخدمه لأسئلة: لو صرفت كذا؟ لو اشتريت؟ لو وفرت؟ شو يصير آخر الشهر؟",
    parameters: { type: "object", properties: {
      amount: { type: "number", description: "قيمة السيناريو" },
      type: { type: "string", description: "expense أو income أو debt_payment أو savings_contribution أو transfer" },
      category: { type: "string", description: "البند أو التصنيف" },
      item: { type: "string", description: "اسم السلعة أو الغرض" },
      product: { type: "string", description: "اسم المنتج إذا كان شراء" },
      necessity: { type: "string", description: "ضروري أو كمالي" },
      frequency: { type: "string", description: "once أو daily أو weekly أو monthly" },
      occurrences: { type: "number", description: "عدد مرات تكرار السيناريو إن كان معروفاً" },
      horizon: { type: "string", description: "salary_cycle أو today أو week أو next_30_days" },
      horizonDays: { type: "number", description: "أفق مخصص بالأيام" },
      save: { type: "boolean", description: "حفظ السيناريو في advisorScenarios" },
      persistAlert: { type: "boolean", description: "تحويل السيناريو الخطر إلى تنبيه دائم" },
      riskConfirmed: { type: "boolean", description: "تأكيد المستخدم للمخاطرة إن قرر المتابعة" }
    }, required: ["amount"] }
  },
  {
    name: "get_financial_scenarios",
    description: "يعرض آخر السيناريوهات المالية المحفوظة للمستخدم من advisorScenarios.",
    parameters: { type: "object", properties: {
      limit: { type: "number", description: "عدد السيناريوهات، بحد أقصى 50" }
    } }
  },
  {
    name: "analyze_financial_habits",
    description: "يحلل عادات وأنماط الصرف مقارنة بالفترة السابقة: ارتفاع التصنيفات، تكرار التاجر، المصاريف الصغيرة، يوم الصرف الأعلى، وزيادة استخدام الدين. لا يسجل عملية مالية، ويمكنه حفظ تقرير أو إنشاء تنبيهات عند الطلب.",
    parameters: { type: "object", properties: {
      period: { type: "string", description: "last_7_days أو last_14_days أو last_30_days أو salary_cycle أو quarter" },
      days: { type: "number", description: "عدد أيام التحليل عند الحاجة" },
      limit: { type: "number", description: "عدد العمليات المقروءة، الافتراضي 800 والأقصى 1500" },
      insightLimit: { type: "number", description: "عدد الأنماط المرجعة" },
      minInsightAmount: { type: "number", description: "أقل مبلغ يستحق إظهار نمط" },
      spikePct: { type: "number", description: "نسبة الارتفاع التي تعتبر تغيراً مهماً" },
      save: { type: "boolean", description: "حفظ التقرير في advisorHabitReports" },
      persistAlerts: { type: "boolean", description: "تحويل الأنماط التحذيرية إلى تنبيهات دائمة" }
    } }
  },
  {
    name: "get_financial_habit_reports",
    description: "يعرض آخر تقارير العادات والأنماط المالية المحفوظة من advisorHabitReports.",
    parameters: { type: "object", properties: {
      limit: { type: "number", description: "عدد التقارير، بحد أقصى 50" }
    } }
  },
  {
    name: "generate_weekly_financial_recommendations",
    description: "ينشئ خطة توصيات أسبوعية عملية للمستخدم: ماذا يوقف، ماذا يخفض، ماذا يسدد، كم يحول للأهداف، وما الالتزامات القريبة. يعتمد على الحد الآمن، العادات، الأهداف، الاشتراكات، والتنبيهات. لا يسجل عملية مالية.",
    parameters: { type: "object", properties: {
      focus: { type: "string", description: "weekly أو recovery أو savings_growth أو debt_control" },
      habitPeriod: { type: "string", description: "فترة تحليل العادات مثل last_14_days أو last_30_days" },
      transactionLimit: { type: "number", description: "عدد العمليات المقروءة للتحليل" },
      save: { type: "boolean", description: "حفظ الخطة في advisorWeeklyPlans" },
      persistAlerts: { type: "boolean", description: "تحويل الخطة التحذيرية إلى تنبيه دائم" }
    } }
  },
  {
    name: "get_weekly_financial_recommendations",
    description: "يعرض آخر خطط التوصيات الأسبوعية المحفوظة من advisorWeeklyPlans.",
    parameters: { type: "object", properties: {
      limit: { type: "number", description: "عدد الخطط، بحد أقصى 50" }
    } }
  },
  {
    name: "generate_adaptive_budget_plan",
    description: "يقترح ميزانية متكيّفة لكل بند حسب الراتب، الالتزامات، أهداف الادخار، الحد الآمن، والعادات. لا يغيّر الميزانيات المحفوظة إلا إذا استُخدمت أداة التطبيق بعد موافقة صريحة.",
    parameters: { type: "object", properties: {
      mode: { type: "string", description: "balanced أو tighten أو growth أو relaxed" },
      focus: { type: "string", description: "مرادف لوضع الخطة مثل recovery أو savings_growth" },
      habitPeriod: { type: "string", description: "فترة تحليل العادات مثل last_30_days" },
      transactionLimit: { type: "number", description: "عدد العمليات المقروءة للتحليل" },
      save: { type: "boolean", description: "حفظ الخطة في advisorBudgetPlans" },
      persistAlert: { type: "boolean", description: "تحويل الخطة التي تحتاج مراجعة إلى تنبيه دائم" }
    } }
  },
  {
    name: "get_adaptive_budget_plans",
    description: "يعرض آخر خطط الميزانية المتكيّفة المحفوظة من advisorBudgetPlans.",
    parameters: { type: "object", properties: {
      limit: { type: "number", description: "عدد الخطط، بحد أقصى 50" }
    } }
  },
  {
    name: "apply_adaptive_budget_plan",
    description: "يطبّق خطة ميزانية متكيّفة على حدود الميزانيات المحفوظة. استخدمه فقط بعد موافقة صريحة من المستخدم لأنه يغيّر حدود البنود.",
    parameters: { type: "object", properties: {
      planId: { type: "string", description: "معرف خطة محفوظة في advisorBudgetPlans" },
      plan: { type: "object", description: "خطة كاملة من generate_adaptive_budget_plan" },
      proposals: { type: "array", description: "قائمة حدود مقترحة للتطبيق" },
      applyConfirmed: { type: "boolean", description: "تأكيد صريح من المستخدم لتطبيق الخطة" },
      confirmed: { type: "boolean", description: "مرادف للتأكيد" }
    } }
  },
  {
    name: "forecast_month_end_financial_position",
    description: "يتنبأ بوضع نهاية الشهر أو نهاية دورة الراتب: فائض، توازن، ضغط، أو عجز. يعتمد على السيولة، الالتزامات، الأهداف، نمط الصرف، الحد الآمن، وخطط الميزانية. لا يسجل عملية مالية.",
    parameters: { type: "object", properties: {
      horizon: { type: "string", description: "salary_cycle أو calendar_month" },
      period: { type: "string", description: "مرادف للأفق المطلوب" },
      transactionLimit: { type: "number", description: "عدد العمليات المقروءة لتحليل النمط" },
      save: { type: "boolean", description: "حفظ التوقع في advisorMonthEndForecasts" },
      persistAlerts: { type: "boolean", description: "تحويل توقع الضغط أو العجز إلى تنبيه دائم" }
    } }
  },
  {
    name: "get_month_end_forecasts",
    description: "يعرض آخر توقعات نهاية الشهر أو دورة الراتب المحفوظة من advisorMonthEndForecasts.",
    parameters: { type: "object", properties: {
      limit: { type: "number", description: "عدد التوقعات، بحد أقصى 50" }
    } }
  },
  {
    name: "generate_daily_financial_pulse",
    description: "ينشئ نبضاً مالياً يومياً مختصراً: سقف اليوم الآمن، الخطر الأكبر، أهم تذكير، قائمة ما لا يجب صرفه اليوم، وأوامر اليوم العملية. لا يسجل عملية مالية.",
    parameters: { type: "object", properties: {
      mode: { type: "string", description: "morning أو evening أو quick" },
      transactionLimit: { type: "number", description: "عدد العمليات المقروءة لتحليل اليوم والعادات" },
      save: { type: "boolean", description: "حفظ النبض في advisorDailyPulses" },
      persistAlerts: { type: "boolean", description: "تحويل النبض التحذيري إلى تنبيه دائم" }
    } }
  },
  {
    name: "get_daily_financial_pulses",
    description: "يعرض آخر نبضات اليوم المالية المحفوظة من advisorDailyPulses.",
    parameters: { type: "object", properties: {
      limit: { type: "number", description: "عدد النبضات، بحد أقصى 50" }
    } }
  },
  {
    name: "get_advisor_alerts",
    description: "يجلب مركز تنبيهات الخبير المالي: المخاطر المفتوحة، تجاوز الميزانيات، إيقاف أمين الصندوق للعمليات، والتنبيهات المؤجلة. استخدمه عندما يسأل المستخدم عن التحذيرات أو ما الذي يحتاج متابعة.",
    parameters: { type: "object", properties: {
      limit: { type: "number", description: "عدد التنبيهات المطلوب، بحد أقصى 100" },
      includeResolved: { type: "boolean", description: "إظهار التنبيهات المحلولة أو المتجاهلة أيضاً" },
      includeSnoozed: { type: "boolean", description: "إظهار التنبيهات المؤجلة حتى لو لم يحن موعدها" }
    } }
  },
  {
    name: "update_advisor_alert",
    description: "يحدّث حالة تنبيه مالي في مركز الخبير: read أو resolve أو dismiss أو snooze أو reopen. استخدمه فقط عندما يطلب المستخدم التعامل مع تنبيه محدد أو بعد موافقته.",
    parameters: { type: "object", properties: {
      id: { type: "string", description: "معرف التنبيه" },
      action: { type: "string", description: "read أو resolve أو dismiss أو snooze أو reopen" },
      until: { type: "string", description: "تاريخ/وقت ISO عند التأجيل" }
    }, required: ["id", "action"] }
  },
  {
    name: "assess_purchase",
    description: "يقيّم شراءً قبل تنفيذه مقابل الرصيد، معدل الصرف، الالتزامات، الموازنة، وأثره على أهداف الادخار. لا يسجل أي عملية.",
    parameters: { type:"object", properties:{
      price:{type:"number",description:"السعر المقترح"}, item:{type:"string",description:"السلعة"}, model:{type:"string",description:"الموديل إن وجد"}, paymentMethod:{type:"string",description:"cash أو palPay أو debt"}, category:{type:"string",description:"البند الرئيسي"}, necessity:{type:"string",description:"ضروري أو كمالي"}
    }, required:["price"] }
  },
  {
    name: "search_local_market",
    description: "يبحث ويقارن الأسعار بترتيب صارم: غزة أولاً، فلسطين ثانياً، السوق العالمي ثالثاً. يدمج دفتر سوق غزة المحفوظ مع بحث Google Search grounding، ويرجع نطاقات غزة/فلسطين/العالمي وتحذيرات إذا السعر المعروض مرتفع أو أقل بشكل مريب. لا يخترع أسعاراً ولا يستخدم للمشتريات اليومية الصغيرة.",
    parameters: { type:"object", properties:{
      item:{type:"string",description:"اسم السلعة"},
      model:{type:"string",description:"الموديل/المواصفات الدقيقة (مثال: iPhone 15 Pro 256GB)"},
      condition:{type:"string",description:"حالة السلعة: 'new' (جديد) أو 'used' (مستعمل) أو 'unknown'"},
      offeredPrice:{type:"number",description:"السعر المعروض على المستخدم للمقارنة والاعتراض إذا كان مبالغاً"}
    }, required:["item"] }
  },
  {
    name: "get_market_directory",
    description: "يعرض أو يبحث في دفتر سوق غزة/فلسطين المحفوظ لدى المستخدم: محلات، عناوين، أسعار، أرقام، مصادر، وتاريخ آخر تحديث.",
    parameters: { type:"object", properties:{
      item:{type:"string",description:"اسم السلعة للبحث داخل دفتر السوق"},
      model:{type:"string",description:"موديل أو مواصفة اختيارية"}
    } }
  },
  {
    name: "create_market_watch_item",
    description: "يضيف سلعة مهمة إلى قائمة مراقبة السوق، ويفحصها مقابل السعر المحلي والحد الآمن للصرف. استخدمه عندما يقول المستخدم بدي أراقب/أشتري لاحقاً/ذكرني إذا نزل سعر سلعة أو يعطي سعراً مستهدفاً.",
    parameters: { type:"object", properties:{
      product:{type:"string",description:"اسم السلعة المراد مراقبتها"},
      model:{type:"string",description:"الموديل أو المواصفات"},
      condition:{type:"string",description:"new أو used أو unknown"},
      targetPrice:{type:"number",description:"السعر المستهدف أو الحد الأعلى المقبول"},
      offeredPrice:{type:"number",description:"سعر معروض حالياً للمقارنة"},
      seller:{type:"string",description:"اسم المحل/البائع إن وجد"},
      priority:{type:"string",description:"low أو medium أو high"},
      desiredBy:{type:"string",description:"تاريخ الرغبة بالشراء YYYY-MM-DD إن وجد"},
      notes:{type:"string",description:"ملاحظات عن الضمان/الحالة/المواصفات"},
      runMarketCheck:{type:"boolean",description:"false فقط إذا أراد المستخدم حفظها بدون فحص سوق الآن"}
    }, required:["product"] }
  },
  {
    name: "get_market_watchlist",
    description: "يعرض قائمة المشتريات/السلع التي يراقبها الخبير المالي مع آخر قرار شراء أو انتظار وربطها بالحد الآمن للصرف.",
    parameters: { type:"object", properties:{
      limit:{type:"number",description:"عدد العناصر المطلوب بحد أقصى 100"},
      status:{type:"string",description:"watching أو paused أو purchased أو cancelled أو archived"},
      includeClosed:{type:"boolean",description:"إظهار العناصر المغلقة أيضاً"}
    } }
  },
  {
    name: "update_market_watch_item",
    description: "يحدّث عنصر مراقبة سوق أو يعيد فحصه مقابل السوق والحد الآمن. استخدمه عند تغيير السعر المعروض أو البائع أو عند وضعه purchased/cancelled.",
    parameters: { type:"object", properties:{
      id:{type:"string",description:"معرف عنصر المراقبة"},
      offeredPrice:{type:"number",description:"السعر المعروض الجديد"},
      targetPrice:{type:"number",description:"السعر المستهدف الجديد"},
      status:{type:"string",description:"watching أو paused أو purchased أو cancelled أو archived"},
      seller:{type:"string",description:"اسم البائع/المحل"},
      notes:{type:"string",description:"ملاحظات جديدة"},
      runMarketCheck:{type:"boolean",description:"إعادة فحص السوق والحد الآمن"}
    }, required:["id"] }
  },
  {
    name: "review_market_watchlist",
    description: "يراجع قائمة مراقبة السوق ويحدّث عدة عناصر مقابل السوق المحلي والحد الآمن للصرف، ثم يرجع العناصر التي تحتاج شراء/تفاوض/انتظار.",
    parameters: { type:"object", properties:{
      limit:{type:"number",description:"عدد العناصر المراد قراءتها"},
      reviewLimit:{type:"number",description:"عدد العناصر المراد إعادة فحصها الآن، بحد أقصى 10"}
    } }
  },
  {
    name: "save_market_offer",
    description: "يحفظ عرض سعر موثق في دفتر سوق غزة/فلسطين أو العالمي. استخدمه عندما يعطيك المستخدم اسم محل/سعر/عنوان أو عندما تريد بناء ذاكرة سوق محلية تدريجياً.",
    parameters: { type:"object", properties:{
      product:{type:"string",description:"اسم السلعة"},
      brand:{type:"string",description:"العلامة التجارية"},
      model:{type:"string",description:"الموديل"},
      variant:{type:"string",description:"المواصفة/السعة/اللون"},
      condition:{type:"string",description:"new أو used أو unknown"},
      seller:{type:"string",description:"اسم المحل أو البائع"},
      location:{type:"string",description:"المدينة/المنطقة مثل غزة، الرمال، خان يونس"},
      address:{type:"string",description:"العنوان التفصيلي إن وجد"},
      phone:{type:"string",description:"رقم الهاتف أو واتساب"},
      price:{type:"number",description:"السعر"},
      currency:{type:"string",description:"ILS أو USD أو JOD"},
      sourceUrl:{type:"string",description:"رابط المصدر إن وجد"},
      notes:{type:"string",description:"ملاحظات عن العرض أو الضمان أو التوفر"}
    }, required:["product","price"] }
  },
  {
    name: "add_transaction",
    description: "يسجل عملية مالية بدقة (مصروف أو دخل). إذا قال المستخدم اشتريت/شريت/دفعت/مصروف وذكر مبلغاً وطريقة دفع كاش أو PalPay أو دين، فهذه الأداة هي المسار الصحيح فوراً وليست query_transactions. شراء بالدين/آجل من محل أو شخص هو add_transaction type=expense paymentMethod=debt account=debt مع creditor/merchant، وليس pay_debt. ❌ممنوع استخدام هذه الأداة لسداد الديون❌ لسداد الديون استخدم أداة pay_debt حصراً.",
    parameters: {
      type: "object",
      properties: {
        amount: { type: "number", description: "المبلغ بالشيكل (مثال: 120)" },
        type: { type: "string", description: "نوع العملية: 'expense' (مصروف) أو 'income' (دخل)" },
        account: { type: "string", description: "اسم الحساب المطابق لطريقة الدفع: 'cash' عند كاش/نقدي، 'palPay' عند بال باي/المحفظة، أو 'debt' عند دين/آجل. لا تتركه فارغاً في المصروفات." },
        category: { type: "string", description: "بند الصرف الرئيسي (مثال: 'الأبناء', 'زيارات وضيافة', 'طعام ومشتريات منزل', 'مواصلات', 'فواتير والتزامات', 'صحة وعلاج', 'تعليم')" },
        subcategory: { type: "string", description: "بند الصرف الفرعي (مثال تحت الأبناء: 'مصروف', 'ملابس', 'رسوم جامعة ومدرسة', 'دورة رسم', 'مستلزمات مدرسية', 'علاج' / وتحت زيارات: 'هدايا', 'مواصلات زيارة', 'ضيافة')" },
        purchaseItem: { type: "string", description: "ما الذي تم شراؤه تحديداً؟ مثال: خبز، ملابس، علاج، تموين، حذاء، مستلزمات مدرسة. عند أي مصروف واضح يجب ملؤه من كلام المستخدم ولا تتركه عاماً مثل مصروف." },
        beneficiary: { type: "string", description: "لمن/لأي غرض؟ مثال: الأولاد، الزوجة، البيت، العمل، علاج. إذا قال للبيت/للأولاد/للعيلة فاملأها. مهم لتمييز قيدين بنفس المبلغ ونفس المتجر." },
        merchant: { type: "string", description: "اسم المتجر أو الجهة أو الشخص (مثال: 'مكتبة النور', 'سوبرماركت البركة', 'محل ملابس')" },
        creditor: { type: "string", description: "اسم الدائن/المحل عند الشراء بالدين أو الآجل. إذا قال المستخدم من عند فلان ديناً، ضع فلان هنا أو في merchant." },
        seller: { type: "string", description: "اسم البائع/المحل كمرادف اختياري لـ merchant عند الشراء بالدين" },
        notes: { type: "string", description: "البيان وتفصيل شو اشترى أو ملاحظات إضافية" },
        paymentMethod: { type: "string", description: "طريقة الدفع: 'cash' (نقدي/كاش), 'palPay' (محفظة), أو 'debt' (دين/آجل)." },
        date: { type: "string", description: "تاريخ العملية إذا كانت قديمة أو محددة. استخدم YYYY-MM-DD أو DD/MM/YYYY أو تاريخ قصير مثل 27/6؛ راتب 27/6 هو راتب دورة شهر 7 لأن الدورة 27→26." },
        historicalMonth: { type: "string", description: "شهر إدخال تاريخي بصيغة YYYY-MM أو M/YYYY عند قول المستخدم: أسجل مصروفات شهر 6/2026. لا تستخدمه وحده بدون day." },
        day: { type: "number", description: "يوم العملية داخل historicalMonth. إذا لم يذكر اليوم في إدخال تاريخي، اسأل عنه ولا تخترع تاريخاً." },
        necessity: { type: "string", description: "اختياري. تصنيف الأهمية: 'ضروري' أو 'كمالي'. لا تطلبه من المستخدم إذا كان وصف الشراء واضحاً؛ اتركه فارغاً ليصنفه النظام وفق واقع غزة." },
        riskConfirmed: { type: "boolean", description: "true فقط إذا حذر النظام المستخدم من تجاوز/خطر مالي ووافق صراحة على المتابعة." },
        duplicateConfirmed: { type: "boolean", description: "true فقط إذا أخبر النظام المستخدم بوجود عملية سابقة قريبة وسأله هل هذه عملية جديدة مستقلة، ثم أكد المستخدم صراحة أنها جديدة. لا تستخدمها من نفسك." },
        confirmedNewTransaction: { type: "boolean", description: "مرادف duplicateConfirmed للتأكيد الصريح أن القيد الجديد مستقل عن القيد السابق." },
        userText: { type: "string", description: "النص الأصلي الذي قاله المستخدم لهذا القيد. مهم جداً: مرره كما قيل حتى يميّز الخادم بين اسم محل/شخص وبين طريقة دفع دين/كاش/PalPay." },
        currentUserText: { type: "string", description: "آخر جملة أصلية من المستخدم عند الاستدعاء الصوتي أو النصي؛ لا تخترعها." }
      },
      required: ["amount", "type", "account", "category", "subcategory", "paymentMethod"]
    }
  },
  {
    name: "get_balance",
    description: "يجلب رصيد الحسابات الحالي (نقدي، PalPay، والإجمالي).",
    parameters: {
      type: "object",
      properties: {}
    }
  },
  {
    name: "transfer_money",
    description: "يحول مبلغاً بين الحسابات والمحافظ. استخدمه أيضاً عند أخذ/استدانة/اقتراض مبلغ من شخص: fromAccount='debt' و toAccount='cash' أو 'palPay' حسب مكان استلام المال؛ إذا لم يذكر المستخدم أين استلم المال فاسأل ولا تفترض الكاش. هذا يزيد الدين ويزيد الرصيد المستقبل ولا يعتبر دخلاً ولا مصروفاً. للسداد استخدم pay_debt ولا تفترض حساب الدفع.",
    parameters: {
      type: "object",
      properties: {
        amount: { type: "number", description: "المبلغ المحول بالشيكل" },
        fromAccount: { type: "string", description: "الحساب المحول منه: 'cash' (نقدي) أو 'palPay' (بال باي) أو 'debt' (دين)" },
        toAccount: { type: "string", description: "الحساب المحول إليه: 'palPay' (بال باي) أو 'cash' (نقدي) أو 'debt' (دين)" },
        creditor: { type: "string", description: "اسم الدائن. مطلوب عند استدانة مال من debt إلى cash/PalPay حتى يبقى الدين مربوطاً بصاحبه." },
        notes: { type: "string", description: "ملاحظات إضافية عن التحويل" }
      },
      required: ["amount", "fromAccount", "toAccount"]
    }
  },
  {
    name: "get_recent_transactions",
    description: "يجلب أحدث العمليات المالية ويرجع ملخصاً جاهزاً للقراءة بصوت واضح. استخدمه لأي سؤال مثل: شو آخر العمليات المالية؟ آخر العمليات اللي تسجلت اليوم؟ آخر مصروفات؟ آخر القيود؟ إذا قال المستخدم اليوم/تسجلت اليوم فمرر userText كما هو أو today=true. لا تستخدم memory_search لهذا السؤال ولا تستخدم query_transactions إلا إذا طلب فترة محددة.",
    parameters: {
      type: "object",
      properties: {
        limit: { type: "number", description: "عدد العمليات المطلوبة، افتراضياً 10 وبحد أقصى 20" },
        today: { type: "boolean", description: "true إذا قال المستخدم اليوم أو تسجلت اليوم" },
        date: { type: "string", description: "today أو تاريخ YYYY-MM-DD إذا طلب أحدث عمليات ليوم محدد" },
        type: { type: "string", description: "expense أو income إذا طلب آخر مصروفات أو آخر دخل" },
        userText: { type: "string", description: "النص الأصلي كما قاله المستخدم، خصوصاً إذا قال اليوم/تسجلت اليوم" },
        currentUserText: { type: "string", description: "آخر جملة أصلية من المستخدم عند الاستدعاء الصوتي" }
      }
    }
  },
  {
    name: "audit_financial_duplicates",
    description: "يفحص قاعدة البيانات بحثاً عن عمليات مالية مكررة أو إشعارات نجاح غير مربوطة بعملية، ويعيد تقرير تدقيق يوضح هل المشكلة تكرار عرض إشعار فقط أم وجود قيود مالية مكررة فعلاً.",
    parameters: {
      type: "object",
      properties: {}
    }
  },
  {
    name: "run_financial_audit",
    description: "يشغّل المدقق المالي الشامل: يراجع التكرارات، الراتب المكرر، الديون بلا دائن، العمليات ناقصة التصنيف، الالتزامات المتأخرة، الميزانيات المتجاوزة، أهداف الادخار، التنبيهات الحرجة، وحد الصرف الآمن. لا يفحص كل التاريخ إلا إذا أكد المستخدم allowFullLedgerAudit.",
    parameters: {
      type: "object",
      properties: {
        scope: { type: "string", description: "salary_cycle افتراضي، أو recent، أو all مع allowFullLedgerAudit" },
        limit: { type: "number", description: "حد قراءة العمليات، الافتراضي 500 والأقصى 1000" },
        findingLimit: { type: "number", description: "عدد الملاحظات المرجعة، الافتراضي 20" },
        save: { type: "boolean", description: "حفظ نسخة من التدقيق في advisorAudits" },
        persistAlerts: { type: "boolean", description: "تحويل الملاحظات الحرجة والتحذيرية إلى تنبيهات دائمة" },
        allowFullLedgerAudit: { type: "boolean", description: "تأكيد صريح فقط عند تدقيق كل التاريخ" }
      }
    }
  },
  {
    name: "update_transaction",
    description: "يعدل عملية مالية سابقة باستخدام الـ id الخاص بها.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "معرف العملية (id)" },
        amount: { type: "number", description: "المبلغ الجديد (اختياري)" },
        type: { type: "string", description: "النوع (اختياري)" },
        account: { type: "string", description: "الحساب (اختياري)" },
        category: { type: "string", description: "التصنيف الرئيسي (اختياري)" },
        subcategory: { type: "string", description: "التصنيف الفرعي (اختياري)" },
        merchant: { type: "string", description: "المتجر/الجهة (اختياري)" },
        notes: { type: "string", description: "التفاصيل (اختياري)" },
        necessity: { type: "string", description: "ضروري أو كمالي حسب ظروف المستخدم (اختياري)" },
        date: { type: "string", description: "تاريخ العملية ISO أو YYYY-MM-DD (اختياري)" }
      },
      required: ["id"]
    }
  },
  {
    name: "delete_transaction",
    description: "يحذف عملية مالية سابقة. يمكن استخدام id صريح، أو البحث بـ date/amount/account/category. عند ذكر تاريخ مثل 27/8 يبحث في يوم العملية نفسه لا في آخر createdAt فقط، وهذا مهم للعمليات التي تظهر في تتبع النقدي/PalPay أو دورات الراتب. عند تطابق عملية واحدة فقط، يجب تمرير confirmed=true بعد عرض العملية على المستخدم. لا تحذف أبداً بصمت.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "معرف العملية (id) إن كان متوفراً" },
        date: { type: "string", description: "تاريخ العملية المراد حذفها، مثل 2026-08-27 أو 27/8" },
        account: { type: "string", description: "الحساب: 'palPay' (بال باي), 'cash' (نقدي), أو 'debt' (دين)" },
        amount: { type: "number", description: "مبلغ العملية المراد حذفها" },
        category: { type: "string", description: "تصنيف العملية المراد حذفها. لا تستخدم 'مصروف نقدي' كتصنيف؛ مرره كـ account=cash" },
        searchLimit: { type: "number", description: "حد القراءة عند البحث بالتاريخ، افتراضياً 250 وبحد أقصى 500" },
        confirmed: { type: "boolean", description: "true فقط بعد عرض المرشح الواحد على المستخدم وتأكيده." }
      }
    }
  },
  {
    name: "delete_recent_transactions",
    description: "يحذف آخر N عمليات من نوع محدد فقط عندما يطلب المستخدم ذلك صراحة. احذف آخر 3 مصروفات = kind expense. احذف آخر عملية سداد/تسديد دين = kind debt_payment. احذف آخر عملية دين أو مشتريات دين أو الدين من عند فلان بدون كلمة سداد = kind credit_purchase. يستخدم قراءة محدودة لآخر العمليات ولا يحذف بصمت؛ إذا لم تكن العبارة واضحة أرجع مرشحين واطلب تأكيداً.",
    parameters: {
      type: "object",
      properties: {
        count: { type: "number", description: "عدد العمليات الأخيرة المطلوب حذفها، بحد أقصى 10" },
        kind: { type: "string", description: "نوع العمليات: expense للمصروفات، debt_payment لتسديد الدين، credit_purchase لمشتريات الدين، income للدخل، all للكل" },
        confirmed: { type: "boolean", description: "true فقط إذا كان المستخدم قال صراحة احذف آخر N عمليات من هذا النوع" },
        confirmation: { type: "string", description: "يمكن استخدام DELETE_RECENT_TRANSACTIONS كتأكيد صريح" }
      },
      required: ["count", "kind"]
    }
  },
  {
    name: "repair_misrouted_vault_close",
    description: "تصحيح مباشر لحالة خلط إقفال الخزنة مع فائض سداد دائن. يبحث في آخر العمليات المحدودة عن عملية فائض سداد/دائن/overpayment مشبوهة أثرت على الدين بدل الخزنة، ويحذفها ذرياً بعد التأكيد. استخدمها عندما يقول المستخدم إن تحويل المتبقي للخزنة تحول بالخطأ إلى فائض دائن أو سداد دين ولا يستطيع حذفها بأمر الحذف العادي.",
    parameters: {
      type: "object",
      properties: {
        amount: { type: "number", description: "مبلغ العملية المشبوهة إن كان معروفاً مثل 445" },
        searchLimit: { type: "number", description: "عدد آخر العمليات التي سيتم فحصها، افتراضياً 75 وبحد أقصى 100" },
        confirmed: { type: "boolean", description: "true فقط إذا طلب المستخدم التصحيح صراحة أو ضغط زر التصحيح في الواجهة" },
        confirmation: { type: "string", description: "يمكن استخدام REPAIR_MISROUTED_VAULT_CLOSE كتأكيد صريح" }
      }
    }
  },
  {
    name: "repair_misrecorded_credit_purchase",
    description: "يصحح عملية شراء دين سُجلت بالخطأ كمصروف نقدي أو PalPay. لا يحذف العملية ولا ينشئ عملية عكسية؛ يعدّل نفس العملية إلى account=debt وtransactionType=CREDIT_PURCHASE فيرجع النقدي/PalPay تلقائياً ويُبقي الدين. استخدمها عندما يقول المستخدم إن شراء دين خصم من النقدي أو يريد إرجاع النقص الذي حصل بسبب تسجيل دين.",
    parameters: {
      type: "object",
      properties: {
        transactionId: { type: "string", description: "معرف العملية المحددة من الواجهة؛ عند توفره يتم تعديل هذا البند مباشرة دون بحث أو تخمين" },
        amount: { type: "number", description: "مبلغ العملية مثل 10" },
        creditor: { type: "string", description: "اسم الدائن/المحل مثل أبو العبد" },
        merchant: { type: "string", description: "اسم المحل إن ذكر" },
        seller: { type: "string", description: "اسم البائع/المحل إن ذكر" },
        searchLimit: { type: "number", description: "عدد آخر العمليات التي يتم فحصها، افتراضياً 75 وبحد أقصى 100" },
        confirmed: { type: "boolean", description: "true إذا طلب المستخدم التصحيح صراحة" },
        confirmation: { type: "string", description: "يمكن استخدام REPAIR_MISRECORDED_CREDIT_PURCHASE كتأكيد صريح" }
      }
    }
  },
  {
    name: "repair_duplicate_income",
    description: "يصلح تكرار الراتب/الدخل: يبحث عن قيود دخل مكررة بنفس المبلغ والحساب واليوم، ويحذف النسخ الزائدة ويبقي الأصلية. استخدمه عندما يقول المستخدم إن الراتب أو الدخل تسجل مرتين.",
    parameters: {
      type: "object",
      properties: {
        amount: { type: "number", description: "مبلغ الدخل المكرر مثل 3350" },
        date: { type: "string", description: "تاريخ يوم محدد YYYY-MM-DD اختياري" },
        month: { type: "string", description: "شهر محدد YYYY-MM اختياري" }
      }
    }
  },
  {
    name: "repair_duplicate_credit_purchase",
    description: "يصلح تكرار شراء بالدين: يحذف النسخ الزائدة من نفس قيد الشراء بالدين ويبقي نسخة واحدة. استخدمه عندما يقول المستخدم إن شراء دين بقيمة معينة تسجل مرتين وزاد الدين للضعف.",
    parameters: {
      type: "object",
      properties: {
        amount: { type: "number", description: "مبلغ الشراء بالدين المكرر مثل 50" },
        creditor: { type: "string", description: "اسم الدائن/المحل مثل فلان" },
        merchant: { type: "string", description: "اسم المحل إن ذكر" },
        date: { type: "string", description: "تاريخ يوم محدد YYYY-MM-DD اختياري" },
        month: { type: "string", description: "شهر محدد YYYY-MM اختياري" }
      }
    }
  },
  {
    name: "check_budget_status",
    description: "يفحص وضع الميزانية الحالي لمعرفة هل هناك تجاوز أو اقتراب من الحد المسموح، سواء لتصنيف معين أو للمجموع الكلي.",
    parameters: {
      type: "object",
      properties: {
        category: { type: "string", description: "التصنيف المراد فحص ميزانيته (اختياري)" }
      }
    }
  },
  {
    name: "query_transactions",
    description: "يجلب ملخصاً محدوداً للعمليات المالية. إذا سأل المستخدم عن يوم محدد مثل 30/8 أو بتاريخ 2026-08-30 فمرّر date وابحث في ذلك اليوم المحلي فقط، ولا تفسّر 30/8 كدورة شهر 8. أي سؤال عن شهر مثل شهر 7/يوليو يفسَّر افتراضياً كـ دورة راتب 27→26 وليس كشهر ميلادي، إلا إذا قال المستخدم صراحة الشهر الميلادي أو أعطى startDate/endDate. لا تطلب custom بلا startDate و endDate. لا تطلب transactions كاملة إلا إذا طلب المستخدم التفاصيل.",
    parameters: {
      type: "object",
      properties: {
        period: { type: "string", description: "الفترة الزمنية: 'today', 'this_week', 'this_month' (تعني دورة الراتب الحالية افتراضياً), 'salary_cycle', 'current_salary_cycle', 'previous_salary_cycle', أو 'custom'" },
        date: { type: "string", description: "تاريخ يوم محدد للبحث مثل 2026-08-30 أو 30/8. استخدمه لأي سؤال فيه كلمة بتاريخ/يوم، ولا تستخدم month لهذا النوع." },
        startDate: { type: "string", description: "تاريخ البداية بصيغة YYYY-MM-DD. مطلوب إذا period=custom" },
        endDate: { type: "string", description: "تاريخ النهاية بصيغة YYYY-MM-DD. مطلوب إذا period=custom" },
        month: { type: "string", description: "رقم أو اسم الشهر لدورة الراتب؛ شهر 7 يعني 27/06→26/07" },
        year: { type: "number", description: "سنة دورة الراتب عند السؤال عن شهر محدد" },
        calendarMonth: { type: "boolean", description: "ضعها true فقط إذا قال المستخدم صراحة الشهر الميلادي" },
        category: { type: "string", description: "التصنيف المراد البحث عنه مثل: أولاد، سيارة، كماليات (اختياري)" },
        type: { type: "string", description: "نوع العملية: 'expense' أو 'income' (الافتراضي عادة expense إن سأل عن الصرف)" },
        account: { type: "string", description: "الحساب: 'cash', 'palPay', 'debt'" },
        necessity: { type: "string", description: "الضرورة: 'ضروري' أو 'كمالي'" },
        includeTransactions: { type: "boolean", description: "true فقط إذا طلب المستخدم قائمة العمليات أو التفاصيل، وإلا أعد الملخص فقط لتقليل بيانات Gemini وFirestore" },
        limit: { type: "number", description: "حد أقصى للنتائج؛ اتركه صغيراً ولا تتجاوز الحاجة" }
      }
    }
  },
  {
    name: "get_savings_vault",
    description: "يعرض الخزنة: رصيد الخزنة الحالي، الدورة الحالية، والدورات السابقة المخزنة. لا يقرأ المعاملات ولا يعيد حساب التاريخ؛ يستخدم users/{uid}/salaryCycles و users/{uid}/meta/savingsVault.",
    parameters: {
      type: "object",
      properties: {
        limit: { type: "number", description: "عدد دورات الراتب المراد عرضها، افتراضياً 12 وبحد أعلى 60" }
      }
    }
  },
  {
    name: "add_savings_vault_adjustment",
    description: "يضيف رصيد خزنة قديم/مرحل أو مبلغ محفوظ سابقاً للخزنة كـ manual carryover. يدعم شيكل ILS ودولار USD ويورو EUR، ويحفظ العملة الأصلية مع مكافئ شيكل تقديري. لا يغير cash أو PalPay أو debt ولا ينشئ transaction مالية. استخدمه فقط عندما يقول المستخدم إن لديه مبلغاً قديماً محفوظاً في الخزنة أو يريد ترحيل رصيد سابق.",
    parameters: {
      type: "object",
      properties: {
        amount: { type: "number", description: "المبلغ إن كان الإدخال بعملة واحدة" },
        currency: { type: "string", description: "ILS أو USD أو EUR أو شيكل/دولار/يورو عند الإدخال بعملة واحدة" },
        amounts: { type: "array", description: "قائمة مبالغ متعددة العملات، مثال: [{amount:1000,currency:'ILS'}, {amount:300,currency:'USD'}, {amount:200,currency:'EUR'}]", items: { type: "object", properties: { amount: { type: "number" }, currency: { type: "string" }, source: { type: "string" }, notes: { type: "string" } } } },
        exchangeRate: { type: "number", description: "سعر صرف يدوي إلى الشيكل عند عدم توفر السعر؛ استخدم exchangeRates للأكثر من عملة" },
        exchangeRates: { type: "object", description: "أسعار صرف يدوية إلى الشيكل، مثال: { USD: 3.7, EUR: 4.0 } عند الحاجة" },
        source: { type: "string", description: "مصدر المبلغ: رصيد قديم، مدخرات سابقة، صندوق البيت..." },
        notes: { type: "string", description: "ملاحظات اختيارية" },
        operationId: { type: "string", description: "معرف idempotency إن توفر" }
      }
    }
  },
  {
    name: "recalculate_salary_cycle",
    description: "يعيد حساب دورة راتب واحدة 27→26، وعند lockVault/closeCycle/transferToVault=true يقفل الدورة ويرحل فائضها للخزنة كـ VAULT_LOCK ذري. استخدم هذه الأداة حصراً لأوامر: اقفل الشهر، اقفل الدورة، حول المتبقي للخزنة، رحّل الفائض للخزنة. لا تستخدم pay_debt ولا transfer_money لهذه الأوامر.",
    parameters: {
      type: "object",
      properties: {
        month: { type: "string", description: "رقم أو اسم شهر دورة الراتب؛ 8/أغسطس يعني 27/07→26/08" },
        year: { type: "number", description: "سنة دورة الراتب" },
        cycleId: { type: "string", description: "معرف دورة مثل vault_2026_08 إن توفر" },
        period: { type: "string", description: "current_salary_cycle أو previous_salary_cycle عند الحاجة" },
        lockVault: { type: "boolean", description: "true عند طلب تحويل الفائض/المتبقي للخزنة" },
        closeCycle: { type: "boolean", description: "true عند طلب إقفال الشهر أو الدورة" },
        transferToVault: { type: "boolean", description: "true عند طلب ترحيل المتبقي للخزنة" },
        activeSalaryCycleId: { type: "string", description: "الدورة النشطة في الواجهة عند قول المستخدم هذا الشهر/هذه الدورة" },
        activeSalaryCycleMonth: { type: "number", description: "شهر الدورة النشطة في الواجهة" },
        activeSalaryCycleYear: { type: "number", description: "سنة الدورة النشطة في الواجهة" },
        reason: { type: "string", description: "سبب إعادة الحساب أو الإقفال" }
      }
    }
  },
  {
    name: "get_salary_cycle_summary",
    description: "يحسب أو يحدّث ملخص دورة راتب واحدة 27→26 باستعلام معاملات محدود بالتاريخ. استخدمه لأسئلة مثل: كم فائض راتب يوليو؟ كم حولنا للخزنة في أغسطس؟ كم بقي من دورة راتب شهر 9؟ ما الفرق بين فائض يوليو وأغسطس؟",
    parameters: {
      type: "object",
      properties: {
        month: { type: "string", description: "رقم أو اسم شهر دورة الراتب؛ 7/يوليو يعني 27/06→26/07" },
        year: { type: "number", description: "سنة دورة الراتب" },
        period: { type: "string", description: "current_salary_cycle أو previous_salary_cycle عند الحاجة" },
        cycleId: { type: "string", description: "معرف دورة مثل vault_2026_07 إن توفر" },
        compareToMonth: { type: "string", description: "شهر آخر للمقارنة، مثل أغسطس" },
        compareToYear: { type: "number", description: "سنة شهر المقارنة" }
      }
    }
  },
  {
    name: "get_salary_cycle_details",
    description: "يعرض تفاصيل دورة راتب واحدة 27→26: بنود الدخل، المصروفات، التحويلات، ملخص الفئات، وما تم تحويله للخزنة. لا يقرأ كل التاريخ؛ يستعلم نفس نطاق الدورة فقط.",
    parameters: {
      type: "object",
      properties: {
        month: { type: "string", description: "رقم أو اسم شهر دورة الراتب؛ 7/يوليو يعني 27/06→26/07" },
        year: { type: "number", description: "سنة دورة الراتب" },
        cycleId: { type: "string", description: "معرف دورة مثل vault_2026_07" },
        period: { type: "string", description: "current_salary_cycle أو previous_salary_cycle" },
        limit: { type: "number", description: "حد البنود، افتراضياً 500 وبحد أعلى مضبوط" }
      }
    }
  },
  {
    name: "memory_save",
    description: "يحفظ معلومة طويلة الأمد (مثل راتب، قرار مالي، التزام) للرجوع إليها لاحقاً.",
    parameters: {
      type: "object",
      properties: {
        key: { type: "string", description: "اسم أو مفتاح المعلومة (مثال: salary_amount)" },
        value: { type: "string", description: "القيمة المراد حفظها" }
      },
      required: ["key", "value"]
    }
  },
  {
    name: "memory_search",
    description: "يبحث في الذاكرة طويلة الأمد لاسترجاع قرارات أو التزامات سابقة.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "الكلمة المفتاحية للبحث" }
      },
      required: ["query"]
    }
  },
  {
    name: "create_recurring_item",
    description: "ينشئ عملية مالية دورية أو راتب شهري لتذكير المستخدم به.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "اسم العملية الدورية (مثال: الراتب)" },
        amount: { type: "number", description: "المبلغ المتوقع" },
        type: { type: "string", description: "'expense' أو 'income'" },
        next_date: { type: "string", description: "تاريخ الاستحقاق القادم" }
      },
      required: ["name", "amount", "type"]
    }
  }
  // V6 (HF-1): search_market_information declaration REMOVED. The fake-price tool
  // is no longer registered with the AI. The handler remains as a defensive stub
  // (returns deprecation message) so any lingering prompt reference is harmless.
];

export async function syncOfflineData(args: any, userId: string, token: string) {
  // V6 (CF-2): NEVER trust client-supplied userId or document IDs.
  // - userId is force-overwritten with the authenticated UID.
  // - For each incoming document, we verify ownership of any existing doc with the same ID.
  //   If the doc exists and is owned by a different user, the sync item is rejected (403).
  // - Deleted-flagged items also require ownership check before deletion.
  const adminDb = getDb(token);
  let count = 0;
  const rejected: { id: string; reason: string }[] = [];

  if (args.transactions && args.transactions.length > 0) {
    // Financial transactions must NEVER be written by generic sync. They must go through
    // /api/command -> dispatchFinancialCommand -> toolHandlers -> runIdempotent -> validation.
    // Allowing doc.set() here is a financial backdoor and can create local+cloud duplicates.
    for (const tx of args.transactions) {
      rejected.push({ id: String(tx?.id || tx?.operationId || '(unknown)'), reason: 'transactions must sync through /api/command, not /api/sync' });
    }
  }

  if (args.reports && args.reports.length > 0) {
    for (const rep of args.reports) {
      const safeId = String(rep.id || '').trim();
      if (!safeId) { rejected.push({ id: '(empty)', reason: 'missing id' }); continue; }
      try {
        const existingSnap = await adminDb.collection('reports').doc(safeId).get();
        if (existingSnap.exists) {
          const existingData = existingSnap.data() as any;
          if (existingData?.userId && existingData.userId !== userId) {
            rejected.push({ id: safeId, reason: 'cross-user ownership violation' });
            continue;
          }
        }
      } catch (e: any) {
        rejected.push({ id: safeId, reason: `ownership check failed: ${e?.message || 'unknown'}` });
        continue;
      }
      const doc = adminDb.collection('reports').doc(safeId);
      if (rep.deleted) {
        await doc.delete();
      } else {
        const { _unsynced, userId: _dropUid, ...data } = rep;
        await doc.set({ ...data, userId });
      }
      count++;
    }
  }

  if (args.commitments && args.commitments.length > 0) {
    for (const com of args.commitments) {
      const safeId = String(com.id || '').trim();
      if (!safeId) { rejected.push({ id: '(empty)', reason: 'missing id' }); continue; }
      try {
        const existingSnap = await adminDb.collection('commitments').doc(safeId).get();
        if (existingSnap.exists) {
          const existingData = existingSnap.data() as any;
          if (existingData?.userId && existingData.userId !== userId) {
            rejected.push({ id: safeId, reason: 'cross-user ownership violation' });
            continue;
          }
        }
      } catch (e: any) {
        rejected.push({ id: safeId, reason: `ownership check failed: ${e?.message || 'unknown'}` });
        continue;
      }
      const doc = adminDb.collection('commitments').doc(safeId);
      if (com.deleted) {
        await doc.delete();
      } else {
        const { _unsynced, userId: _dropUid, ...data } = com;
        await doc.set({ ...data, userId });
      }
      count++;
    }
  }

  return { success: true, count, rejected };
}
