import { parsePositiveFinancialAmount } from './amount';
import { roundMoney } from './savingsCore';

export type VaultCurrencyCode = 'ILS' | 'USD' | 'EUR' | string;

export type VaultAdjustmentEntryInput = {
  amount?: unknown;
  currency?: unknown;
  source?: unknown;
  notes?: unknown;
};

export type VaultAdjustmentEntry = {
  amount: number;
  currency: VaultCurrencyCode;
  source: string;
  notes: string;
};

export function normalizeVaultCurrency(currency: unknown): VaultCurrencyCode {
  const raw = String(currency || 'ILS').trim();
  const upper = raw.toUpperCase();
  if (upper === 'ILS' || upper === 'NIS' || raw === '₪' || raw === 'شيكل' || raw === 'شيكل إسرائيلي') return 'ILS';
  if (upper === 'USD' || raw === '$' || raw === 'دولار' || raw === 'دولار أمريكي') return 'USD';
  if (upper === 'EUR' || raw === '€' || raw === 'يورو') return 'EUR';
  return upper || 'ILS';
}

export function addVaultCurrencyAmount(
  map: Record<string, number> = {},
  currency: VaultCurrencyCode,
  amount: number,
): Record<string, number> {
  return {
    ...map,
    [currency]: roundMoney(Number(map[currency] || 0) + Number(amount || 0)),
  };
}

export function normalizeVaultAdjustmentEntries(args: any): VaultAdjustmentEntry[] {
  const rawEntries: VaultAdjustmentEntryInput[] = Array.isArray(args?.amounts)
    ? args.amounts
    : Array.isArray(args?.entries)
      ? args.entries
      : [{ amount: args?.amount, currency: args?.currency, source: args?.source || args?.reason, notes: args?.notes }];

  return rawEntries
    .map((entry: VaultAdjustmentEntryInput) => ({
      amount: roundMoney(parsePositiveFinancialAmount(entry?.amount)),
      currency: normalizeVaultCurrency(entry?.currency),
      source: String(entry?.source || args?.source || args?.reason || 'manual_carryover').trim(),
      notes: String(entry?.notes || args?.notes || '').trim(),
    }))
    .filter((entry: VaultAdjustmentEntry) => entry.amount > 0);
}

export function mergeVaultCurrencyDeltas(
  base: Record<string, number> = {},
  delta: Record<string, number> = {},
): Record<string, number> {
  return Object.entries(delta).reduce(
    (map: Record<string, number>, [currency, amount]) => addVaultCurrencyAmount(map, normalizeVaultCurrency(currency), Number(amount || 0)),
    base,
  );
}

export function deriveVaultAdjustmentCurrencyDelta(adjustment: any): Record<string, number> {
  if (adjustment?.currencyDelta && typeof adjustment.currencyDelta === 'object') {
    return mergeVaultCurrencyDeltas({}, adjustment.currencyDelta);
  }

  const entries = Array.isArray(adjustment?.entries) ? adjustment.entries : [];
  if (entries.length) {
    return entries.reduce((map: Record<string, number>, entry: any) => {
      return addVaultCurrencyAmount(map, normalizeVaultCurrency(entry?.currency), parsePositiveFinancialAmount(entry?.amount));
    }, {});
  }

  const amount = parsePositiveFinancialAmount(adjustment?.originalAmount ?? adjustment?.amount);
  if (amount <= 0) return {};
  return addVaultCurrencyAmount({}, normalizeVaultCurrency(adjustment?.originalCurrency || adjustment?.currency || 'ILS'), amount);
}
