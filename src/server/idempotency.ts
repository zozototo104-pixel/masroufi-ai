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

const IDEMPOTENCY_COLLECTION = 'idempotency_keys';
const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
const PENDING_STALE_MS = 2 * 60 * 1000;

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

export interface IdempotencyOutcome {
  kind: 'cache_hit' | 'cache_miss';
  cachedResult?: any;
  result?: any;
}

type ClaimResult =
  | { action: 'execute' }
  | { action: 'return'; result: any }
  | { action: 'wait' };

export async function runIdempotent(
  userId: string,
  operationId: string | undefined,
  fn: () => Promise<any>,
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
  let claim: ClaimResult;

  try {
    claim = await adminDb.runTransaction(async (tx: any) => {
      const snap = await tx.get(ref);
      const data = snap.exists ? (snap.data() as any) : null;

      if (data?.status === 'completed') {
        return { action: 'return' as const, result: data.result };
      }

      if (data?.status === 'pending') {
        const age = now - Number(data.updatedAt || data.createdAt || 0);
        if (age < PENDING_STALE_MS) {
          return { action: 'wait' as const };
        }
        // A stale pending operation has an UNKNOWN outcome. The financial mutation
        // may have committed while persisting the idempotency result failed. Never
        // re-execute automatically: exactly-once safety is more important than availability.
        return {
          action: 'return' as const,
          result: {
            success: false,
            retryable: false,
            indeterminate: true,
            reason: 'IDEMPOTENT_OUTCOME_UNKNOWN',
            message: 'تعذر تأكيد نتيجة العملية السابقة بأمان. لن أعيد تنفيذها تلقائياً حتى لا يتكرر القيد المالي.',
          }
        };
      }

      if (data?.status === 'failed' || data?.status === 'indeterminate') {
        return {
          action: 'return' as const,
          result: data.result || {
            success: false,
            retryable: false,
            indeterminate: true,
            reason: 'IDEMPOTENT_OUTCOME_UNKNOWN',
            message: 'نتيجة العملية السابقة غير محسومة، لذلك لن أعيد تنفيذها تلقائياً.'
          }
        };
      }

      tx.set(ref, {
        userId,
        operationId,
        operationIdPreview: operationId.slice(0, 300),
        status: 'pending',
        createdAt: data?.createdAt || now,
        updatedAt: now,
        expiresAt: now + IDEMPOTENCY_TTL_MS,
      }, { merge: false });

      return { action: 'execute' as const };
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

  if (claim.action === 'return') return { kind: 'cache_hit', cachedResult: claim.result };
  if (claim.action === 'wait') return { kind: 'cache_hit', cachedResult: await waitForCompletedResult(ref) };

  try {
    const result = await fn();
    await ref.set({
      userId,
      operationId,
      operationIdPreview: operationId.slice(0, 300),
      status: 'completed',
      result,
      completedAt: Date.now(),
      updatedAt: Date.now(),
      expiresAt: Date.now() + IDEMPOTENCY_TTL_MS,
    }, { merge: true });
    return { kind: 'cache_miss', result };
  } catch (err: any) {
    const failure = { success: false, error: err?.message || 'execution failed' };
    await ref.set({
      userId,
      operationId,
      operationIdPreview: operationId.slice(0, 300),
      status: 'failed',
      result: failure,
      updatedAt: Date.now(),
      expiresAt: Date.now() + IDEMPOTENCY_TTL_MS,
    }, { merge: true });
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
