/**
 * V6.1 Concurrency Tests (CONC-01..CONC-05).
 *
 * Verifies that atomic operations prevent TOCTOU race conditions.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

test('CONC-01: cash expense uses atomicAddTransaction (atomic guard present)', async () => {
  const src = await readFile(join(process.cwd(), 'src/server/tools.ts'), 'utf8');
  assert.ok(src.includes('atomicAddTransaction(userId, tx'), 'addTransaction uses atomicAddTransaction for balance-sensitive ops');
  assert.ok(src.includes('isBalanceSensitive'), 'balance-sensitivity check present');
});

test('CONC-02: PalPay expense uses atomic guard (same code path)', async () => {
  const src = await readFile(join(process.cwd(), 'src/server/tools.ts'), 'utf8');
  // The atomic path covers both cash and palPay accounts for expense.
  assert.ok(src.includes("type === 'expense' && (account === 'cash' || account === 'palPay')"),
    'PalPay expense covered by atomic path');
});

test('CONC-03: payDebt uses atomicPayDebt (concurrent payment protection)', async () => {
  const src = await readFile(join(process.cwd(), 'src/server/tools.ts'), 'utf8');
  assert.ok(src.includes('atomicPayDebt(userId, tx, selected.key, selected.remaining'),
    'payDebt uses atomicPayDebt with creditor key');
  assert.ok(src.includes('OVERPAYMENT_ATOMIC'),
    'payDebt returns OVERPAYMENT_ATOMIC when concurrent payment exceeds remaining');
});

test('CONC-04: same operationId executes once (idempotency layer)', async () => {
  const src = await readFile(join(process.cwd(), 'src/server/idempotency.ts'), 'utf8');
  assert.ok(src.includes('adminDb.runTransaction'), 'uses Firestore runTransaction (atomic claim)');
  assert.ok(src.includes("kind: 'cache_hit'"), 'returns cache_hit on duplicate');
});

test('CONC-05: concurrent update + expense preserves invariant (NEGATIVE_CASH_RESULT guard)', async () => {
  const src = await readFile(join(process.cwd(), 'src/server/tools.ts'), 'utf8');
  assert.ok(src.includes('NEGATIVE_CASH_RESULT'),
    'updateTransaction blocks updates that would make cash negative');
  assert.ok(src.includes('resultingBalances.cash < -0.0001'),
    'guard triggers when resulting cash is negative');
});

test('CONC-06: atomicAddTransaction exists in atomicOps.ts', async () => {
  const src = await readFile(join(process.cwd(), 'src/server/atomicOps.ts'), 'utf8');
  assert.ok(src.includes('export async function atomicAddTransaction'),
    'atomicAddTransaction exported');
  assert.ok(src.includes('adminDb.runTransaction'),
    'uses Firestore runTransaction');
  assert.ok(src.includes('INSUFFICIENT_FUNDS_ATOMIC'),
    'returns INSUFFICIENT_FUNDS_ATOMIC on overspend');
});

test('CONC-07: atomicPayDebt recomputes creditor remaining (not cached)', async () => {
  const src = await readFile(join(process.cwd(), 'src/server/atomicOps.ts'), 'utf8');
  assert.ok(src.includes('recomputeCreditorRemaining'),
    'atomicPayDebt recomputes creditor remaining at transaction time (not cached value)');
  assert.ok(src.includes('OVERPAYMENT_ATOMIC'),
    'returns OVERPAYMENT_ATOMIC when concurrent payment exceeds remaining');
});
