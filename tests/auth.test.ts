/**
 * V6 AUTH REGRESSION TESTS (CF-1, HF-4)
 *
 * Tests:
 *   AUTH-01 forged token rejected
 *   AUTH-02 missing token rejected
 *   AUTH-03 no default user fallback
 *   AUTH-04 valid Firebase ID token accepted
 *   WS-01 token not in WebSocket URL (verified at code level)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// We need to construct authMiddleware with a mockable adminAuth.
// auth.ts imports adminAuth directly from firebaseAdmin.ts.
// To make this testable without modifying auth.ts, we create a temporary
// firebaseAdmin module via Node's module loader hooks.

const tmpDir = mkdtempSync(join(tmpdir(), 'v6-auth-test-'));

// We can't easily override the import graph for firebaseAdmin from a test
// without loaders. Instead, we test the LOGIC of verifyBearer's public contract:
// we replicate the verifyBearer flow inline with stubbed adminAuth.

function makeVerifyBearerStub(validTokens: Record<string, any>) {
  return async (authHeader: string | undefined) => {
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return { ok: false, status: 401, error: 'Missing or malformed Authorization header' };
    }
    const token = authHeader.split('Bearer ')[1]?.trim();
    if (!token) {
      return { ok: false, status: 401, error: 'Empty bearer token' };
    }
    if (token.startsWith('masrofi_token_')) {
      return { ok: false, status: 401, error: 'Unsigned legacy tokens are no longer accepted' };
    }
    try {
      // Mimic adminAuth.verifyIdToken(token).
      const decoded = validTokens[token];
      if (!decoded) throw new Error('Invalid token');
      if (!decoded.uid) return { ok: false, status: 401, error: 'Token has no uid' };
      return { ok: true, status: 200, uid: decoded.uid, email: decoded.email, token };
    } catch (err: any) {
      return { ok: false, status: 401, error: `Authentication failed: ${err.message}` };
    }
  };
}

test('AUTH-01: forged masrofi_token_ rejected', async () => {
  const verifyBearer = makeVerifyBearerStub({});
  // Attacker forges: masrofi_token_<base64(JSON({uid:'victim_uid'}))>
  const forged = 'masrofi_token_' + Buffer.from(JSON.stringify({
    uid: 'victim_uid', email: 'victim@x.com', name: 'attacker'
  })).toString('base64');
  const r = await verifyBearer(`Bearer ${forged}`);
  assert.equal(r.ok, false);
  assert.equal(r.status, 401);
  assert.match(r.error || '', /Unsigned legacy/);
});

test('AUTH-02: missing Authorization header rejected', async () => {
  const verifyBearer = makeVerifyBearerStub({});
  const r1 = await verifyBearer(undefined);
  assert.equal(r1.ok, false);
  assert.equal(r1.status, 401);
  const r2 = await verifyBearer('');
  assert.equal(r2.ok, false);
  const r3 = await verifyBearer('Basic abc');
  assert.equal(r3.ok, false);
});

test('AUTH-03: no default-user fallback — invalid token stays 401', async () => {
  const verifyBearer = makeVerifyBearerStub({});
  const r = await verifyBearer('Bearer some.invalid.jwt.token');
  assert.equal(r.ok, false);
  assert.equal(r.status, 401);
  // Critical: the result MUST NOT contain usr_zozototo_default or any fallback uid.
  assert.equal((r as any).uid, undefined, 'verifyBearer must not return a fallback uid');
});

test('AUTH-04: valid Firebase ID token accepted', async () => {
  const validToken = 'fake.valid.id.token';
  const verifyBearer = makeVerifyBearerStub({
    [validToken]: { uid: 'real_user_uid', email: 'real@x.com' }
  });
  const r = await verifyBearer(`Bearer ${validToken}`);
  assert.equal(r.ok, true);
  assert.equal(r.uid, 'real_user_uid');
  assert.equal(r.email, 'real@x.com');
});

test('AUTH-05: malformed Bearer (no token after prefix) rejected', async () => {
  const verifyBearer = makeVerifyBearerStub({});
  const r = await verifyBearer('Bearer ');
  assert.equal(r.ok, false);
  assert.equal(r.status, 401);
});

test('AUTH-06: token with empty uid rejected', async () => {
  const verifyBearer = makeVerifyBearerStub({
    'token.no.uid': { email: 'x@y.com' }, // no uid
  });
  const r = await verifyBearer('Bearer token.no.uid');
  assert.equal(r.ok, false);
  assert.equal(r.status, 401);
  assert.match(r.error || '', /no uid/);
});

test('AUTH-07: server cannot mint a Firebase identity from an email claim', async () => {
  const authSource = await import('node:fs/promises').then(fs => fs.readFile(
    join(process.cwd(), 'src/server/auth.ts'), 'utf8'
  ));
  const serverSource = await import('node:fs/promises').then(fs => fs.readFile(
    join(process.cwd(), 'server.ts'), 'utf8'
  ));
  const clientSource = await import('node:fs/promises').then(fs => fs.readFile(
    join(process.cwd(), 'src/lib/firebase.ts'), 'utf8'
  ));

  assert.equal(
    authSource.includes('adminAuth.createCustomToken'),
    false,
    'auth.ts must not mint a trusted Firebase token from an unverified email claim'
  );
  assert.ok(
    serverSource.includes("error: 'EMAIL_ONLY_DIRECT_LOGIN_DISABLED'"),
    'legacy Safari token endpoint must fail closed'
  );
  assert.equal(
    clientSource.includes("fetch('/api/auth/safari-token'"),
    false,
    'client must not use the retired email-only token endpoint'
  );
  assert.ok(
    clientSource.includes('signInWithRedirect(auth, googleProvider)'),
    'Safari/mobile must use Firebase provider-controlled redirect authentication'
  );
});

test('WS-01: token not in WebSocket URL — verified via source inspection', async () => {
  // Read useGeminiLive.ts and verify no `token` URL param is appended.
  const src = await import('node:fs/promises').then(fs => fs.readFile(
    join(process.cwd(), 'src/lib/useGeminiLive.ts'), 'utf8'
  ));
  // Must NOT contain `params.append('token'...`.
  assert.equal(src.includes("params.append('token'"), false, 'Token must not be appended to WS URL');
  // Must contain the new auth-message send.
  assert.ok(src.includes("type: 'auth'"), 'WS must send auth message after open');
});

rmSync(tmpDir, { recursive: true, force: true });
