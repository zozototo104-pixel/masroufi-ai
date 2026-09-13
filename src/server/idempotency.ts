/**
 * Persistent idempotency gate for financial mutations.
 *
 * Rules:
 * - Every financial write must have an operationId.
 * - operationId is hashed before being used as Firestore doc id.
 * - A duplicate operation returns the first completed result.
 * - A pending duplicate waits outside the Firestore transaction.
 * - If the lock cannot be claimed, fail closed and do not write money.
 */
import { createHash } from 'crypto';
import { adminDb } from './firebaseAdmin';
import { IDEMPOTENCY_COLLECTION } from './idempotencyConfig';
import {
  IDEMPOTENCY_TTL_MS,
  buildCompletedIdempotencyRecord,
  buildIndeterminateIdempotencyRecord,
  buildPendingIdempotencyRecord,
  decideIdempotencyClaim,
  type ClaimDecision,
} from './idempotencyCore';

function idemDocId(userId: string, operationId: string): string {
  return createHash('sha256').update(`${userId}:${operationId}`).digest('hex');
}

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitForCompletedResult(ref: any, attempts = 20): Promise<any> {
  for (let i = 0; i < attempts; i++) {
    await sleep(150);
    const snap = await ref.get();
    const data = snap.exists ? (snap.data() || {}) : {};
    if (data.status === 'completed') return data.result;
    if (data.status === 'failed') return data.result || { success: false, error: 'previous attempt failed' };
  }
  return {
    success: false,
    retryable: true,
    inFlight: true,
    reason: 'IDEMPOTENT_OPERATION_IN_FLIGHT',
    message: 'هذه العملية المالية قيد التنفيذ بالفعل. لم أكرر التسجيل حتى لا يتضاعف القيد.'
  };
}

function resultReachedDurableWrite(result: any): boolean {
  return Boolean(
    result?.success === true ||
    result?.transactionCommitted === true ||
    result?.cloudStorageConfirmed === true ||
    result?.durability === 'committed' ||
    result?.transactionId ||
    result?.commitmentId ||
    result?.goalId ||
    result?.reportId ||
    (Array.isArray(result?.transactionIds) && result.transactionIds.length > 0) ||
    (Array.isArray(result?.deletedTransactionIds) && result.deletedTransactionIds.length > 0)
  );
}

function resultIsSafeToRetryWithoutCaching(result: any): boolean {
  if (resultReachedDurableWrite(result)) return false;
  return Boolean(
    result?.success === false ||
    result?.needsClarification === true ||
    result?.needsConfirmation === true ||
    result?.retryable === true ||
    result?.reason ||
    result?.error
  );
}

export interface IdempotencyOutcome {
  kind: 'cache_hit' | 'cache_miss';
  cachedResult?: any;
  result?: any;
}

export async function runIdempotent(
  userId: string,
  operationId: string | undefined,
  fn: () => Promise<any>,
  allowNonDurableCacheBust = true,
): Promise<IdempotencyOutcome> {
  if (!operationId || typeof operationId !== 'string' || operationId.length < 4) {
    return {
      kind: 'cache_hit',
      cachedResult: {
        success: false,
        retryable: true,
        reason: 'MISSING_OPERATION_ID',
        message: 'رفضت تنفيذ عملية مالية بدون operationId حتى لا تتكرر. أعد المحاولة بعد تحديث التطبيق.'
      }
    };
  }

  const docId = idemDocId(userId, operationId);
  const ref = adminDb.collection(IDEMPOTENCY_COLLECTION).doc(docId);
  const now = Date.now();
  let claim: ClaimDecision;

  try {
    claim = await adminDb.runTransaction(async (tx: any) => {
      const snap = await tx.get(ref);
      const data = snap.exists ? (snap.data() as any) : null;
      const decision = decideIdempotencyClaim(data, now);
      if (decision.action !== 'execute') return decision;

      tx.set(ref, buildPendingIdempotencyRecord(userId, operationId, now, data?.createdAt), { merge: false });
      return decision;
    });
  } catch (err: any) {
    console.error('[idempotency] failed to claim financial operation; refusing unsafe write:', err?.message);
    return {
      kind: 'cache_hit',
      cachedResult: {
        success: false,
        retryable: true,
        reason: 'IDEMPOTENCY_LOCK_FAILED',
        message: 'رفضت تسجيل العملية لأن قفل منع التكرار لم يتأكد. أعد المحاولة بعد لحظات حتى لا يتضاعف المبلغ.',
        error: err?.message || 'idempotency lock failed',
      }
    };
  }

  if (claim.action === 'return') {
    if (allowNonDurableCacheBust && resultIsSafeToRetryWithoutCaching(claim.result)) {
      console.warn('[idempotency] clearing stale non-durable cached validation result and retrying current completed clarification', {
        operationIdPreview: operationId.slice(0, 80),
        reason: claim.result?.reason,
        needsClarification: claim.result?.needsClarification === true,
        needsConfirmation: claim.result?.needsConfirmation === true,
      });
      try {
        await ref.delete();
        return await runIdempotent(userId, operationId, fn, false);
      } catch (deleteErr: any) {
        console.error('[idempotency] failed to clear stale non-durable cached validation result', {
          operationIdPreview: operationId.slice(0, 80),
          deleteError: deleteErr?.message,
        });
      }
    }
    return { kind: 'cache_hit', cachedResult: claim.result };
  }
  if (claim.action === 'wait') {
    const waitedResult = await waitForCompletedResult(ref);
    if (allowNonDurableCacheBust
      && waitedResult?.reason !== 'IDEMPOTENT_OPERATION_IN_FLIGHT'
      && resultIsSafeToRetryWithoutCaching(waitedResult)) {
      console.warn('[idempotency] clearing waited non-durable validation result and retrying completed clarification', {
        operationIdPreview: operationId.slice(0, 80),
        reason: waitedResult?.reason,
      });
      try {
        await ref.delete();
        return await runIdempotent(userId, operationId, fn, false);
      } catch (deleteErr: any) {
        console.error('[idempotency] failed to clear waited non-durable validation result', {
          operationIdPreview: operationId.slice(0, 80),
          deleteError: deleteErr?.message,
        });
      }
    }
    return { kind: 'cache_hit', cachedResult: waitedResult };
  }

  try {
    const result = await fn();
    const completedAt = Date.now();
    if (resultIsSafeToRetryWithoutCaching(result)) {
      // Missing-field/validation answers are part of an ongoing conversation, not
      // a durable financial side effect. Caching them as "completed" makes the
      // next clarification answer return the old "I need X" result instead of
      // reaching add_transaction with the completed data.
      try {
        await ref.delete();
      } catch (deleteErr: any) {
        console.warn('[idempotency] non-durable validation result could not clear pending lock; returning live result anyway', {
          operationIdPreview: operationId.slice(0, 80),
          deleteError: deleteErr?.message,
          reason: result?.reason,
        });
      }
      return { kind: 'cache_miss', result };
    }
    try {
      await ref.set(buildCompletedIdempotencyRecord(userId, operationId, result, completedAt), { merge: true });
    } catch (persistErr: any) {
      console.error('[idempotency] committed result could not be cached; returning canonical tool result instead of reporting a failed ledger write', {
        operationIdPreview: operationId.slice(0, 80),
        persistenceError: persistErr?.message,
        committed: Boolean(result?.success === true && (result?.cloudStorageConfirmed === true || result?.durability === 'committed' || result?.transactionId)),
      });
      if (result?.success === true && (result?.cloudStorageConfirmed === true || result?.durability === 'committed' || result?.transactionId)) {
        return {
          kind: 'cache_miss',
          result: {
            ...result,
            idempotencyCacheWarning: persistErr?.message || 'idempotency completion cache failed after committed write',
          },
        };
      }
      throw persistErr;
    }
    return { kind: 'cache_miss', result };
  } catch (err: any) {
    // Once fn() has started, an exception does NOT prove that its financial side
    // effects rolled back. Persist an indeterminate terminal state and fail closed;
    // a retry with the same operationId must never execute fn() again automatically.
    const indeterminate = buildIndeterminateIdempotencyRecord(userId, operationId, err, Date.now());
    try {
      await ref.set(indeterminate, { merge: true });
    } catch (persistErr: any) {
      console.error('[IDEMPOTENCY] Failed to persist indeterminate outcome', {
        operationIdPreview: operationId.slice(0, 80),
        executionError: err?.message,
        persistenceError: persistErr?.message,
      });
    }
    throw err;
  }
}

export async function purgeExpiredIdempotencyKeys(): Promise<number> {
  const cutoff = Date.now() - IDEMPOTENCY_TTL_MS;
  const snap = await adminDb.collection(IDEMPOTENCY_COLLECTION)
    .where('updatedAt', '<', cutoff)
    .limit(100)
    .get();
  if (snap.size === 0) return 0;
  const batch = adminDb.batch();
  snap.forEach((d: any) => batch.delete(d.ref));
  await batch.commit();
  return snap.size;
}
