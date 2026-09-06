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
  parseSalaryCycleMonth,
  resolveSalaryCycleFromArgs,
  summarizeSalaryCycleTransactions,
  type SalaryCyclePeriod,
} from '../lib/salaryCycle';
import { calculateBalances, calculateBreakdown, normalizeAccount, normalizeCreditorKey, normalizeLedgerAccount } from '../lib/balanceCalc';
export { normalizeAccount } from '../lib/balanceCalc';
import { addBalanceDelta, transactionReplacementDelta } from '../lib/accountBalance';
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

function stableDocId(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 40);
}

async function addNotification(
  userId: string,
  message: string,
  type: string = 'success',
  adminDb?: any,
  options: { idempotencyKey?: string; transactionId?: string; operationId?: string; metadata?: any } = {}
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
      await ref.set({
        duplicateCount: Number(existing.data()?.duplicateCount || 0) + 1,
        lastDuplicateAt: now,
        delivered: existing.data()?.delivered ?? false,
      }, { merge: true });
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
      const budgetLimit = userBudgets[category] || DEFAULT_BUDGETS[category] || 1000;

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

      if (ratio >= 1.0) {
        await addNotification(
          userId,
          `⚠️ تنبيه ميزانية: تجاوزت سقف ميزانية [${category}] لهذا الشهر (${totalSpentForCat} ₪ من ${budgetLimit} ₪).`,
          'warning', db
        );
      } else if (ratio >= 0.8) {
        await addNotification(
          userId,
          `⚠️ تنبيه ميزانية: اقتربت من سقف ميزانية [${category}] لهذا الشهر (وصلت ${Math.round(ratio * 100)}% - ${totalSpentForCat} ₪ من ${budgetLimit} ₪).`,
          'warning', db
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

  const [balanceResult, recentSnap, monthExpenseSnap, budgets, commitmentSnap] = await Promise.all([
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
  ]);

  const balances = balanceResult.balances;
  const recent = recentSnap.docs.map((d: any) => ({ id: d.id, ...d.data() }));
  const commitments = commitmentSnap.docs.map((d: any) => ({ id: d.id, ...d.data() }));
  const realExpenseTxs = recent.filter((t: any) => t.type === 'expense' && t.transactionType !== 'CREDIT_PURCHASE');
  const incomeTxs = recent.filter((t: any) => t.type === 'income' && t.transactionType !== 'DEBT_BORROWING');
  const firstTs = recent.length ? Math.min(...recent.map((t: any) => new Date(t.date || t.createdAt).getTime()).filter(Number.isFinite)) : now.getTime();
  const historyDays = recent.length ? Math.max(7, Math.min(90, Math.ceil((now.getTime() - firstTs) / 86400000) + 1)) : 7;
  const expenseTotal = realExpenseTxs.reduce((a: number, t: any) => a + parsePositiveFinancialAmount(t.amount), 0);
  const incomeTotal = incomeTxs.reduce((a: number, t: any) => a + parsePositiveFinancialAmount(t.amount), 0);
  const dailyExpense = expenseTotal / historyDays;
  const dailyIncome = incomeTotal / historyDays;
  const due30 = commitments.filter((c: any) => c.status !== 'paid' && c.status !== 'cancelled')
    .reduce((a: number, c: any) => a + (Number(c.amount) || 0), 0);
  const projected30 = Math.round((balances.total || 0) + dailyIncome * 30 - dailyExpense * 30 - due30);
  const monthExpenses = monthExpenseSnap.docs.map((d: any) => ({ id: d.id, ...d.data() }));
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
  return { success:true, decision:warnings.length?'CAUTION':'OK', warnings, price, paymentMethod:account, availableBefore:available, availableAfter:after, projected30DayBalanceAfterPurchase:projectedAfter, dailyExpenseAverage:ctx.dailyExpenseAverage, daysCoverage, categoryBudget, projectedBudgetPercentage:projectedBudgetPct, confidence:ctx.confidence };
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
  // V6 (HF-6): NEVER silently swallow errors and return DEFAULT_BUDGETS.
  // On Firestore error / quota / network, propagate the error so callers can
  // mark the response as `partial` and refuse to issue budget warnings on stale data.
  const customDocs = await getUserCustomBudgetDocs(userId, adminDb);
  const mergedBudgets: Record<string, number> = { ...DEFAULT_BUDGETS };
  customDocs.forEach((b) => {
    if (b.limit) mergedBudgets[b.category || b.id] = Number(b.limit);
  });
  return mergedBudgets;
}

export async function addTransaction(args: any, userId: string, token: string) {
  const adminDb = getDb(token);
  console.log("TOOL CALL: addTransaction", args);
  
  const amount = parseAbsoluteFinancialAmount(args.amount);

  const textToCheck = `${args.type || ''} ${args.category || ''} ${args.subcategory || ''} ${args.notes || ''}`.toLowerCase();

  if (args.fromAccount && args.toAccount) {
    return await transferMoney(args, userId, token);
  }

  let type = String(args.type || 'expense').toLowerCase();
  if (type.includes('صرف') || type.includes('مصروف') || type.includes('دفع') || type.includes('شراء')) type = 'expense';
  if (type.includes('دخل') || type.includes('قبض') || type.includes('راتب') || type.includes('إيداع') || type.includes('ايداع') || type.includes('مرحل') || type.includes('تحويل لي') || type.includes('income')) type = 'income';
  if (type !== 'income' && type !== 'expense') type = 'expense';

  const paymentWasProvided = Boolean(args.paymentMethod || args.account);
  let account = normalizeAccount(args.paymentMethod || args.account || 'cash');
  let category = String(args.category || '').trim();
  let subcategory = String(args.subcategory || '').trim();
  const merchant = String(args.merchant || '').trim();
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
  const expenseIdentitySource = originalExpenseText || `${explicitPurchaseItem} ${beneficiary} ${notes}`;
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
    // Live tool calls do not carry a transcript/userText; in that path the model's
    // structured income fields are the only available evidence. Text chat still
    // prefers the user's original words when they are available.
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
  if (amount <= 0) return { success: false, needsClarification: true, reason: 'INVALID_AMOUNT', message: 'ما قيمة العملية بالضبط؟' };
  if (type === 'expense' && !paymentWasProvided) return { success: false, needsClarification: true, reason: 'MISSING_PAYMENT_METHOD', message: 'هل دفعت كاش أم من محفظة PalPay أم سجلتها ديناً؟' };
  if (type === 'expense') {
    const hasOriginalUserContext = Boolean(originalExpenseText);
    const userProvidedPurchaseIdentity = cleanedPurchaseItemIdentity.length >= 3;
    const userProvidedPurposeIdentity = userProvidedBeneficiaryPurpose || Boolean(beneficiary);
    const voiceOrApiProvidedIdentity = !hasOriginalUserContext && Boolean(explicitPurchaseItem || notes);
    const voiceOrApiProvidedPurpose = !hasOriginalUserContext && Boolean(beneficiary);
    if (!userProvidedPurchaseIdentity && !voiceOrApiProvidedIdentity) {
      return {
        success: false,
        needsClarification: true,
        reason: 'MISSING_PURCHASE_ITEM',
        message: 'قبل تسجيل أي مصروف لازم أعرف شو اشتريت بالضبط. قل لي مثلاً: خبز، دواء، ملابس، تموين... بعدها أحدد أنا البند وهل هو ضروري أو كمالي وفق واقع غزة.'
      };
    }
    if (!userProvidedPurposeIdentity && !voiceOrApiProvidedPurpose) {
      return {
        success: false,
        needsClarification: true,
        reason: 'MISSING_PURCHASE_BENEFICIARY_OR_PURPOSE',
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
  if (type === 'expense' && account === 'debt' && !merchant) return { success: false, needsClarification: true, reason: 'MISSING_CREDITOR', message: 'لمن سُجّل هذا الدين أو من أي محل/شخص اشتريت بالدين؟' };

  if (
    textToCheck.includes('دفع دين') || 
    textToCheck.includes('دفعت دين') || 
    (type === 'expense' && category.includes('سداد')) || 
    ((textToCheck.includes('سداد') || textToCheck.includes('سدد') || textToCheck.includes('تسديد')) && (textToCheck.includes('دين') || textToCheck.includes('الديون') || textToCheck.includes('لشخص') || textToCheck.includes('لصديق'))) ||
    (account === 'debt' && type === 'expense' && (textToCheck.includes('سداد') || textToCheck.includes('تسديد') || textToCheck.includes('سدد') || textToCheck.includes('دفع') || category.includes('سداد')))
  ) {
    let fromAcc = normalizeAccount(args.paymentMethod || args.fromAccount || 'cash');
    if (fromAcc === 'debt') fromAcc = 'cash'; 
    return await payDebt({ amount, paymentMethod: fromAcc, creditor: args.merchant || args.subcategory || 'سداد دين', notes: args.notes }, userId, token);
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

      const balanceResult = await getBalance({}, userId, token);
      if (balanceResult.partial === true) {
        return {
          success: false,
          retryable: true,
          reason: 'PARTIAL_STATE_UNSAFE',
          message: 'تعذّر التحقق من رصيدك الحالي بدقة. لا يمكن تنفيذ عملية مالية حساسة الآن. حاول مرة أخرى عند استعادة الاتصال الكامل.',
          operationId: String(args.operationId || `tx_${Date.now()}_${Math.random().toString(36).slice(2,10)}`),
        };
      }
      const balances = balanceResult.balances;

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

      if ((categoryMonthSnap as any).partial === true || (recentExpenseSnap as any).partial === true || (income90dSnap as any).partial === true) {
        return {
          success: false,
          retryable: true,
          reason: 'PARTIAL_STATE_UNSAFE',
          message: 'تعذّر التحقق من مؤشرات الميزانية/الدخل بدقة. لن أنفذ العملية المالية من بيانات جزئية.',
          operationId: String(args.operationId || `tx_${Date.now()}_${Math.random().toString(36).slice(2,10)}`),
        };
      }

      if (account !== 'debt') {
        const available = account === 'cash' ? Number(balances.cash||0) : account === 'palPay' ? Number(balances.palPay||0) : 0;
        if (amount > available + 0.0001) {
          return { success:false, needsClarification:true, reason:'INSUFFICIENT_FUNDS', message:`المبلغ ${amount} ₪ أكبر من رصيد ${account === 'palPay' ? 'PalPay' : 'الكاش'} المتاح (${available} ₪). لن أنفذ العملية قبل أن تحدد طريقة دفع أخرى أو تعدل المبلغ.` };
        }
      } else {
        const projectedDebt = Number(balances.debt || 0) + amount;
        const income90d = income90dSnap.docs
          .map((d:any) => d.data())
          .filter((t:any) => t.transactionType !== 'DEBT_BORROWING')
          .reduce((s:number, t:any) => s + parsePositiveFinancialAmount(t.amount), 0);
        const monthlyIncome90d = income90d / 3;
        const debtToIncomeRatio = monthlyIncome90d > 0 ? projectedDebt / monthlyIncome90d : Infinity;
        if (!args.riskConfirmed && (debtToIncomeRatio > 1.0 || amount > 5000)) {
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
      let profileReserveTarget = Number(args.savingsReserveTarget || 0);
      try {
        const profileSnap = await adminDb.collection('users').doc(userId).collection('treasurer').doc('profile').get();
        if (profileSnap.exists) profileReserveTarget = Math.max(profileReserveTarget, Number(profileSnap.data()?.cashReserveTarget || 0));
      } catch (profileErr) {
        console.warn('Treasurer profile unavailable for risk gate:', profileErr);
      }
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
        return {
          success:false,
          needsConfirmation:true,
          reason:'TREASURER_RISK_REVIEW_REQUIRED',
          message:`أمين الصندوق يعترض قبل التسجيل: ${risk.warnings.join(' ')} هل تصر على تنفيذ العملية؟`,
          financialImpact:risk,
        };
      }
      if (limit > 0 && projected >= limit && !args.riskConfirmed) {
        return { success:false, needsConfirmation:true, reason:'BUDGET_WILL_BE_EXCEEDED', message:`هذه العملية سترفع مصروف بند [${category}] إلى ${projected} ₪ مقابل سقف ${limit} ₪. هل تريد المتابعة رغم التجاوز؟`, financialImpact:{spent,amount,projected,limit,percentage:Math.round(projected/limit*100)} };
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
  
  // The ledger write above is already durably committed. Secondary effects
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
  
  const committedBalances = 'balances' in atomicResult ? (atomicResult as any).balances : undefined;
  const affectedSalaryCycle = getSalaryCycleForDate(tx.date || tx.createdAt || new Date().toISOString(), new Date());
  return {
    success: true,
    transactionId: actualTxId,
    operationId,
    transaction: { id: actualTxId, ...tx },
    affectedCycleId: affectedSalaryCycle.cycleId,
    affectedCycleIds: [affectedSalaryCycle.cycleId],
    affectedSalaryCycles: [{ cycleId: affectedSalaryCycle.cycleId, cycleStart: affectedSalaryCycle.cycleStart, cycleEnd: affectedSalaryCycle.cycleEnd, name: affectedSalaryCycle.name }],
    currentBalances: committedBalances,
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
      ? `تم حفظ القيد في السحابة بقيمة ${amount} ₪.`
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
  const hasExplicitRange = Boolean(args.startDate && args.endDate);
  const hasMonth = parseSalaryCycleMonth(args.month || args.salaryMonth || args.monthNumber) !== null;
  const timeframe = requestedTimeframe || (hasExplicitRange ? 'custom' : hasMonth ? 'salary_cycle' : 'current_salary_cycle');
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
    salaryCycleForReport = resolveSalaryCycleFromArgs({ ...args, period: timeframe === 'current_salary_cycle' ? undefined : args.period }, now);
    startIso = salaryCycleForReport.startIso;
    endExclusiveIso = salaryCycleForReport.endExclusiveIso;
  }

  let txQuery: any = adminDb.collection('transactions').where('userId', '==', userId);
  if (startIso) txQuery = txQuery.where('date', '>=', startIso);
  if (endExclusiveIso) txQuery = txQuery.where('date', '<', endExclusiveIso);
  if (startIso || endExclusiveIso) txQuery = txQuery.orderBy('date', 'desc').limit(1000);
  const txSnapshot = await txQuery.get();
  const allUserTxs = txSnapshot.docs.map(d => ({ id: d.id, ...d.data() }));
  if ((txSnapshot as any).partial === true || ((startIso || endExclusiveIso) && allUserTxs.length >= 1000)) {
    return { success: false, retryable: true, partial: true, reason: 'REPORT_QUERY_INCOMPLETE', message: 'لم أحفظ التقرير لأن قراءة الفترة جزئية أو وصلت حدها. استخدم فترة أصغر أو pagination حتى لا أعطي تقريراً ناقصاً.' };
  }

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
  
  await reportRef.set(report);

  await addNotification(userId, `تم إنجاز ${defaultTitle} بنجاح (${filtered.length} عملية)! تجده في حافظة المهام.`, 'success', adminDb);

  return { 
    success: true, 
    reportId: reportRef.id, 
    transactionsCount: filtered.length, 
    message: `Report generated with ${filtered.length} transactions and saved to inbox.` 
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
    return { error: "Amount must be greater than 0" };
  }

  const fromAccount = normalizeLedgerAccount(args.fromAccount || args.account || 'cash');
  if (fromAccount === 'debt' && !args.toAccount) {
    return { success: false, needsClarification: true, reason: 'MISSING_BORROW_DESTINATION', message: 'استلمت المبلغ نقدي (كاش) أم في محفظة PalPay؟' };
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
    return { success: false, needsClarification: true, reason: 'MISSING_CREDITOR', message: 'ممن استدنت هذا المبلغ؟' };
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

export async function payDebt(args:any,userId:string,token:string){
  const adminDb=getDb(token), amount=parsePositiveFinancialAmount(args.amount);
  if(amount<=0)return{success:false,error:'المبلغ يجب أن يكون أكبر من صفر'};
  let fromAccount=normalizeAccount(args.paymentMethod||args.fromAccount||'cash');
  if(fromAccount==='debt')fromAccount='cash';
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
  const tx={userId,operationId,amount,type:'transfer',account:fromAccount,fromAccount,toAccount:'debt',transactionType:'DEBT_PAYMENT',creditor:selected.creditor,creditorKey:selected.key,category:'سداد ديون والتزامات',subcategory:`سداد دين - ${selected.creditor}`,notes:args.notes||`سداد دين بقيمة ${amount} ₪ من ${fromName} لصالح ${selected.creditor}`,merchant:selected.creditor,necessity:'ضروري',date:new Date().toISOString(),createdAt:new Date().toISOString()};
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
  await addNotification(userId,`تم سداد ${amount} ₪ من دين ${selected.creditor} من ${fromName}.`, 'success', adminDb);
  return{success:true,transactionId:finalTxId,operationId,creditor:selected.creditor,remainingDebtForCreditor:(atomicResult as any).remaining ?? Math.max(0,Math.round((selected.remaining-amount)*100)/100),message:`تم سداد ${amount} ₪ من دين ${selected.creditor} بنجاح من ${fromName}.`,currentBalances:(atomicResult as any).balances, readEfficiency:{ creditorDocsRead: creditorSnap.docs.length, accountBalanceDocsRead: 1 }};
}

export async function getRecentTransactions(args: any, userId: string, token: string) {
  const adminDb = getDb(token);
  const snapshot = await adminDb.collection('transactions').where('userId', '==', userId).orderBy('createdAt', 'desc').limit(10).get();
  return { transactions: snapshot.docs.map(d => ({ id: d.id, ...d.data() })) };
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
  // Budget UX checks below are bounded by the affected month/category only.
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
        return { success: false, retryable: true, reason: 'BUDGET_CHECK_BOUNDED_QUERY_UNCERTAIN', message: 'لا يمكن تأكيد أثر التعديل على الميزانية من قراءة محدودة/جزئية. حاول لاحقاً أو أكد المخاطرة صراحة.' };
      }
      const existingSameCategory = categorySnap.docs
        .filter((d: any) => d.id !== args.id)
        .map((d: any) => d.data())
        .filter((t: any) => t.type === 'expense');
      const spent = existingSameCategory.reduce((s: number, t: any) => s + parsePositiveFinancialAmount(t.amount), 0) + parsePositiveFinancialAmount(projected.amount);
      const limit = Number(userBudgets?.[projected.category] || DEFAULT_BUDGETS[projected.category] || 0);
      if (limit > 0 && spent >= limit && !args.riskConfirmed) {
        return { success: false, needsConfirmation: true, reason: 'BUDGET_WILL_BE_EXCEEDED', message: `التعديل سيرفع بند [${projected.category}] إلى ${spent} ₪ مقابل سقف ${limit} ₪. هل تريد المتابعة؟` };
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
    vaultRecalculation: vaultRecalculation.map((r: any) => r?.salaryCycle?.cycleId).filter(Boolean),
  };
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

  // 2. Smart deletion by criteria (account, amount, category, or most recent)
  const targetAccount = (args.account || args.fromAccount) ? normalizeAccount(args.account || args.fromAccount) : null;
  const targetAmount = args.amount ? parsePositiveFinancialAmount(args.amount) : null;

  const snapshot = await adminDb.collection('transactions')
    .where('userId', '==', userId)
    .orderBy('createdAt', 'desc')
    .limit(100)
    .get();
  let userTxs = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
  if ((snapshot as any).partial === true || userTxs.length >= 100) {
    return {
      success: false,
      needsClarification: true,
      reason: 'SMART_DELETE_REQUIRES_ID_OR_MORE_DETAILS',
      message: 'لمنع حرق Firestore reads، بحثت فقط في آخر 100 عملية. حدّد العملية بالمعرّف أو أعطني تفاصيل أدق قبل الحذف.',
      candidates: userTxs.slice(0, 5).map((t:any) => ({ id:t.id, amount:t.amount, category:t.category, subcategory:t.subcategory, merchant:t.merchant, date:t.date, account:t.account, notes:t.notes }))
    };
  }

  // Sort descending by date/createdAt within the bounded candidate set.
  userTxs.sort((a: any, b: any) => new Date(b.createdAt || b.date || 0).getTime() - new Date(a.createdAt || a.date || 0).getTime());

  if (targetAccount) {
    userTxs = userTxs.filter((t: any) => normalizeAccount(t.account) === targetAccount || normalizeAccount(t.fromAccount) === targetAccount || normalizeAccount(t.toAccount) === targetAccount);
  }

  if (targetAmount) {
    userTxs = userTxs.filter((t: any) => Math.abs(parsePositiveFinancialAmount(t.amount) - targetAmount) < 0.01);
  }

  if (args.category) {
    userTxs = userTxs.filter((t: any) => matchesArabicCategory(t, args.category));
  }

  if (userTxs.length > 1 && !args.id) {
    return {
      success: false,
      needsClarification: true,
      reason: 'AMBIGUOUS_DELETE',
      message: `وجدت ${userTxs.length} عمليات مطابقة. حدد العملية أو أعطني تفاصيل إضافية قبل الحذف.`,
      candidates: userTxs.slice(0, 5).map((t:any) => ({ id:t.id, amount:t.amount, category:t.category, subcategory:t.subcategory, merchant:t.merchant, date:t.date, account:t.account, notes:t.notes }))
    };
  }

  // V6 (MF-6): smart-delete with a single candidate must STILL request confirmation.
  // Silent destructive mutations based on AI guessing are not acceptable.
  if (userTxs.length === 1 && !args.id) {
    const toDelete = userTxs[0];
    return {
      success: false,
      needsClarification: true,
      reason: 'CONFIRM_SINGLE_SMART_DELETE',
      message: `وجدت عملية واحدة مطابقة. هل تقصد حذفها؟`,
      candidate: { id: toDelete.id, amount: toDelete.amount, category: toDelete.category, subcategory: toDelete.subcategory, merchant: toDelete.merchant, date: toDelete.date, account: toDelete.account, notes: toDelete.notes }
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
      deletedTransaction: toDelete, 
      message: `تم حذف عملية بقيمة ${toDelete.amount} ₪ من حساب ${accName} بنجاح.`,
      currentBalances: atomicResult.balances,
      vaultRecalculation: vaultRecalculation.map((r: any) => r?.salaryCycle?.cycleId).filter(Boolean) 
    };
  }

  return { success: false, message: "لم يتم العثور على عملية مطابقة لحذفها. يرجى تحديد المبلغ أو اسم الحساب." };
}

function matchesRecentDeleteKind(tx: any, kind: string): boolean {
  const transactionType = String(tx?.transactionType || '');
  const type = String(tx?.type || '');
  if (kind === 'debt_payment') return transactionType === 'DEBT_PAYMENT' || (type === 'transfer' && normalizeLedgerAccount(tx?.toAccount) === 'debt');
  if (kind === 'expense') return type === 'expense';
  if (kind === 'credit_purchase') return type === 'expense' && (transactionType === 'CREDIT_PURCHASE' || normalizeLedgerAccount(tx?.account) === 'debt');
  if (kind === 'income') return type === 'income';
  return true;
}

export async function deleteRecentTransactions(args: any, userId: string, token: string) {
  const adminDb = getDb(token);
  console.log('TOOL CALL: deleteRecentTransactions', args);
  const count = Math.max(1, Math.min(10, Number(args?.count) || 1));
  const kindRaw = normalizeArabicText(args?.kind || args?.type || args?.transactionKind || 'expense');
  const kind = kindRaw.includes('سداد') || kindRaw.includes('دين') && kindRaw.includes('دفع')
    ? 'debt_payment'
    : kindRaw.includes('شراء') && kindRaw.includes('دين')
      ? 'credit_purchase'
      : kindRaw.includes('دخل') || kindRaw.includes('راتب')
        ? 'income'
        : kindRaw.includes('الكل') || kindRaw.includes('اي') || kindRaw === 'all'
          ? 'all'
          : 'expense';
  const confirmed = args?.confirmed === true || args?.confirmation === 'DELETE_RECENT_TRANSACTIONS';
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
    return { success: false, reason: deleteResult.reason, requested: count, found: deleteResult.found, message: 'تعذر حذف آخر العمليات بأمان؛ قد تكون تغيّرت قبل تنفيذ الحذف.' };
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
  // Reuse the documents already fetched above. Calling getUserBudgets() here
  // would read the same Firestore budget subcollection a second time on every
  // dashboard refresh.
  const userBudgets: Record<string, number> = { ...DEFAULT_BUDGETS };
  customBudgetDocs.forEach((b) => {
    if (b.limit) userBudgets[b.category || b.id] = Number(b.limit);
  });
  
  const now = new Date();
  const thisMonth = now.toISOString().slice(0, 7);
  const monthStart = `${thisMonth}-01`;
  const nextMonthDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  const nextMonthStart = nextMonthDate.toISOString().slice(0, 10);

  let txDocs: any[] = [];
  let partial = false;
  let queryError = '';
  try {
    const txSnapshot = await adminDb.collection('transactions')
      .where('userId', '==', userId)
      .where('date', '>=', monthStart)
      .where('date', '<', nextMonthStart)
      .get();
    txDocs = txSnapshot.docs;
  } catch (rangeErr: any) {
    // If the range query needs a composite index or quota is exhausted, do not
    // publish a partially sampled spending total as if it were authoritative.
    // Returning partial=true lets the UI keep the last-known-good budget view.
    console.warn('[budgets] monthly range query failed; returning partial budget totals:', rangeErr);
    partial = true;
    queryError = rangeErr?.message || 'monthly budget range query failed';
    txDocs = [];
  }

  const monthExpenses = txDocs
    .map((d: any) => ({ id: d.id, ...d.data() }))
    .filter((t: any) => t.type === 'expense' && String(t.date || '').startsWith(thisMonth));

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
    defaultBudgetCount: Object.keys(DEFAULT_BUDGETS).length,
    partial,
    queryError: partial ? queryError : undefined
  };
}

export async function checkBudgetStatus(args: any, userId: string, token: string) {
  const adminDb = getDb(token);
  console.log("TOOL CALL: checkBudgetStatus", args);
  
  const userBudgets = await getUserBudgets(userId, adminDb);
  const now = new Date();
  const thisMonth = now.toISOString().slice(0, 7);
  const monthStart = `${thisMonth}-01T00:00:00.000Z`;
  const nextMonthDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  const nextMonthStart = `${nextMonthDate.toISOString().slice(0, 10)}T00:00:00.000Z`;
  const txSnapshot = await adminDb.collection('transactions')
    .where('userId', '==', userId)
    .where('date', '>=', monthStart)
    .where('date', '<', nextMonthStart)
    .limit(300)
    .get();
  const expenses = txSnapshot.docs.map(d => d.data()).filter(t => t.type === 'expense');
  
  if (args.category) {
    const categoryExpenses = expenses.filter(t => t.category === args.category);
    const spent = categoryExpenses.reduce((sum, t) => sum + parsePositiveFinancialAmount(t.amount), 0);
    const limit = userBudgets[args.category] || DEFAULT_BUDGETS[args.category] || 1000;
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
  const totalPercentage = Math.round((totalSpent / (totalLimit || 1)) * 100);
  
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

export async function getCommitments(args: any, userId: string, token: string) {
  const adminDb = getDb(token);
  const limit = Math.max(1, Math.min(300, Number(args?.limit) || 100));
  const snapshot = await adminDb.collection('commitments')
    .where('userId', '==', userId)
    .orderBy('dueDate', 'asc')
    .limit(limit)
    .get();
  const commitments = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
  
  const now = new Date();
  const enriched = commitments.map((c: any) => {
    const due = new Date(c.dueDate);
    const diffMs = due.getTime() - now.getTime();
    const daysRemaining = Math.ceil(diffMs / (1000 * 60 * 60 * 24));
    // V6: paid/cancelled commitments keep their explicit status — don't override with isOverdue.
    const explicitStatus = c.status && ['pending', 'paid', 'cancelled'].includes(c.status) ? c.status : null;
    const isDueSoon = explicitStatus === 'pending' && daysRemaining >= 0 && daysRemaining <= 3;
    const isOverdue = explicitStatus === 'pending' && daysRemaining < 0;
    return {
      ...c,
      daysRemaining,
      isDueSoon,
      isOverdue,
      status: explicitStatus || (isOverdue ? 'overdue' : isDueSoon ? 'due_soon' : 'upcoming')
    };
  });

  enriched.sort((a, b) => new Date(a.dueDate).getTime() - new Date(b.dueDate).getTime());
  return { commitments: enriched, partial: Boolean((snapshot as any).partial || commitments.length >= limit), limit, readEfficiency: { commitmentDocsRead: commitments.length, limit } };
}

export async function createCommitment(args: any, userId: string, token: string) {
  const adminDb = getDb(token);
  const docRef = adminDb.collection('commitments').doc();
  const commitment = {
    userId,
    title: args.title || 'التزام مجدول',
    amount: parsePositiveFinancialAmount(args.amount),
    dueDate: args.dueDate || new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    category: args.category || 'أقساط والتزامات',
    notes: args.notes || '',
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

export async function getTreasurerProfile(args: any, userId: string, token: string) {
  const adminDb = getDb(token);
  const ref = adminDb.collection('users').doc(userId).collection('treasurer').doc('profile');
  const snap = await ref.get();
  const profile = snap.exists ? snap.data() : {
    monthlySalary: 0,
    salaryDay: null,
    cashReserveTarget: 0,
    savingsRateTarget: 10,
    strictness: 'balanced',
    currency: 'ILS',
    locale: 'Gaza/Palestine',
    createdAt: null,
    updatedAt: null
  };
  return { success: true, profile };
}

export async function updateTreasurerProfile(args: any, userId: string, token: string) {
  const adminDb = getDb(token);
  const ref = adminDb.collection('users').doc(userId).collection('treasurer').doc('profile');
  const patch: any = { updatedAt: new Date().toISOString() };
  if (args.monthlySalary !== undefined) patch.monthlySalary = parsePositiveFinancialAmount(args.monthlySalary);
  if (args.salaryDay !== undefined) patch.salaryDay = args.salaryDay ? Number(args.salaryDay) : null;
  if (args.cashReserveTarget !== undefined || args.reserveTarget !== undefined) patch.cashReserveTarget = parsePositiveFinancialAmount(args.cashReserveTarget ?? args.reserveTarget);
  if (args.savingsRateTarget !== undefined) patch.savingsRateTarget = Math.max(0, Math.min(80, Number(args.savingsRateTarget) || 0));
  if (args.strictness !== undefined) patch.strictness = String(args.strictness || 'balanced');
  if (args.locale !== undefined) patch.locale = String(args.locale || 'Gaza/Palestine');
  if (args.notes !== undefined) patch.notes = String(args.notes || '');
  const snap = await ref.get();
  if (!snap.exists) patch.createdAt = new Date().toISOString();
  await ref.set({ ...(snap.exists ? snap.data() : {}), ...patch });
  return { success: true, profile: { ...(snap.exists ? snap.data() : {}), ...patch } };
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
  // reaches the limit.
  const snap = await firebaseAdminDb.collection('transactions')
    .where('date', '>=', period.startIso)
    .where('date', '<', period.endExclusiveIso)
    .limit(boundedLimit)
    .get();
  const broadDocs = snap.docs || [];
  const transactions = broadDocs
    .filter((d: any) => d.data()?.userId === userId)
    .map((d: any) => ({ id: d.id, ...d.data() }))
    .sort((a: any, b: any) => String(a.date || '').localeCompare(String(b.date || '')));
  const limitReached = broadDocs.length >= boundedLimit;
  logFirestoreReadDiagnostics('salary_cycle_transactions_query', {
    userId,
    queryType: 'transactions_by_date_range_then_user_filter_no_composite_index',
    cycleId: period.cycleId,
    start: period.cycleStart,
    endExclusive: period.cycleEndExclusive,
    returnedDocs: transactions.length,
    scannedDateWindowDocs: broadDocs.length,
    limit: boundedLimit,
    limitReached,
    durationMs: Date.now() - startedAt,
    fallback: false,
  });
  return { transactions, partial: limitReached, boundedFallback: false, error: '', limit: boundedLimit, limitReached };
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
      netDebtChange: summary.netDebtChange,
      sourceVersion: stableDocId(`${period.cycleId}:${summary.totalIncome}:${summary.totalInflow}:${summary.debtCashInflow}:${summary.totalExpense}:${summary.debtCreated}:${summary.debtPaid}:${summary.transactionCount}:${nextVaultContribution}`),
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
  const period: SalaryCyclePeriod = args?.__period || resolveSalaryCycleFromArgs(args || {}, new Date());
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
  const first = await recalculateSalaryCycle({ ...(args || {}), reason: 'salary_cycle_summary_tool' }, userId, token);
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

function summarizeCycleTransactionLists(transactions: any[]) {
  const income: any[] = [];
  const expenses: any[] = [];
  const transfers: any[] = [];
  const debtBorrowing: any[] = [];
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
      expenses.push(item);
      byCategory[category] = byCategory[category] || { count: 0, totalAmount: 0 };
      byCategory[category].count += 1;
      byCategory[category].totalAmount = roundMoney(byCategory[category].totalAmount + amount);
    }
  }
  return { income, expenses, transfers, debtBorrowing, byCategory };
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
    byCategory: lists.byCategory,
    counts: {
      total: readResult.transactions.length,
      income: lists.income.length,
      expenses: lists.expenses.length,
      transfers: lists.transfers.length,
      debtBorrowing: lists.debtBorrowing.length,
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

  const monthRequested = parseSalaryCycleMonth(args.salaryMonth ?? args.month ?? args.monthNumber) !== null;
  const salaryCycleRequested = Boolean(args.salaryCycle || args.cycleId || args.salaryMonth || args.monthNumber)
    || period === 'salary_cycle'
    || period === 'current_salary_cycle'
    || period === 'previous_salary_cycle'
    || (period === 'this_month' && !explicitCalendarMonth)
    || (monthRequested && !explicitCalendarMonth);

  if (salaryCycleRequested) {
    const cycleArgs = period === 'previous_salary_cycle'
      ? { ...(args || {}), period: 'previous' }
      : args;
    salaryCyclePeriod = resolveSalaryCycleFromArgs(cycleArgs || {}, now);
    startIso = salaryCyclePeriod.startIso;
    endExclusiveIso = salaryCyclePeriod.endExclusiveIso;
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

  let snapshot: any;
  let boundedFallback = false;
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
      // wrong month for salary-cycle questions, so it is deliberately rejected.
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

  let filtered = snapshot.docs.map((d: any) => ({ id: d.id, ...d.data() }));
  
  if (args.type) {
    filtered = filtered.filter((t: any) => t.type === args.type);
  }

  if (args.category && args.category !== 'all' && args.category !== 'الكل' && args.category !== 'كافة البنود') {
    filtered = filtered.filter((t: any) => matchesArabicCategory(t, args.category));
  }

  if (args.account) {
    filtered = filtered.filter((t: any) => t.account === args.account);
  }

  if (args.necessity) {
    filtered = filtered.filter((t: any) => t.necessity === args.necessity);
  }

  if (startIso) filtered = filtered.filter((t: any) => String(t.date || t.createdAt || '') >= startIso);
  if (endExclusiveIso) filtered = filtered.filter((t: any) => String(t.date || t.createdAt || '') < endExclusiveIso);

  filtered.sort((a: any, b: any) => new Date(b.date || b.createdAt || 0).getTime() - new Date(a.date || a.createdAt || 0).getTime());

  const total = roundMoney(filtered.reduce((sum, t: any) => sum + parsePositiveFinancialAmount(t.amount), 0));
  const summary = summarizeTransactionsForTool(filtered);
  const salaryCycleCashFlow = salaryCyclePeriod ? summarizeSalaryCycleTransactions(filtered) : null;
  const debtQuestionText = normalizeArabicText(`${args.userText || ''} ${args.currentUserText || ''} ${args.category || ''} ${args.account || ''} ${args.type || ''}`);
  const wantsDebtSummary = Boolean(salaryCyclePeriod && (debtQuestionText.includes('دين') || debtQuestionText.includes('ديون') || args.account === 'debt'));
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
  const timeframe = String(args?.timeframe || args?.period || 'month');
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
  if (timeframe === 'today') {
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

  let txQuery: any = adminDb.collection('transactions').where('userId', '==', userId);
  if (startIso) txQuery = txQuery.where('date', '>=', startIso);
  if (endExclusiveIso && timeframe !== 'all') txQuery = txQuery.where('date', '<', endExclusiveIso);
  if (timeframe !== 'all') txQuery = txQuery.limit(1000);
  const [txSnapshot, budgets, savingsSnap] = await Promise.all([
    txQuery.get(),
    getUserBudgets(userId, adminDb),
    adminDb.collection('users').doc(userId).collection('savingsGoals').limit(100).get().catch(() => ({ docs: [] }))
  ]);
  if ((txSnapshot as any).partial === true || (timeframe !== 'all' && txSnapshot.docs.length >= 1000)) {
    return { success: false, partial: true, retryable: true, reason: 'TREASURER_REPORT_QUERY_INCOMPLETE', message: 'لا أستطيع إصدار تقرير أمين صندوق دقيق لأن قراءة الفترة جزئية أو وصلت حدها. استخدم فترة أصغر أو pagination.' };
  }
  const txs = txSnapshot.docs.map((d: any) => ({ id: d.id, ...d.data() }));
  const savingsGoals = (savingsSnap as any).docs.map((d: any) => ({ id: d.id, ...d.data() }));
  const report = buildTreasurerReport({ ...args, timeframe }, txs, budgets, savingsGoals);
  if (args?.save !== false) {
    const reportRef = adminDb.collection('reports').doc();
    await reportRef.set({
      userId,
      type: 'treasurer',
      title: report.title,
      content: JSON.stringify(report, null, 2),
      data: report,
      createdAt: new Date().toISOString(),
      readEfficiency: { timeframe, startIso: startIso || null, endExclusiveIso: timeframe === 'all' ? null : endExclusiveIso, transactionDocsRead: txs.length, savingsGoalLimit: 100 }
    });
    return { success: true, reportId: reportRef.id, report, readEfficiency: { transactionDocsRead: txs.length, timeframe } };
  }
  return { success: true, report, readEfficiency: { transactionDocsRead: txs.length, timeframe } };
}

// In-memory cache to guard against rapid duplicate tool calls
const recentMutations = new Map<string, { result: any; timestamp: number }>();

function getMutationKey(name: string, args: any, userId: string): string {
  const cleanArgs: any = {};
  for (const k of Object.keys(args || {}).sort()) {
    // Ignore internal fields or timestamps if any
    if (k === 'date' || k === 'createdAt') continue;
    if (args[k] !== undefined && args[k] !== null && args[k] !== '') {
      cleanArgs[k] = typeof args[k] === 'number' ? Math.round(args[k] * 100) / 100 : String(args[k]).trim().toLowerCase();
    }
  }
  // For money transfers or debts or transactions, ensure amount and accounts create a strong deduplication key
  return `${userId}:${name}:${JSON.stringify(cleanArgs)}`;
}

function wrapWithDeduplication(name: string, fn: (args: any, userId: string, token: string) => Promise<any>) {
  const mutatingTools = ['add_transaction', 'transfer_money', 'pay_debt', 'send_palpay_payment', 'create_commitment', 'delete_transaction', 'delete_recent_transactions', 'update_transaction', 'repair_duplicate_income', 'repair_duplicate_credit_purchase', 'repair_account_balance_snapshot', 'update_treasurer_profile', 'create_savings_goal', 'add_savings_contribution', 'update_savings_goal', 'recalculate_salary_cycle', 'add_savings_vault_adjustment', 'repair_savings_vault_meta', 'save_market_offer'];
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
  repair_duplicate_income: repairDuplicateIncome,
  repair_duplicate_credit_purchase: repairDuplicateCreditPurchase,
  repair_account_balance_snapshot: repairAccountBalanceSnapshot,
  get_balance: getBalance,
  get_financial_decision_context: getFinancialDecisionContext,
  assess_purchase: assessPurchase,
  search_local_market: searchLocalMarket,
  get_market_directory: getMarketDirectory,
  save_market_offer: saveMarketOffer,
  transfer_money: transferMoney,
  pay_debt: payDebt,
  get_recent_transactions: getRecentTransactions,
  audit_financial_duplicates: auditFinancialDuplicates,
  check_budget_status: checkBudgetStatus,
  set_category_budget: setCategoryBudget,
  get_budgets_overview: getBudgetsOverview,
  get_commitments: getCommitments,
  create_commitment: createCommitment,
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
  memory_save: memorySave,
  memory_search: memorySearch,
  create_recurring_item: createRecurringItem,
  search_market_information: searchMarketInformation,
  send_palpay_payment: sendPalPayPayment,
  generate_report: generateReport,
  generate_treasurer_report: generateTreasurerReport,
  delete_report: deleteReport,
  clear_all_reports: clearAllReports
};

export const toolHandlers: Record<string, (args: any, userId: string, token: string) => Promise<any>> = Object.fromEntries(
  Object.entries(rawToolHandlers).map(([name, fn]) => [name, wrapWithDeduplication(name, fn)])
);

export const functionDeclarations = [
  {
    name: "pay_debt",
    description: "يسدد ديناً قائماً لدائن محدد. إذا كان لدى المستخدم أكثر من دائن ولم يحدد لمن السداد، لا تخمن ولا تنفذ: اسأل لمن يريد السداد. اسأل أيضاً عن حساب الدفع إن لم يذكره. لا تستخدم add_transaction لسداد الديون.",
    parameters: {
      type: "object",
      properties: {
        amount: { type: "number", description: "المبلغ المسدد بالشيكل" },
        paymentMethod: { type: "string", description: "طريقة السداد والحساب المدفوع منه: 'cash' (نقداً/كاش) أو 'palPay' (محفظة بال باي)" },
        creditor: { type: "string", description: "اسم الدائن كما ذكره المستخدم؛ لا تخمن الاسم عند وجود أكثر من دائن." },
        operationId: { type: "string", description: "معرف ثابت اختياري للعملية عند إعادة المحاولة أو المزامنة" },
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
    description: "يجلب الملف المالي الشخصي لأمين الصندوق: الراتب، يوم الراتب، هدف الاحتياطي، نسبة الادخار المستهدفة، ومستوى الصرامة.",
    parameters: { type: "object", properties: {} }
  },
  {
    name: "update_treasurer_profile",
    description: "يحدث ملف أمين الصندوق الشخصي. استخدمه في onboarding أو عندما يقول المستخدم راتبي كذا، يوم الراتب كذا، بدي احتياطي أمان، أو بدي صرامة أعلى.",
    parameters: {
      type: "object",
      properties: {
        monthlySalary: { type: "number", description: "الراتب الشهري المتوقع" },
        salaryDay: { type: "number", description: "يوم نزول الراتب من 1 إلى 31" },
        cashReserveTarget: { type: "number", description: "حد الأمان/الاحتياطي النقدي المطلوب" },
        savingsRateTarget: { type: "number", description: "نسبة الادخار المستهدفة من الدخل" },
        strictness: { type: "string", description: "gentle, balanced, strict" },
        locale: { type: "string", description: "المنطقة/السوق المحلي، الافتراضي غزة/فلسطين" },
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
    description: "يستخرج وينشئ تقريراً مالياً هيكلياً مفصلاً جداً يحتوي على بند الصرف الرئيسي وتحته بنود الصرف الفرعية وكل بند فرعي تحته تفصيل الدفع (اليوم والتاريخ، المبلغ، البيان/شو اشترى، المتجر، طريقة الدفع كاش/PalPay/دين، هل ضروري أو كمالي)، ويحفظه في حافظة المهام للمستخدم ليتمكن من طباعته أو تصديره لـ Word/PDF.",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: "عنوان التقرير (مثال: 'التقرير المالي التفصيلي الشامل', 'تقرير مصروفات الأبناء', 'تقرير زيارات وضيافة')" },
        timeframe: { type: "string", description: "الفترة: 'current_salary_cycle' أو 'salary_cycle' أو 'custom' أو 'today' أو 'week' أو 'all'. أي شهر يعني دورة راتب 27→26 وليس شهر ميلادي إلا إذا calendarMonth=true" },
        month: { type: "string", description: "رقم/اسم شهر دورة الراتب للتقرير؛ شهر 7 يعني 27/06→26/07" },
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
    description: "ينشئ تقرير أمين الصندوق المتقدم: شهري/ربعي/سنوي/مخصص، مع تفصيل كل شهر، البنود الرئيسية والفرعية، المتاجر، طرق الدفع، الضروري والكمالي، أعلى المصروفات، التجاوزات، مؤشرات الادخار، وبيانات جاهزة للرسم البياني. استخدمه لأي سؤال تقريري عميق مثل: كم صرفت على الأبناء في شهر كذا؟ أو تقرير سنوي مفصل.",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: "عنوان التقرير" },
        period: { type: "string", description: "today, week, month, quarter, year, all أو custom" },
        year: { type: "number", description: "السنة عند التقرير السنوي أو الربعي أو شهر محدد" },
        quarter: { type: "number", description: "رقم الربع 1-4" },
        month: { type: "number", description: "رقم الشهر 1-12" },
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
    name: "assess_purchase",
    description: "يقيّم شراءً قبل تنفيذه مقابل الرصيد، معدل الصرف، الالتزامات والموازنة. لا يسجل أي عملية.",
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
    description: "يسجل عملية مالية بدقة (مصروف أو دخل). ❌ممنوع استخدام هذه الأداة لسداد الديون❌ لسداد الديون استخدم أداة pay_debt حصراً.",
    parameters: {
      type: "object",
      properties: {
        amount: { type: "number", description: "المبلغ بالشيكل (مثال: 120)" },
        type: { type: "string", description: "نوع العملية: 'expense' (مصروف) أو 'income' (دخل)" },
        account: { type: "string", description: "اسم الحساب: 'cash', 'palPay', أو 'debt'" },
        category: { type: "string", description: "بند الصرف الرئيسي (مثال: 'الأبناء', 'زيارات وضيافة', 'طعام ومشتريات منزل', 'مواصلات', 'فواتير والتزامات', 'صحة وعلاج', 'تعليم')" },
        subcategory: { type: "string", description: "بند الصرف الفرعي (مثال تحت الأبناء: 'مصروف', 'ملابس', 'رسوم جامعة ومدرسة', 'دورة رسم', 'مستلزمات مدرسية', 'علاج' / وتحت زيارات: 'هدايا', 'مواصلات زيارة', 'ضيافة')" },
        purchaseItem: { type: "string", description: "ما الذي تم شراؤه تحديداً؟ مثال: ملابس، علاج، تموين، حذاء، مستلزمات مدرسة. مهم لبناء id القيد ومنع التكرار الصحيح." },
        beneficiary: { type: "string", description: "لمن/لأي غرض؟ مثال: الأولاد، الزوجة، البيت، العمل، علاج. مهم لتمييز قيدين بنفس المبلغ ونفس المتجر." },
        merchant: { type: "string", description: "اسم المتجر أو الجهة أو الشخص (مثال: 'مكتبة النور', 'سوبرماركت البركة', 'محل ملابس')" },
        notes: { type: "string", description: "البيان وتفصيل شو اشترى أو ملاحظات إضافية" },
        paymentMethod: { type: "string", description: "طريقة الدفع: 'cash' (نقدي/كاش), 'palPay' (محفظة), أو 'debt' (دين/آجل)." },
        date: { type: "string", description: "تاريخ العملية إذا كانت قديمة أو محددة. استخدم YYYY-MM-DD أو DD/MM/YYYY أو تاريخ قصير مثل 27/6؛ راتب 27/6 هو راتب دورة شهر 7 لأن الدورة 27→26." },
        historicalMonth: { type: "string", description: "شهر إدخال تاريخي بصيغة YYYY-MM أو M/YYYY عند قول المستخدم: أسجل مصروفات شهر 6/2026. لا تستخدمه وحده بدون day." },
        day: { type: "number", description: "يوم العملية داخل historicalMonth. إذا لم يذكر اليوم في إدخال تاريخي، اسأل عنه ولا تخترع تاريخاً." },
        necessity: { type: "string", description: "اختياري. تصنيف الأهمية: 'ضروري' أو 'كمالي'. لا تطلبه من المستخدم إذا كان وصف الشراء واضحاً؛ اتركه فارغاً ليصنفه النظام وفق واقع غزة." },
        riskConfirmed: { type: "boolean", description: "true فقط إذا حذر النظام المستخدم من تجاوز/خطر مالي ووافق صراحة على المتابعة." },
        duplicateConfirmed: { type: "boolean", description: "true فقط إذا أخبر النظام المستخدم بوجود عملية سابقة قريبة وسأله هل هذه عملية جديدة مستقلة، ثم أكد المستخدم صراحة أنها جديدة. لا تستخدمها من نفسك." },
        confirmedNewTransaction: { type: "boolean", description: "مرادف duplicateConfirmed للتأكيد الصريح أن القيد الجديد مستقل عن القيد السابق." }
      },
      required: ["amount", "type", "category", "subcategory", "paymentMethod"]
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
    description: "يحول مبلغاً بين الحسابات والمحافظ (مثلاً: من الكاش إلى بال باي PalPay أو العكس). التحويل الداخلي لا يعتبر دخلاً ولا مصروفاً بل ينقل الرصيد بدقة.",
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
    description: "يجلب أحدث العمليات المالية. مفيد لمعرفة الـ id لتعديل أو حذف عملية.",
    parameters: {
      type: "object",
      properties: {}
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
    description: "يحذف عملية مالية سابقة. يمكن استخدام id صريح، أو البحث بـ account/amount/category. عند تطابق عملية واحدة فقط، يجب تمرير confirmed=true بعد عرض العملية على المستخدم. لا تحذف أبداً بصمت.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "معرف العملية (id) إن كان متوفراً" },
        account: { type: "string", description: "الحساب: 'palPay' (بال باي), 'cash' (نقدي), أو 'debt' (دين)" },
        amount: { type: "number", description: "مبلغ العملية المراد حذفها" },
        category: { type: "string", description: "تصنيف العملية المراد حذفها" },
        confirmed: { type: "boolean", description: "true فقط بعد عرض المرشح الواحد على المستخدم وتأكيده." }
      }
    }
  },
  {
    name: "delete_recent_transactions",
    description: "يحذف آخر N عمليات من نوع محدد فقط عندما يطلب المستخدم ذلك صراحة، مثل: احذف آخر 3 مصروفات، أو احذف آخر عملية تسديد دين. يستخدم قراءة محدودة لآخر العمليات ولا يحذف بصمت؛ إذا لم تكن العبارة واضحة أرجع مرشحين واطلب تأكيداً.",
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
    description: "يجلب ملخصاً محدوداً للعمليات المالية. أي سؤال عن شهر مثل شهر 7/يوليو يفسَّر افتراضياً كـ دورة راتب 27→26 وليس كشهر ميلادي، إلا إذا قال المستخدم صراحة الشهر الميلادي أو أعطى startDate/endDate. لا تطلب custom بلا startDate و endDate. لا تطلب transactions كاملة إلا إذا طلب المستخدم التفاصيل.",
    parameters: {
      type: "object",
      properties: {
        period: { type: "string", description: "الفترة الزمنية: 'today', 'this_week', 'this_month' (تعني دورة الراتب الحالية افتراضياً), 'salary_cycle', 'current_salary_cycle', 'previous_salary_cycle', أو 'custom'" },
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
