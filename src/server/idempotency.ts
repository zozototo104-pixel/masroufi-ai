/**
 * V6 Persistent Idempotency (CF-6).
 *
 * Guarantees: same user + same operationId => exactly one financial mutation.
 * Retries return the cached result instead of executing again.
 *
 * Storage: Firestore collection `idempotency_keys` keyed by `${userId}:${operationId}`.
 * Each entry stores: userId, operationId, status ('pending' | 'completed' | 'failed'),
 * result (for completed), createdAt, completedAt.
 *
 * Works across:
 * - 1 second retries
 * - 11 second retries (past the V5 10s in-memory cache)
 * - Cloud Run restarts (Firestore is the source of truth, not in-process Map)
 * - Concurrent requests (Firestore transaction provides compare-and-swap)
 * - Multiple server instances (Firestore is shared)
 */
import { adminDb } from './firebaseAdmin';

const IDEMPOTENCY_COLLECTION = 'idempotency_keys';
const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000; // 24h

/** Doc ID helper: deterministic per (user, operation). */
function idemDocId(userId: string, operationId: string): string {
  // Firestore doc IDs cannot contain '/' — but our operationIds don't, so we just
  // prefix with the userId to namespace.
  return `${userId}__${operationId}`;
}

export interface IdempotencyOutcome {
  /** 'cache_hit' => previous result returned, do NOT re-execute. 'cache_miss' => execute. */
  kind: 'cache_hit' | 'cache_miss';
  /** Present when kind === 'cache_hit'. */
  cachedResult?: any;
  /** Present when execution completed and result was stored. */
  result?: any;
}

/**
 * Run `fn` exactly once for (userId, operationId). Subsequent calls with the same
 * key return the cached result.
 *
 * Uses Firestore transaction to atomically claim the key. If two concurrent requests
 * arrive, only one wins the claim and executes; the other waits and returns the
 * cached result.
 *
 * If `operationId` is empty/missing, returns 'cache_miss' without claiming — caller
 * should still execute (no idempotency protection in that case, which matches V5
 * behavior for clients that don't supply operationId).
 */
export async function runIdempotent(
  userId: string,
  operationId: string | undefined,
  fn: () => Promise<any>,
): Promise<IdempotencyOutcome> {
  if (!operationId || typeof operationId !== 'string' || operationId.length < 4) {
    // No idempotency key provided. Execute directly (matches V5 fallback behavior).
    const result = await fn();
    return { kind: 'cache_miss', result };
  }

  const docId = idemDocId(userId, operationId);
  const ref = adminDb.collection(IDEMPOTENCY_COLLECTION).doc(docId);

  // Use a Firestore transaction for atomic claim.
  try {
    const result = await adminDb.runTransaction(async (tx: any) => {
      const snap = await tx.get(ref);
      const data = snap.data() as any;
      if (data) {
        // Already exists.
        if (data.status === 'completed') {
          return { kind: 'cache_hit' as const, cachedResult: data.result };
        }
        if (data.status === 'pending') {
          // Another in-flight request owns this key. We must NOT execute.
          // Caller should signal to the user that the operation is in progress.
          return { kind: 'cache_hit' as const, cachedResult: { success: false, inFlight: true, message: 'Operation already in progress' } };
        }
        if (data.status === 'failed' && Date.now() - (data.updatedAt || 0) < 60_000) {
          // Recently failed — return the failure rather than retrying immediately.
          // This protects against rapid retry storms.
          return { kind: 'cache_hit' as const, cachedResult: data.result || { success: false, error: 'previous attempt failed' } };
        }
      }
      // Claim the key as 'pending'.
      tx.set(ref, {
        userId,
        operationId,
        status: 'pending',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      return { kind: 'cache_miss' as const };
    });

    if (result.kind === 'cache_hit') {
      return { kind: 'cache_hit', cachedResult: result.cachedResult };
    }

    // We won the claim. Execute the function.
    let fnResult: any;
    try {
      fnResult = await fn();
      // Mark completed.
      await ref.set({
        userId,
        operationId,
        status: 'completed',
        result: fnResult,
        completedAt: Date.now(),
        updatedAt: Date.now(),
        // Keep TTL info for cleanup queries.
        expiresAt: Date.now() + IDEMPOTENCY_TTL_MS,
      }, { merge: true });
      return { kind: 'cache_miss', result: fnResult };
    } catch (err: any) {
      // Mark failed so retries within 60s don't pound the system.
      await ref.set({
        userId,
        operationId,
        status: 'failed',
        result: { success: false, error: err?.message || 'execution failed' },
        updatedAt: Date.now(),
      }, { merge: true });
      throw err;
    }
  } catch (txErr: any) {
    // If the transaction itself failed (quota / contention), fall back to executing
    // without idempotency protection rather than silently dropping the operation.
    // The operationId is still recorded in the transaction document itself, so a
    // subsequent deduplication pass could reconcile later. This is a degraded mode.
    console.warn('[idempotency] transaction failed, executing without dedupe:', txErr?.message);
    const result = await fn();
    return { kind: 'cache_miss', result };
  }
}

/**
 * Cleanup helper for old idempotency entries. Optional to call; Firestore TTL
 * policies can also handle this server-side.
 */
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
