export type HistoricalDateResult =
  | { ok: true; date: string; source: 'explicit-date' | 'short-explicit-date' | 'salary-cycle-month-date' | 'historical-month' | 'current-time' }
  | { ok: false; reason: 'INVALID_TRANSACTION_DATE' | 'MISSING_HISTORICAL_DAY'; message: string };

function isValidDateParts(year: number, month: number, day: number): boolean {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return false;
  if (year < 2000 || year > 2100 || month < 1 || month > 12 || day < 1 || day > 31) return false;
  const d = new Date(Date.UTC(year, month - 1, day));
  return d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day;
}

function normalizeDigitsLocal(value: unknown): string {
  return String(value || '')
    .replace(/[٠-٩]/g, digit => String('٠١٢٣٤٥٦٧٨٩'.indexOf(digit)))
    .replace(/[۰-۹]/g, digit => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(digit)))
    .trim();
}

function inferShortDateYear(month: number, day: number, now: Date, explicitYear?: unknown): number {
  const year = Number(normalizeDigitsLocal(explicitYear));
  if (Number.isInteger(year) && year >= 2000 && year <= 2100) return year;
  return now.getUTCFullYear();
}

function parseDateString(value: unknown, opts: { now: Date; year?: unknown } = { now: new Date() }): { year: number; month: number; day: number; short: boolean } | null {
  const raw = normalizeDigitsLocal(value);
  if (!raw) return null;

  const iso = raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T\s].*)?$/);
  if (iso) {
    const [, y, m, d] = iso;
    const year = Number(y), month = Number(m), day = Number(d);
    return isValidDateParts(year, month, day) ? { year, month, day, short: false } : null;
  }

  const slash = raw.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})$/);
  if (slash) {
    const [, d, m, y] = slash;
    const year = Number(y), month = Number(m), day = Number(d);
    return isValidDateParts(year, month, day) ? { year, month, day } : null;
  }

  return null;
}

function parseMonthString(value: unknown): { year: number; month: number } | null {
  const raw = String(value || '').trim();
  if (!raw) return null;

  const isoMonth = raw.match(/^(\d{4})-(\d{1,2})$/);
  if (isoMonth) {
    const year = Number(isoMonth[1]), month = Number(isoMonth[2]);
    return Number.isInteger(year) && Number.isInteger(month) && year >= 2000 && year <= 2100 && month >= 1 && month <= 12
      ? { year, month }
      : null;
  }

  const localMonth = raw.match(/^(\d{1,2})[\/\-.](\d{4})$/);
  if (localMonth) {
    const month = Number(localMonth[1]), year = Number(localMonth[2]);
    return Number.isInteger(year) && Number.isInteger(month) && year >= 2000 && year <= 2100 && month >= 1 && month <= 12
      ? { year, month }
      : null;
  }

  return null;
}

function toIsoLocalDate(year: number, month: number, day: number, now: Date): string {
  const hh = String(now.getUTCHours()).padStart(2, '0');
  const mm = String(now.getUTCMinutes()).padStart(2, '0');
  const ss = String(now.getUTCSeconds()).padStart(2, '0');
  const ms = String(now.getUTCMilliseconds()).padStart(3, '0');
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}T${hh}:${mm}:${ss}.${ms}Z`;
}

export function normalizeHistoricalTransactionDate(input: {
  date?: unknown;
  historicalMonth?: unknown;
  day?: unknown;
  now?: Date;
}): HistoricalDateResult {
  const now = input.now || new Date();
  if (input.date !== undefined && String(input.date || '').trim()) {
    const parsed = parseDateString(input.date);
    if (!parsed) {
      return { ok: false, reason: 'INVALID_TRANSACTION_DATE', message: 'التاريخ غير صالح. استخدم صيغة مثل 2026-06-15 أو 15/06/2026.' };
    }
    return { ok: true, date: toIsoLocalDate(parsed.year, parsed.month, parsed.day, now), source: 'explicit-date' };
  }

  if (input.historicalMonth !== undefined && String(input.historicalMonth || '').trim()) {
    const parsedMonth = parseMonthString(input.historicalMonth);
    if (!parsedMonth) {
      return { ok: false, reason: 'INVALID_TRANSACTION_DATE', message: 'الشهر التاريخي غير صالح. استخدم صيغة مثل 2026-06 أو 6/2026.' };
    }
    const day = Number(input.day);
    if (!Number.isInteger(day)) {
      return {
        ok: false,
        reason: 'MISSING_HISTORICAL_DAY',
        message: `أي يوم في شهر ${String(parsedMonth.month).padStart(2, '0')}/${parsedMonth.year} أسجل هذه العملية؟ اذكر اليوم أو أعطني تاريخاً كاملاً لكل بند.`,
      };
    }
    if (!isValidDateParts(parsedMonth.year, parsedMonth.month, day)) {
      return { ok: false, reason: 'INVALID_TRANSACTION_DATE', message: 'اليوم غير صالح لهذا الشهر. أعطني تاريخاً صحيحاً للعملية.' };
    }
    return { ok: true, date: toIsoLocalDate(parsedMonth.year, parsedMonth.month, day, now), source: 'historical-month' };
  }

  return { ok: true, date: now.toISOString(), source: 'current-time' };
}
