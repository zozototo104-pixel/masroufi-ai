/**
 * Atomic Financial Mutations.
 *
 * Firestore-read efficient design:
 * - Normal daily mutations read the user's account balance snapshot document and
 *   the target transaction document only.
 * - The full transaction ledger is read only when the balance snapshot is
 *   missing and must be bootstrapped, or by explicit repair/audit flows.
 * - Every balance-sensitive write updates the source transaction and the
 *   account balance snapshot in the same Firestore transaction.
 */
import { createHash } from 'crypto';
import { adminDb } from './firebaseAdmin';
import { parsePositiveFinancialAmount } from '../lib/amount';
import { calculateBalances, calculateCreditorRemaining } from '../lib/balanceCalc';
import {
  addBalanceDelta,
  roundBalance,
  transactionReplacementDelta,
  txBalanceDelta,
  zeroBalanceDelta,
  type AccountBalanceDelta,
} from '../lib/accountBalance';

type FinancialTransactionInput = Record<string, unknown> & {
  id?: unknown;
  userId?: unknown;
  amount?: unknown;
  type?: unknown;
  account?: unknown;
  fromAccount?: unknown;
  toAccount?: unknown;
  operationId?: unknown;
  receiptId?: unknown;
};

type BalanceSnapshot = { cash: number; palPay: number; debt: number; vault: number; total: number };

type FirestoreDocLike = {
  id?: string;
  data?: () => Record<string, unknown>;
};

function plainTransactions(docs: FirestoreDocLike[]): FinancialTransactionInput[] {
  return (docs || []).map((doc) => typeof doc?.data === 'function' ? { id: doc.id, ...doc.data() } : doc as FinancialTransactionInput);
}

function stableReceiptDocId(userId: string, receiptId: string): string {
  return createHash('sha256').update(`${userId}:receipt:${receiptId}`).digest('hex');
}

function stableReceiptItemDocId(userId: string, operationId: string): string {
  return createHash('sha256').update(`${userId}:receipt-item:${operationId}`).digest('hex');
}

function balanceSnapshotRef(userId: string) {
  return adminDb.collection('users').doc(userId).collection('meta').doc('accountBalances');
}

function normalizeBalanceSnapshot(data: any = {}): BalanceSnapshot {
  const cash = roundBalance(Number(data.cash || 0));
  const palPay = roundBalance(Number(data.palPay || 0));
  const debt = roundBalance(Number(data.debt || 0));
  const vault = roundBalance(Number(data.vault || 0));
  return { cash, palPay, debt, vault, total: roundBalance(cash + palPay) };
}

function balanceSnapshotPayload(userId: string, balances: BalanceSnapshot, source: string, extra: Record<string, unknown> = {}) {
  const now = new Date().toISOString();
  return {
    userId,
    cash: roundBalance(balances.cash),
    palPay: roundBalance(balances.palPay),
    debt: roundBalance(balances.debt),
    vault: roundBalance(balances.vault),
    total: roundBalance(balances.cash + balances.palPay),
    source,
    updatedAt: now,
    version: 1,
    ...extra,
  };
}

async function readOrBootstrapBalanceSnapshot(tx: any, userId: string): Promise<{
  ref: any;
  balances: BalanceSnapshot;
  source: 'snapshot' | 'bootstrap_full_ledger';
  ledgerDocsRead: number;
}> {
  const ref = balanceSnapshotRef(userId);
  const snap = await tx.get(ref);
  if (snap.exists) {
    return { ref, balances: normalizeBalanceSnapshot(snap.data() || {}), source: 'snapshot', ledgerDocsRead: 0 };
  }

  // One-time migration path for existing users. This is intentionally inside the
  // same transaction so the first mutation that creates the snapshot is consistent.
  const ledgerSnap = await tx.get(adminDb.collection('transactions').where('userId', '==', userId));
  const balances = calculateBalances(plainTransactions(ledgerSnap.docs));
  return { ref, balances, source: 'bootstrap_full_ledger', ledgerDocsRead: ledgerSnap.docs.length };
}

function aggregateDelta(items: any[]): AccountBalanceDelta {
  return (items || []).reduce((sum: AccountBalanceDelta, item: any) => {
    const delta = txBalanceDelta(item);
    return {
      cash: roundBalance(sum.cash + delta.cash),
      palPay: roundBalance(sum.palPay + delta.palPay),
      debt: roundBalance(sum.debt + delta.debt),
      vault: roundBalance(sum.vault + delta.vault),
    };
  }, zeroBalanceDelta());
}

function negativeBalanceFailure(balances: BalanceSnapshot, riskConfirmed?: boolean): { ok: false; reason: string; balances: BalanceSnapshot } | null {
  if (riskConfirmed) return null;
  if (balances.cash < -0.0001) return { ok: false, reason: 'NEGATIVE_CASH_RESULT', balances };
  if (balances.palPay < -0.0001) return { ok: false, reason: 'NEGATIVE_PALPAY_RESULT', balances };
  if (balances.vault < -0.0001) return { ok: false, reason: 'NEGATIVE_VAULT_RESULT', balances };
  return null;
}

function readAvailableBalance(balances: BalanceSnapshot, account: string): number {
  if (account === 'palPay') return balances.palPay;
  if (account === 'vault') return balances.vault;
  return balances.cash;
}

function insufficientSourceFailure(balances: BalanceSnapshot, amount: number, account: string, riskConfirmed?: boolean): { ok: false; reason: string; available: number } | null {
  if (riskConfirmed) return null;
  const available = readAvailableBalance(balances, account);
  if (amount > available + 0.0001) {
    return { ok: false, reason: account === 'vault' ? 'INSUFFICIENT_VAULT_FUNDS_ATOMIC' : 'INSUFFICIENT_FUNDS_ATOMIC', available: roundBalance(available) };
  }
  return null;
}

function sameReceiptTransaction(existing: FinancialTransactionInput, incoming: FinancialTransactionInput): boolean {
  const existingAmount = parsePositiveFinancialAmount(existing?.amount);
  const incomingAmount = parsePositiveFinancialAmount(incoming?.amount);
  const existingReceiptId = String(existing?.receiptId || '');
  const incomingReceiptId = String(incoming?.receiptId || '');
  const operationId = String(existing?.operationId || '');
  const receiptCompatible = existingReceiptId === incomingReceiptId
    || (!existingReceiptId && incomingReceiptId && operationId.startsWith(`receipt:${incomingReceiptId}:`));
  return operationId === String(incoming?.operationId || '')
    && Math.abs(existingAmount - incomingAmount) < 0.01
    && String(existing?.type || '') === String(incoming?.type || '')
    && String(existing?.account || '') === String(incoming?.account || '')
    && receiptCompatible;
}

export async function atomicTransferMoney(
  userId: string,
  newTx: FinancialTransactionInput,
  opts: { riskConfirmed?: boolean } = {}
): Promise<{ ok: true; docId: string; balances: BalanceSnapshot; balanceReadSource: string } | { ok: false; reason: string; available?: number }> {
  return adminDb.runTransaction(async (tx: any) => {
    const snapshot = await readOrBootstrapBalanceSnapshot(tx, userId);
    const amount = parsePositiveFinancialAmount(newTx.amount);
    const fromAccount = String(newTx.fromAccount || 'cash');
    if (fromAccount !== 'debt') {
      const insufficient = insufficientSourceFailure(snapshot.balances, amount, fromAccount === 'palPay' ? 'palPay' : 'cash', opts.riskConfirmed);
      if (insufficient) return insufficient;
    }

    const balances = addBalanceDelta(snapshot.balances, txBalanceDelta(newTx));
    const negative = negativeBalanceFailure(balances, opts.riskConfirmed);
    if (negative) return negative;

    const newRef = adminDb.collection('transactions').doc();
    tx.set(newRef, { ...newTx, userId, id: newRef.id });
    tx.set(snapshot.ref, balanceSnapshotPayload(userId, balances, 'atomic_transfer_money', {
      lastTransactionId: newRef.id,
      balanceReadSource: snapshot.source,
      bootstrapLedgerDocsRead: snapshot.ledgerDocsRead,
    }), { merge: true });
    return { ok: true, docId: newRef.id, balances, balanceReadSource: snapshot.source };
  });
}

export async function atomicAddTransaction(
  userId: string,
  newTx: FinancialTransactionInput,
  opts: {
    skipBalanceCheck?: boolean;
    riskConfirmed?: boolean;
    uniqueGuard?: {
      ref: any;
      payload?: Record<string, unknown>;
      reason?: string;
    } | null;
  } = {}
): Promise<{ ok: true; docId: string; balances: BalanceSnapshot; balanceReadSource: string } | { ok: false; reason: string; available?: number; balances?: BalanceSnapshot; duplicateGuard?: any }> {
  return adminDb.runTransaction(async (tx: any) => {
    const guardSnap = opts.uniqueGuard?.ref ? await tx.get(opts.uniqueGuard.ref) : null;
    if (guardSnap?.exists && !opts.riskConfirmed) {
      return { ok: false, reason: opts.uniqueGuard?.reason || 'DUPLICATE_GUARDED_TRANSACTION', duplicateGuard: guardSnap.data() || {} };
    }
    const snapshot = await readOrBootstrapBalanceSnapshot(tx, userId);
    const account = String(newTx.account || (newTx.fromAccount === 'cash' || newTx.fromAccount === 'palPay' ? newTx.fromAccount : 'cash'));
    const amount = parsePositiveFinancialAmount(newTx.amount);
    const type = String(newTx.type || '');

    if (!opts.skipBalanceCheck && !opts.riskConfirmed) {
      let affectedAccount: 'cash' | 'palPay' | null = null;
      if (type === 'expense' && (account === 'cash' || account === 'palPay')) affectedAccount = account;
      else if (type === 'transfer' && newTx.fromAccount && newTx.fromAccount !== 'debt') affectedAccount = newTx.fromAccount === 'palPay' ? 'palPay' : 'cash';
      if (affectedAccount) {
        const insufficient = insufficientSourceFailure(snapshot.balances, amount, affectedAccount, opts.riskConfirmed);
        if (insufficient) return insufficient;
      }
    }

    const balances = addBalanceDelta(snapshot.balances, txBalanceDelta(newTx));
    const negative = opts.skipBalanceCheck ? null : negativeBalanceFailure(balances, opts.riskConfirmed);
    if (negative) return negative;

    const newRef = adminDb.collection('transactions').doc();
    tx.set(newRef, { ...newTx, userId, id: newRef.id });
    if (opts.uniqueGuard?.ref) {
      tx.set(opts.uniqueGuard.ref, {
        ...(opts.uniqueGuard.payload || {}),
        userId,
        transactionId: newRef.id,
        createdAt: new Date().toISOString(),
      }, { merge: false });
    }
    tx.set(snapshot.ref, balanceSnapshotPayload(userId, balances, 'atomic_add_transaction', {
      lastTransactionId: newRef.id,
      balanceReadSource: snapshot.source,
      bootstrapLedgerDocsRead: snapshot.ledgerDocsRead,
    }), { merge: true });
    return { ok: true, docId: newRef.id, balances, balanceReadSource: snapshot.source };
  });
}

export async function atomicUpdateTransaction(
  userId: string,
  transactionId: string,
  finalUpdates: any,
  opts: { riskConfirmed?: boolean; skipBalanceRecalculation?: boolean } = {}
): Promise<{ ok: true; balances?: BalanceSnapshot; balanceReadSource?: string } | { ok: false; reason: string; balances?: any }> {
  return adminDb.runTransaction(async (tx: any) => {
    const ref = adminDb.collection('transactions').doc(transactionId);
    const targetSnap = await tx.get(ref);
    if (!targetSnap.exists || targetSnap.data()?.userId !== userId) {
      return { ok: false, reason: 'TRANSACTION_NOT_FOUND' };
    }

    if (opts.skipBalanceRecalculation) {
      tx.update(ref, finalUpdates);
      return { ok: true };
    }

    const before = { id: transactionId, ...(targetSnap.data() || {}) };
    const projected = { ...before, ...finalUpdates, userId };
    const snapshot = await readOrBootstrapBalanceSnapshot(tx, userId);
    const balances = addBalanceDelta(snapshot.balances, transactionReplacementDelta(before, projected));
    const negative = negativeBalanceFailure(balances, opts.riskConfirmed);
    if (negative) return negative;

    tx.update(ref, finalUpdates);
    tx.set(snapshot.ref, balanceSnapshotPayload(userId, balances, 'atomic_update_transaction', {
      lastTransactionId: transactionId,
      balanceReadSource: snapshot.source,
      bootstrapLedgerDocsRead: snapshot.ledgerDocsRead,
    }), { merge: true });
    return { ok: true, balances, balanceReadSource: snapshot.source };
  });
}

export async function atomicDeleteTransaction(
  userId: string,
  transactionId: string,
  opts: { riskConfirmed?: boolean } = {}
): Promise<{ ok: true; deleted: any; balances: BalanceSnapshot; balanceReadSource: string } | { ok: false; reason: string; balances?: any }> {
  return adminDb.runTransaction(async (tx: any) => {
    const ref = adminDb.collection('transactions').doc(transactionId);
    const targetSnap = await tx.get(ref);
    if (!targetSnap.exists || targetSnap.data()?.userId !== userId) {
      return { ok: false, reason: 'TRANSACTION_NOT_FOUND' };
    }

    const before = { id: transactionId, ...(targetSnap.data() || {}) };
    const snapshot = await readOrBootstrapBalanceSnapshot(tx, userId);
    const balances = addBalanceDelta(snapshot.balances, transactionReplacementDelta(before, null));
    const negative = negativeBalanceFailure(balances, opts.riskConfirmed);
    if (negative) return negative;

    tx.delete(ref);
    tx.set(snapshot.ref, balanceSnapshotPayload(userId, balances, 'atomic_delete_transaction', {
      lastTransactionId: transactionId,
      balanceReadSource: snapshot.source,
      bootstrapLedgerDocsRead: snapshot.ledgerDocsRead,
    }), { merge: true });
    return { ok: true, deleted: targetSnap.data(), balances, balanceReadSource: snapshot.source };
  });
}

export async function atomicDeleteTransactions(
  userId: string,
  transactionIds: string[],
  opts: { riskConfirmed?: boolean; guardRefs?: any[]; reason?: string } = {}
): Promise<{ ok: true; deleted: any[]; balances: BalanceSnapshot; balanceReadSource: string } | { ok: false; reason: string; balances?: any; found?: number; requested?: number }> {
  const ids = Array.from(new Set((transactionIds || []).map(id => String(id || '').trim()).filter(Boolean)));
  if (ids.length === 0) return { ok: false, reason: 'NO_TRANSACTIONS_SELECTED', found: 0, requested: 0 };
  if (ids.length > 430) return { ok: false, reason: 'BULK_DELETE_LIMIT_EXCEEDED', found: ids.length, requested: ids.length };

  return adminDb.runTransaction(async (tx: any) => {
    const snapshot = await readOrBootstrapBalanceSnapshot(tx, userId);
    const refs = ids.map(id => adminDb.collection('transactions').doc(id));
    const snaps = await Promise.all(refs.map(ref => tx.get(ref)));
    const deleted = snaps.map((snap: any, index: number) => {
      if (!snap.exists || snap.data()?.userId !== userId) return null;
      return { id: ids[index], ...(snap.data() || {}) };
    }).filter(Boolean) as any[];
    if (deleted.length !== ids.length) {
      return { ok: false, reason: 'BULK_DELETE_TARGET_CHANGED', found: deleted.length, requested: ids.length };
    }

    const delta = deleted.reduce((sum: AccountBalanceDelta, item: any) => addBalanceDelta(sum, transactionReplacementDelta(item, null)), zeroBalanceDelta());
    const balances = addBalanceDelta(snapshot.balances, delta);
    const negative = negativeBalanceFailure(balances, opts.riskConfirmed);
    if (negative) return negative;

    refs.forEach(ref => tx.delete(ref));
    for (const guardRef of opts.guardRefs || []) {
      if (guardRef) tx.delete(guardRef);
    }
    tx.set(snapshot.ref, balanceSnapshotPayload(userId, balances, 'atomic_delete_transactions', {
      deletedTransactionCount: deleted.length,
      balanceReadSource: snapshot.source,
      bootstrapLedgerDocsRead: snapshot.ledgerDocsRead,
      reason: opts.reason || 'bulk_delete',
    }), { merge: true });
    return { ok: true, deleted, balances, balanceReadSource: snapshot.source };
  });
}

export async function atomicAddTransactions(
  userId: string,
  newTransactions: any[],
  opts: { riskConfirmed?: boolean; receiptId?: string; receiptMeta?: any; skipLedgerBalanceCheck?: boolean } = {}
): Promise<
  | { ok: true; docIds: string[]; balances: BalanceSnapshot; idempotentReplay?: boolean; balanceReadSource?: string }
  | { ok: false; reason: string; balances?: any; conflictingTransactionIds?: string[] }
> {
  const receiptId = opts.receiptId ? String(opts.receiptId) : '';

  return adminDb.runTransaction(async (tx: any) => {
    const normalizedNewTransactions = newTransactions.map((item: any) => receiptId ? { ...item, receiptId } : item);
    const receiptRef = receiptId ? adminDb.collection('receiptIdempotency').doc(stableReceiptDocId(userId, receiptId)) : null;
    const receiptSnap = receiptRef ? await tx.get(receiptRef) : null;
    if (receiptSnap?.exists) {
      const record = receiptSnap.data() || {};
      if (record.userId !== userId || record.receiptId !== receiptId) return { ok: false, reason: 'RECEIPT_ID_CONFLICT' };
      if (record.status === 'completed' && Array.isArray(record.docIds)) {
        return {
          ok: true,
          docIds: record.docIds,
          balances: normalizeBalanceSnapshot(record.balances || {}),
          idempotentReplay: true,
          balanceReadSource: 'receipt_idempotency',
        };
      }
      return { ok: false, reason: 'RECEIPT_OUTCOME_INDETERMINATE' };
    }

    let itemRefs: any[] = [];
    let itemSnaps: any[] = [];
    if (receiptId) {
      const operationIds = normalizedNewTransactions.map((item: any) => String(item?.operationId || ''));
      if (operationIds.some((operationId: string) => !operationId)) return { ok: false, reason: 'MISSING_RECEIPT_OPERATION_ID' };
      if (new Set(operationIds).size !== operationIds.length) return { ok: false, reason: 'DUPLICATE_RECEIPT_OPERATION_ID' };
      itemRefs = normalizedNewTransactions.map((item: any) => adminDb.collection('transactions').doc(stableReceiptItemDocId(userId, String(item.operationId))));
      itemSnaps = await Promise.all(itemRefs.map((ref: any) => tx.get(ref)));
      const existingMatches = itemSnaps
        .map((snap: any, index: number) => ({ snap, index, item: normalizedNewTransactions[index] }))
        .filter((row: any) => row.snap.exists);
      if (existingMatches.length > 0) {
        const allRowsAlreadyCommitted = existingMatches.length === normalizedNewTransactions.length
          && existingMatches.every((row: any) => sameReceiptTransaction(row.snap.data() || {}, row.item));
        if (allRowsAlreadyCommitted) {
          const docIds = itemRefs.map((ref: any) => ref.id);
          const snapshot = await readOrBootstrapBalanceSnapshot(tx, userId);
          if (receiptRef) {
            tx.set(receiptRef, {
              userId,
              receiptId,
              status: 'completed',
              docIds,
              operationIds,
              itemCount: normalizedNewTransactions.length,
              balances: snapshot.balances,
              receiptMeta: opts.receiptMeta || null,
              recoveredFromStableReceiptItems: true,
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            });
          }
          return { ok: true, docIds, balances: snapshot.balances, idempotentReplay: true, balanceReadSource: snapshot.source };
        }
        return {
          ok: false,
          reason: 'RECEIPT_OPERATION_CONFLICT',
          conflictingTransactionIds: existingMatches.map((row: any) => row.snap.id).filter(Boolean),
        };
      }
    }

    const snapshot = await readOrBootstrapBalanceSnapshot(tx, userId);
    const balances = addBalanceDelta(snapshot.balances, aggregateDelta(normalizedNewTransactions));
    if (!opts.skipLedgerBalanceCheck) {
      const negative = negativeBalanceFailure(balances, opts.riskConfirmed);
      if (negative) return negative;
    }

    const docIds: string[] = [];
    normalizedNewTransactions.forEach((item: any, index: number) => {
      const ref = receiptId ? itemRefs[index] : adminDb.collection('transactions').doc();
      docIds.push(ref.id);
      tx.set(ref, {
        ...item,
        userId,
        id: ref.id,
        balanceValidation: opts.skipLedgerBalanceCheck ? 'receipt-import-bounded-snapshot' : 'account-balance-snapshot',
      });
    });
    tx.set(snapshot.ref, balanceSnapshotPayload(userId, balances, 'atomic_add_transactions', {
      lastReceiptId: receiptId || null,
      lastTransactionCount: normalizedNewTransactions.length,
      balanceReadSource: snapshot.source,
      bootstrapLedgerDocsRead: snapshot.ledgerDocsRead,
    }), { merge: true });
    if (receiptRef) {
      tx.set(receiptRef, {
        userId,
        receiptId,
        status: 'completed',
        docIds,
        operationIds: normalizedNewTransactions.map((item: any) => item.operationId),
        itemCount: normalizedNewTransactions.length,
        balances,
        balanceScope: 'account-balance-snapshot',
        receiptMeta: opts.receiptMeta || null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
    }
    return { ok: true, docIds, balances, balanceReadSource: snapshot.source };
  });
}

export async function atomicPayDebt(
  userId: string,
  newTx: FinancialTransactionInput,
  creditorKey: string,
  opts: { riskConfirmed?: boolean } = {}
): Promise<{ ok: true; docId: string; balances: BalanceSnapshot; remaining: number; balanceReadSource: string } | { ok: false; reason: string; remaining?: number; available?: number }> {
  return adminDb.runTransaction(async (tx: any) => {
    const snapshot = await readOrBootstrapBalanceSnapshot(tx, userId);
    const creditorSnap = await tx.get(
      adminDb.collection('transactions')
        .where('userId', '==', userId)
        .where('creditorKey', '==', creditorKey)
    );
    const creditorTransactions = plainTransactions(creditorSnap.docs);
    const recomputedRemaining = calculateCreditorRemaining(creditorTransactions, creditorKey);
    const amount = parsePositiveFinancialAmount(newTx.amount);
    if (amount > recomputedRemaining + 0.0001) {
      return { ok: false, reason: 'OVERPAYMENT_ATOMIC', remaining: roundBalance(recomputedRemaining) };
    }

    const fromAccount = String(newTx.fromAccount || newTx.account || 'cash');
    const insufficient = insufficientSourceFailure(snapshot.balances, amount, fromAccount === 'palPay' ? 'palPay' : 'cash', opts.riskConfirmed);
    if (insufficient) return insufficient;

    const balances = addBalanceDelta(snapshot.balances, txBalanceDelta(newTx));
    const negative = negativeBalanceFailure(balances, opts.riskConfirmed);
    if (negative) return negative;

    const newRef = adminDb.collection('transactions').doc();
    tx.set(newRef, { ...newTx, userId, id: newRef.id });
    tx.set(snapshot.ref, balanceSnapshotPayload(userId, balances, 'atomic_pay_debt', {
      lastTransactionId: newRef.id,
      lastCreditorKey: creditorKey,
      balanceReadSource: snapshot.source,
      bootstrapLedgerDocsRead: snapshot.ledgerDocsRead,
      creditorDocsRead: creditorSnap.docs.length,
    }), { merge: true });
    return {
      ok: true,
      docId: newRef.id,
      balances,
      remaining: roundBalance(recomputedRemaining - amount),
      balanceReadSource: snapshot.source,
    };
  });
}
