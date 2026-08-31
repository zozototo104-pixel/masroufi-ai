/**
 * V6.1 — Atomic Financial Mutations (CONC-01..CONC-05).
 *
 * Wraps balance-sensitive operations (cash expense, PalPay expense, transfers,
 * debt payment, PalPay payment) in Firestore runTransaction to prevent TOCTOU
 * race conditions.
 *
 * Race scenario prevented:
 *   Cash=1000, Request A expense=800, Request B expense=800
 *   Without atomicity: both succeed, Cash=-600 (overspent).
 *   With atomicity: A claims the funds first, B sees insufficient and fails.
 *
 * Implementation: each mutation is added as a NEW transaction document inside
 * a Firestore runTransaction that reads the user's current transaction set,
 * recomputes balances, and rejects if the operation would violate invariants.
 *
 * Note: this is the application-level use of runTransaction (NOT the idempotency
 * layer's transaction which protects against duplicate operationId).
 */
import { adminDb } from './firebaseAdmin';
import { calculateBalances, calculateCreditorRemaining } from '../lib/balanceCalc';

function plainTransactions(docs: any[]): any[] {
  return (docs || []).map((doc: any) => typeof doc?.data === 'function' ? doc.data() : doc);
}

/**
 * V6.2 (FINDING-02): Atomic balance-sensitive transfer.
 *
 * Prevents TOCTOU where two concurrent transfers from the same source wallet
 * both pass the preflight check (insufficient funds guard) but together
 * would drive the wallet below zero.
 *
 * Implementation: runTransaction reads the user's ledger, recomputes balances,
 * rejects if source wallet has insufficient funds, then writes inside the
 * same transaction.
 */
export async function atomicTransferMoney(
  userId: string,
  newTx: any,
  opts: { riskConfirmed?: boolean } = {}
): Promise<{ ok: true; docId: string } | { ok: false; reason: string; available?: number }> {
  return adminDb.runTransaction(async (tx: any) => {
    const snap = await tx.get(
      adminDb.collection('transactions').where('userId', '==', userId)
    );
    const balances = calculateBalances(plainTransactions(snap.docs));
    const amount = Number(newTx.amount) || 0;
    const fromAccount = newTx.fromAccount;
    // Debt source (borrowing) doesn't need balance check (creates new debt).
    if (fromAccount !== 'debt') {
      const available = fromAccount === 'palPay' ? balances.palPay : balances.cash;
      if (amount > available + 0.0001 && !opts.riskConfirmed) {
        return {
          ok: false,
          reason: 'INSUFFICIENT_FUNDS_ATOMIC',
          available: Math.round(available * 100) / 100,
        };
      }
    }
    const newRef = adminDb.collection('transactions').doc();
    tx.set(newRef, { ...newTx, userId, id: newRef.id });
    return { ok: true, docId: newRef.id };
  });
}

/**
 * Atomic guard for a balance-sensitive financial mutation.
 *
 * Flow:
 *   1. Open Firestore runTransaction.
 *   2. Read user's transaction collection atomically.
 *   3. Compute resulting balances (as if the new tx were added).
 *   4. If the resulting cash or palPay would go negative AND the operation
 *      is balance-sensitive (NOT debt): REJECT.
 *   5. If approved: write the new tx document inside the same transaction.
 *
 * @param userId - authenticated UID
 * @param newTx - the transaction document to write (without id)
 * @param opts  - guard options
 * @returns { ok: true, docId } on success, { ok: false, reason } on rejection
 */
export async function atomicAddTransaction(
  userId: string,
  newTx: any,
  opts: {
    /** Skip the cash/palPay negative-balance check (e.g., for debt purchases). */
    skipBalanceCheck?: boolean;
    /** Allow the operation even if it would result in negative balance (riskConfirmed). */
    riskConfirmed?: boolean;
  } = {}
): Promise<{ ok: true; docId: string } | { ok: false; reason: string; available?: number }> {
  return adminDb.runTransaction(async (tx: any) => {
    // Read user's transactions collection (atomic w.r.t. this transaction).
    const snap = await tx.get(
      adminDb.collection('transactions').where('userId', '==', userId)
    );
    const existingDocs = snap.docs;
    const balances = calculateBalances(plainTransactions(existingDocs));

    // Determine the new account impact.
    const account = newTx.account || (newTx.fromAccount === 'cash' || newTx.fromAccount === 'palPay' ? newTx.fromAccount : 'cash');
    const amount = Number(newTx.amount) || 0;
    const type = newTx.type;

    if (!opts.skipBalanceCheck && !opts.riskConfirmed) {
      // For cash/palPay expenses and outbound transfers, check available funds.
      let affectedAccount: 'cash' | 'palPay' | null = null;
      if (type === 'expense' && (account === 'cash' || account === 'palPay')) {
        affectedAccount = account;
      } else if (type === 'transfer' && newTx.fromAccount && newTx.fromAccount !== 'debt') {
        affectedAccount = newTx.fromAccount;
      }
      if (affectedAccount) {
        const available = affectedAccount === 'cash' ? balances.cash : balances.palPay;
        if (amount > available + 0.0001) {
          return {
            ok: false,
            reason: 'INSUFFICIENT_FUNDS_ATOMIC',
            available: Math.round(available * 100) / 100,
          };
        }
      }
    }

    // Approved — write inside the transaction.
    const newRef = adminDb.collection('transactions').doc();
    tx.set(newRef, { ...newTx, userId, id: newRef.id });
    return { ok: true, docId: newRef.id };
  });
}

/**
 * Atomic guard for debt payment (CONC-03).
 *
 * Prevents concurrent payments from exceeding the creditor's remaining debt.
 * Reads all transactions, computes per-creditor remaining debt, then rejects
 * if the payment would exceed it.
 */
export async function atomicUpdateTransaction(
  userId: string,
  transactionId: string,
  finalUpdates: any,
  opts: { riskConfirmed?: boolean } = {}
): Promise<{ ok: true; balances: { cash: number; palPay: number; debt: number; total: number } } | { ok: false; reason: string; balances?: any }> {
  return adminDb.runTransaction(async (tx: any) => {
    const ref = adminDb.collection('transactions').doc(transactionId);
    const targetSnap = await tx.get(ref);
    if (!targetSnap.exists || targetSnap.data()?.userId !== userId) {
      return { ok: false, reason: 'TRANSACTION_NOT_FOUND' };
    }

    const ledgerSnap = await tx.get(adminDb.collection('transactions').where('userId', '==', userId));
    const projected = { ...targetSnap.data(), ...finalUpdates, userId };
    const transactions = ledgerSnap.docs.map((doc: any) => doc.id === transactionId ? projected : doc.data());
    const balances = calculateBalances(transactions);

    if (!opts.riskConfirmed && balances.cash < -0.0001) {
      return { ok: false, reason: 'NEGATIVE_CASH_RESULT', balances };
    }
    if (!opts.riskConfirmed && balances.palPay < -0.0001) {
      return { ok: false, reason: 'NEGATIVE_PALPAY_RESULT', balances };
    }

    tx.update(ref, finalUpdates);
    return { ok: true, balances };
  });
}

export async function atomicDeleteTransaction(
  userId: string,
  transactionId: string,
  opts: { riskConfirmed?: boolean } = {}
): Promise<{ ok: true; deleted: any; balances: { cash: number; palPay: number; debt: number; total: number } } | { ok: false; reason: string; balances?: any }> {
  return adminDb.runTransaction(async (tx: any) => {
    const ref = adminDb.collection('transactions').doc(transactionId);
    const targetSnap = await tx.get(ref);
    if (!targetSnap.exists || targetSnap.data()?.userId !== userId) {
      return { ok: false, reason: 'TRANSACTION_NOT_FOUND' };
    }

    const ledgerSnap = await tx.get(adminDb.collection('transactions').where('userId', '==', userId));
    const remaining = ledgerSnap.docs.filter((doc: any) => doc.id !== transactionId).map((doc: any) => doc.data());
    const balances = calculateBalances(remaining);

    if (!opts.riskConfirmed && balances.cash < -0.0001) {
      return { ok: false, reason: 'NEGATIVE_CASH_RESULT', balances };
    }
    if (!opts.riskConfirmed && balances.palPay < -0.0001) {
      return { ok: false, reason: 'NEGATIVE_PALPAY_RESULT', balances };
    }

    tx.delete(ref);
    return { ok: true, deleted: targetSnap.data(), balances };
  });
}

export async function atomicPayDebt(
  userId: string,
  newTx: any,
  creditorKey: string,
  remainingDebtBeforePayment: number,
  opts: { riskConfirmed?: boolean } = {}
): Promise<{ ok: true; docId: string } | { ok: false; reason: string; remaining?: number }> {
  return adminDb.runTransaction(async (tx: any) => {
    const snap = await tx.get(
      adminDb.collection('transactions').where('userId', '==', userId)
    );
    // Re-compute the creditor's remaining debt AT THIS INSTANT (not the cached value).
    // This is the critical race fix: concurrent payments see the same snapshot only
    // if they're not in the same transaction. With runTransaction, the second payment
    // sees the first payment's write.
    const docs = snap.docs;
    const transactions = plainTransactions(docs);
    const recomputedRemaining = calculateCreditorRemaining(transactions, creditorKey);
    const amount = Number(newTx.amount) || 0;
    if (amount > recomputedRemaining + 0.0001) {
      return {
        ok: false,
        reason: 'OVERPAYMENT_ATOMIC',
        remaining: Math.round(recomputedRemaining * 100) / 100,
      };
    }
    // Also check the source account has funds.
    const balances = calculateBalances(plainTransactions(docs));
    const fromAccount = newTx.fromAccount || newTx.account;
    const available = fromAccount === 'palPay' ? balances.palPay : balances.cash;
    if (amount > available + 0.0001) {
      return {
        ok: false,
        reason: 'INSUFFICIENT_FUNDS_ATOMIC',
        available: Math.round(available * 100) / 100,
      };
    }
    // Approved — write inside the transaction.
    const newRef = adminDb.collection('transactions').doc();
    tx.set(newRef, { ...newTx, userId, id: newRef.id });
    return { ok: true, docId: newRef.id };
  });
}

