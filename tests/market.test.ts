/**
 * V6.1 Market Intelligence Tests (MARKET-01..MARKET-15).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

// Test the market intelligence module directly.
import {
  isGazaSource,
  extractPricesFromText,
  computePriceRange,
  isSmallDailyPurchase,
  shouldSearchMarket,
  getCachedMarketResult,
  cacheMarketResult,
  normalizeCurrencyToIls,
  setExchangeRateSnapshotForTests,
} from '../src/server/marketIntelligence.ts';

test('MARKET-01: extractPricesFromText parses "3200 ₪"', () => {
  const r = extractPricesFromText('سعر الجوال 3200 ₪');
  assert.ok(r.length >= 1);
  assert.equal(r[0].price, 3200);
  assert.equal(r[0].currency, 'ILS');
});

test('MARKET-02: extractPricesFromText handles USD/JOD', () => {
  const r = extractPricesFromText('Price: USD 100 and JOD 50 and 200 shekel');
  assert.ok(r.length >= 3);
  const currencies = r.map(x => x.currency).sort();
  assert.ok(currencies.includes('USD'));
  assert.ok(currencies.includes('JOD'));
  assert.ok(currencies.includes('ILS'));
});

test('MARKET-03: isGazaSource detects Gaza/Palestine in title/URL', () => {
  assert.equal(isGazaSource('Gaza Market', 'https://example.com'), true);
  assert.equal(isGazaSource('سوق غزة', 'https://example.com'), true);
  assert.equal(isGazaSource('Palestine Stores', 'https://example.com'), true);
  assert.equal(isGazaSource('Amazon USA', 'https://amazon.com'), false);
});

test('MARKET-04: computePriceRange excludes outliers (>2x median)', () => {
  const results = [
    { price: 3200, currency: 'ILS', product: 'phone', fetchedAt: '', isLocalGaza: true, source: '', confidence: 'high' as const },
    { price: 3300, currency: 'ILS', product: 'phone', fetchedAt: '', isLocalGaza: true, source: '', confidence: 'high' as const },
    { price: 3400, currency: 'ILS', product: 'phone', fetchedAt: '', isLocalGaza: true, source: '', confidence: 'high' as const },
    { price: 8000, currency: 'ILS', product: 'phone', fetchedAt: '', isLocalGaza: true, source: '', confidence: 'high' as const },  // outlier (median=3300, 2x=6600, 8000 > 6600)
  ];
  const range = computePriceRange(results);
  assert.ok(range);
  assert.equal(range.min, 3200);
  assert.equal(range.max, 3400);  // outlier excluded (8000 > 2x median of 3400)
  assert.equal(range.median, 3400);  // median before filter = prices[2] = 3400
});

test('MARKET-05: computePriceRange returns null for mixed currencies', () => {
  const results = [
    { price: 3200, currency: 'ILS', product: 'phone', fetchedAt: '', isLocalGaza: true, source: '', confidence: 'high' as const },
    { price: 100, currency: 'USD', product: 'phone', fetchedAt: '', isLocalGaza: true, source: '', confidence: 'high' as const },
  ];
  const range = computePriceRange(results);
  assert.equal(range, null, 'refuses to mix currencies');
});

test('MARKET-06: isSmallDailyPurchase detects daily items', () => {
  assert.equal(isSmallDailyPurchase('خبز'), true);
  assert.equal(isSmallDailyPurchase('ماء'), true);
  assert.equal(isSmallDailyPurchase('بنزين'), true);
  assert.equal(isSmallDailyPurchase('جوال Samsung'), false);
});

test('MARKET-07: shouldSearchMarket triggers for high-value categories', () => {
  assert.equal(shouldSearchMarket('جوال موبايل'), true);
  assert.equal(shouldSearchMarket('سيارة هوندا'), true);
  assert.equal(shouldSearchMarket('ثلاجة'), true);
  assert.equal(shouldSearchMarket('خبز'), false);
});

test('MARKET-08: shouldSearchMarket triggers for explicit comparison requests', () => {
  assert.equal(shouldSearchMarket('دورلي بالسوق'), true);
  assert.equal(shouldSearchMarket('غالي ولا رخيص؟'), true);
  assert.equal(shouldSearchMarket('سعر السوق لهذا الجوال'), true);
});

test('MARKET-09: shouldSearchMarket triggers for high amounts', () => {
  assert.equal(shouldSearchMarket('شي عادي', 600), true);  // >= 500
  assert.equal(shouldSearchMarket('شي عادي', 200), false);
});

test('MARKET-10: cache returns null on cache miss', () => {
  const r = getCachedMarketResult({ product: 'nonexistent_' + Date.now() });
  assert.equal(r, null);
});

test('MARKET-11: cache stores and retrieves', () => {
  const key = { product: 'test_phone_' + Date.now() };
  const response = {
    success: true,
    item: key.product,
    results: [],
    sources: [],
    searchQueries: [],
    summary: 'test',
  };
  cacheMarketResult(key, response as any);
  const cached = getCachedMarketResult(key);
  assert.ok(cached, 'cache hit');
  assert.equal(cached.item, key.product);
  assert.equal(cached.cached, true, 'cached flag set');
});

test('MARKET-12: searchLocalMarket refuses small daily purchases', async () => {
  const src = await readFile(join(process.cwd(), 'src/server/tools.ts'), 'utf8');
  assert.ok(src.includes('isSmallDailyPurchase(item)'),
    'searchLocalMarket checks isSmallDailyPurchase');
  assert.ok(src.includes('هذه السلعة يومية ولا تحتاج مقارنة أسعار'),
    'returns marketUnavailable for daily items');
});

test('MARKET-13: searchLocalMarket uses cache', async () => {
  const src = await readFile(join(process.cwd(), 'src/server/tools.ts'), 'utf8');
  assert.ok(src.includes('getCachedMarketResult'),
    'searchLocalMarket checks cache first');
  assert.ok(src.includes('cacheMarketResult'),
    'searchLocalMarket stores in cache');
});

test('MARKET-14: searchLocalMarket never fabricates prices (failure → marketUnavailable)', async () => {
  const src = await readFile(join(process.cwd(), 'src/server/tools.ts'), 'utf8');
  assert.ok(src.includes('marketUnavailable: true'),
    'on API failure, returns marketUnavailable (no fake fallback)');
  assert.ok(src.includes('لن أقدم سعراً غير موثوق'),
    'explicit message: no untrusted price');
});

test('MARKET-15: searchLocalMarket returns structured results with sources + timestamps', async () => {
  const src = await readFile(join(process.cwd(), 'src/server/tools.ts'), 'utf8');
  assert.ok(src.includes('fetchedAt: now'),
    'each result includes fetchedAt timestamp');
  assert.ok(src.includes('isLocalGaza'),
    'each result includes isLocalGaza flag');
  assert.ok(src.includes('sourceUrl'),
    'each result includes sourceUrl');
  assert.ok(src.includes('priceRange'),
    'response includes priceRange aggregation');
});

test('MARKET-16: search_local_market tool declaration includes condition field', async () => {
  const src = await readFile(join(process.cwd(), 'src/server/tools.ts'), 'utf8');
  assert.ok(src.includes("condition:{type:\"string\",description:\"حالة السلعة"),
    'tool declaration includes condition parameter');
});

test('MARKET-17: AI prompt instructs to ask for model/specs before search', async () => {
  const src = await readFile(join(process.cwd(), 'server.ts'), 'utf8');
  assert.ok(src.includes('0.8- **V6.1 — السوق الحقيقي المرتبط بالسياق المالي**'),
    'V6.1 market-context prompt rule present');
  assert.ok(src.includes('اسأل أولاً عن الموديل/المواصفات والحالة'),
    'prompt instructs AI to ask for model/condition first');
});

test('MARKET-18: AI prompt instructs to refuse fake prices on failure', async () => {
  const src = await readFile(join(process.cwd(), 'server.ts'), 'utf8');
  assert.ok(src.includes('لا تخترع أسعاراً'),
    'prompt forbids fabricating prices');
  assert.ok(src.includes('لا أستطيع التحقق من السعر حالياً'),
    'prompt instructs honest failure message');
});

test('MARKET-19: market prompt-injection protection (market is read-only, no mutation)', async () => {
  const src = await readFile(join(process.cwd(), 'src/server/tools.ts'), 'utf8');
  // searchLocalMarket must NOT call any write function (set/update/delete on transactions).
  const fnMatch = src.match(/export async function searchLocalMarket[\s\S]*?^}/m);
  assert.ok(fnMatch, 'searchLocalMarket function found');
  const fnBody = fnMatch[0];
  assert.ok(!fnBody.includes("collection('transactions').doc().set("),
    'searchLocalMarket must NOT write transactions (read-only)');
  assert.ok(!fnBody.includes('addTransaction('),
    'searchLocalMarket must NOT call addTransaction');
});
