/**
 * V6 Persistent Idempotency (CF-6).
 *
 * Guarantees: same user + same operationId => exactly one financial mutation.
 * Retries return the cached result instead of executing again.
 *
 * Storage: Firestore collection `idempotency_keys` keyed by a SHA-256 hash of
 * `${userId}:${operationId}`. We must NEVER use operationId directly as a doc id:
 * operationId can contain Arabic text, slashes, pipes, spaces, or other user text.
 * A slash inside a Firestore document id breaks the path and used to disable
 * idempotency, causing duplicate financial writes.
 */
import { createHash } from 'crypto';
import { adminDb } from './firebaseAdmin';

const IDEMPOTENCY_COLLECTION = 'idempotency_keys';
const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000; // 24h

function idemDocId(userId: string, operationId: string): string {
  return createHash('sha256').update(`${userId}:${operationId}`).digest('hex');
}

export interface IdempotencyOutcome {
  kind: 'cache_hit' | 'cache_miss';
  cachedResult?: any;
  result?: any;
}

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitForCompletedResult(ref: any, attempts = 20): Promise<any> {
  for (let i = 0; i < attempts; i++) {
    await sleep(150);
    const snap = await ref.get();
    const data = snap.data() || {};
    if (data.status === 'completed') return data.result;
    if (data.status === 'failed') return data.result || { success: false, error: 'previous attempt failed' };
  }
  return { success: false, inFlight: true, message: 'العملية قيد التنفيذ بالفعل؛ لم أكرر التسجيل حتى لا يتضاعف القيد.' };
}

/**
 * Run `fn` exactly once for (userId, operationId).
 *
 * Important financial safety rule:
 * If Firestore idempotency cannot claim the key, we FAIL CLOSED. We do not execute
 * the financial mutation without dedupe protection, because that is exactly how
 * one 50 ₪ debt purchase became 100 ₪.
 */
export async function runIdempotent(
  userId: string,
  operationId: string | undefined,
  fn: () => Promise<any>,
): Promise<IdempotencyOutcome> {
  if (!operationId || typeof operationId !== 'string' || operationId.length < 4) {
    const result = await fn();
    return { kind: 'cache_miss', result };
  }

  const docId = idemDocId(userId, operationId);
  const ref = adminDb.collection(IDEMPOTENCY_COLLECTION).doc(docId);

  let claim: { kind: 'cache_hit'; cachedResult: any } | { kind: 'cache_miss' };
  try {
    claim = await adminDb.runTransaction(async (tx: any) => {
      const snap = await tx.get(ref);
      const data = snap.exists ? (snap.data() as any) : null;

      if (data) {
        if (data.status === 'completed') {
          return { kind: 'cache_hit' as const, cachedResult: data.result };
        }
        if (data.status === 'pending') {
          return { kind: 'cache_hit' as const, cachedResult: await waitForCompletedResult(ref) };
        }
        if (data.status === 'failed' && Date.now() - (data.updatedAt || 0) < 60_000) {
          return { kind: 'cache_hit' as const, cachedResult: data.result || { success: false, error: 'previous attempt failed' } };
        }
      }

      tx.set(ref, {
        userId,
        operationId,
        operationIdPreview: operationId.slice(0, 300),
        status: 'pending',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        expiresAt: Date.now() + IDEMPOTENCY_TTL_MS,
      });
      return { kind: 'cache_miss' as const };
    });
  } catch (txErr: any) {
    console.error('[idempotency] failed to claim financial operation; refusing unsafe write:', txErr?.message);
    return {
      kind: 'cache_hit',
      cachedResult: {
        success: false,
        retryable: true,
        reason: 'IDEMPOTENCY_LOCK_FAILED',
        message: 'رفضت تسجيل العملية لأن قفل منع التكرار لم يتأكد. أعد المحاولة بعد لحظات حتى لا يتضاعف المبلغ.',
        error: txErr?.message || 'idempotency lock failed',
      }
    };
  }

  if (claim.kind === 'cache_hit') {
    return { kind: 'cache_hit', cachedResult: claim.cachedResult };
  }

  let fnResult: any;
  try {
    fnResult = await fn();
    await ref.set({
      userId,
      operationId,
      operationIdPreview: operationId.slice(0, 300),
      status: 'completed',
      result: fnResult,
      completedAt: Date.now(),
      updatedAt: Date.now(),
      expiresAt: Date.now() + IDEMPOTENCY_TTL_MS,
    }, { merge: true });
    return { kind: 'cache_miss', result: fnResult };
  } catch (err: any) {
    await ref.set({
      userId,
      operationId,
      operationIdPreview: operationId.slice(0, 300),
      status: 'failed',
      result: { success: false, error: err?.message || 'execution failed' },
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
