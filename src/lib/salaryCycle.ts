import { parsePositiveFinancialAmount } from './amount';
import { normalizeAccount } from './balanceCalc';

export const SALARY_CYCLE_START_DAY = 27;

export type SalaryCycleStatus = 'open' | 'closed';

export interface SalaryCyclePeriod {
  cycleId: string;
  name: string;
  year: number;
  month: number;
  cycleStart: string;
  cycleEnd: string;
  cycleEndExclusive: string;
  startIso: string;
  endExclusiveIso: string;
  status: SalaryCycleStatus;
}

export interface SalaryCycleSummary {
  /** True earned income used for Savings Vault surplus eligibility. */
  totalIncome: number;
  /** All money that entered cash/PalPay in the cycle, including cash debt borrowing. */
  totalInflow: number;
  /** Cash/PalPay debt borrowing: counts as incoming money, not expense, but not vault-eligible income. */
  debtCashInflow: number;
  totalExpense: number;
  /** Vault-eligible surplus = true earned income - true expenses - debt repayments paid from liquidity. Borrowed cash is intentionally excluded. Debt repayment is not a new expense, but it reduces cash available for vault. */
  surplus: number;
  transactionCount: number;
  incomeCount: number;
  expenseCount: number;
  transferCount: number;
  debtBorrowingCount: number;
  debtCreated: number;
  debtPaid: number;
  netDebtChange: number;
}

const ARABIC_MONTHS: Record<string, number> = {
  'يناير': 1,
  'كانون الثاني': 1,
  'فبراير': 2,
  'شباط': 2,
  'مارس': 3,
  'اذار': 3,
  'آذار': 3,
  'ابريل': 4,
  'أبريل': 4,
  'نيسان': 4,
  'مايو': 5,
  'ايار': 5,
  'أيار': 5,
  'يونيو': 6,
  'حزيران': 6,
  'يوليو': 7,
  'تموز': 7,
  'اغسطس': 8,
  'أغسطس': 8,
  'اب': 8,
  'آب': 8,
  'سبتمبر': 9,
  'ايلول': 9,
  'أيلول': 9,
  'اكتوبر': 10,
  'أكتوبر': 10,
  'تشرين الاول': 10,
  'تشرين الأول': 10,
  'نوفمبر': 11,
  'تشرين الثاني': 11,
  'ديسمبر': 12,
  'كانون الاول': 12,
  'كانون الأول': 12,
};

export function roundMoney(value: number): number {
  return Math.round((Number.isFinite(value) ? value : 0) * 100) / 100;
}

export function normalizeDigits(value: unknown): string {
  return String(value || '')
    .replace(/[٠-٩]/g, digit => String('٠١٢٣٤٥٦٧٨٩'.indexOf(digit)))
    .replace(/[۰-۹]/g, digit => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(digit)))
    .trim();
}

function ymd(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function isoStart(date: Date): string {
  return `${ymd(date)}T00:00:00.000Z`;
}

function normalizeMonthYear(year: number, month: number): { year: number; month: number } {
  const d = new Date(Date.UTC(year, month - 1, 1));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1 };
}

function isValidDate(date: Date): boolean {
  return !Number.isNaN(date.getTime());
}

export function parseDateLike(value: unknown): Date | null {
  const raw = normalizeDigits(value);
  if (!raw) return null;
  const iso = raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T\s].*)?$/);
  if (iso) {
    const d = new Date(Date.UTC(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3])));
    return isValidDate(d) ? d : null;
  }
  const local = raw.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})$/);
  if (local) {
    const d = new Date(Date.UTC(Number(local[3]), Number(local[2]) - 1, Number(local[1])));
    return isValidDate(d) ? d : null;
  }
  const parsed = new Date(raw);
  return isValidDate(parsed) ? new Date(Date.UTC(parsed.getUTCFullYear(), parsed.getUTCMonth(), parsed.getUTCDate())) : null;
}

export function salaryCycleId(year: number, month: number): string {
  const normalized = normalizeMonthYear(year, month);
  return `vault_${normalized.year}_${String(normalized.month).padStart(2, '0')}`;
}

export function buildSalaryCycleForMonth(year: number, month: number, now: Date = new Date()): SalaryCyclePeriod {
  const normalized = normalizeMonthYear(year, month);
  const start = new Date(Date.UTC(normalized.year, normalized.month - 2, SALARY_CYCLE_START_DAY));
  const end = new Date(Date.UTC(normalized.year, normalized.month - 1, SALARY_CYCLE_START_DAY - 1));
  const endExclusive = new Date(Date.UTC(normalized.year, normalized.month - 1, SALARY_CYCLE_START_DAY));
  const closed = now.getTime() >= endExclusive.getTime();
  const label = `${normalized.year}-${String(normalized.month).padStart(2, '0')}`;
  return {
    cycleId: salaryCycleId(normalized.year, normalized.month),
    name: `دورة راتب ${label}`,
    year: normalized.year,
    month: normalized.month,
    cycleStart: ymd(start),
    cycleEnd: ymd(end),
    cycleEndExclusive: ymd(endExclusive),
    startIso: isoStart(start),
    endExclusiveIso: isoStart(endExclusive),
    status: closed ? 'closed' : 'open',
  };
}

export function getSalaryCycleForDate(value: unknown, now: Date = new Date()): SalaryCyclePeriod {
  const date = parseDateLike(value) || now;
  const day = date.getUTCDate();
  const labelDate = day >= SALARY_CYCLE_START_DAY
    ? new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1))
    : new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
  return buildSalaryCycleForMonth(labelDate.getUTCFullYear(), labelDate.getUTCMonth() + 1, now);
}

export function getCurrentSalaryCycle(now: Date = new Date()): SalaryCyclePeriod {
  return getSalaryCycleForDate(now, now);
}

export function getPreviousSalaryCycle(period: SalaryCyclePeriod, now: Date = new Date()): SalaryCyclePeriod {
  return buildSalaryCycleForMonth(period.year, period.month - 1, now);
}

export function parseSalaryCycleMonth(value: unknown): number | null {
  const raw = normalizeDigits(value).replace(/[أإآ]/g, 'ا').replace(/\s+/g, ' ').trim();
  if (!raw) return null;
  const numeric = raw.match(/(?:^|\D)(1[0-2]|0?[1-9])(?:\D|$)/);
  if (numeric) return Number(numeric[1]);
  if (ARABIC_MONTHS[raw]) return ARABIC_MONTHS[raw];
  const monthNames = Object.keys(ARABIC_MONTHS).sort((a, b) => b.length - a.length);
  const matchedName = monthNames.find(name => raw.includes(name.replace(/[أإآ]/g, 'ا')));
  return matchedName ? ARABIC_MONTHS[matchedName] : null;
}

export function resolveSalaryCycleFromArgs(args: any = {}, now: Date = new Date()): SalaryCyclePeriod {
  const cycleId = String(args.cycleId || args.id || '').trim();
  const idMatch = cycleId.match(/(?:vault_|salaryCycle_)?(\d{4})[_-](\d{1,2})$/);
  if (idMatch) return buildSalaryCycleForMonth(Number(idMatch[1]), Number(idMatch[2]), now);

  if (args.date || args.transactionDate) {
    return getSalaryCycleForDate(args.date || args.transactionDate, now);
  }

  const rawMonth = args.salaryMonth ?? args.month ?? args.monthNumber;
  const month = parseSalaryCycleMonth(rawMonth);
  if (month) {
    const explicitYear = Number(normalizeDigits(args.year || args.salaryYear || ''));
    const year = Number.isInteger(explicitYear) && explicitYear >= 2000 && explicitYear <= 2100
      ? explicitYear
      : now.getUTCFullYear();
    return buildSalaryCycleForMonth(year, month, now);
  }

  if (String(args.period || '').trim() === 'previous') {
    return getPreviousSalaryCycle(getCurrentSalaryCycle(now), now);
  }

  return getCurrentSalaryCycle(now);
}

export function isDebtCashBorrowing(tx: any): boolean {
  const type = String(tx?.type || '');
  const transactionType = String(tx?.transactionType || '');
  const from = normalizeAccount(tx?.fromAccount || tx?.account);
  const to = normalizeAccount(tx?.toAccount);
  return type === 'transfer'
    && transactionType === 'DEBT_BORROWING'
    && from === 'debt'
    && (to === 'cash' || to === 'palPay');
}

export function isDebtPayment(tx: any): boolean {
  const type = String(tx?.type || '');
  const transactionType = String(tx?.transactionType || '');
  const to = normalizeAccount(tx?.toAccount);
  return type === 'transfer' && (transactionType === 'DEBT_PAYMENT' || to === 'debt');
}

export function isCreditPurchase(tx: any): boolean {
  const type = String(tx?.type || '');
  const transactionType = String(tx?.transactionType || '');
  return type === 'expense' && (transactionType === 'CREDIT_PURCHASE' || normalizeAccount(tx?.account) === 'debt');
}

export function isInternalTransfer(tx: any): boolean {
  const type = String(tx?.type || '');
  const category = String(tx?.category || '');
  return type === 'transfer' || category === 'تحويل' || category === 'تحويل داخلي';
}

export function isRealSalaryCycleIncome(tx: any): boolean {
  if (isInternalTransfer(tx)) return false;
  if (String(tx?.type || '') !== 'income') return false;
  if (String(tx?.transactionType || '') === 'DEBT_BORROWING') return false;
  if (normalizeAccount(tx?.account) === 'debt') return false;
  return true;
}

export function isRealSalaryCycleExpense(tx: any): boolean {
  if (isInternalTransfer(tx)) return false;
  return String(tx?.type || '') === 'expense';
}

export function summarizeSalaryCycleTransactions(transactions: any[]): SalaryCycleSummary {
  let totalIncome = 0;
  let debtCashInflow = 0;
  let totalExpense = 0;
  let incomeCount = 0;
  let expenseCount = 0;
  let transferCount = 0;
  let debtBorrowingCount = 0;
  let debtCreated = 0;
  let debtPaid = 0;
  for (const tx of transactions || []) {
    if (isDebtCashBorrowing(tx)) {
      debtCashInflow += parsePositiveFinancialAmount(tx?.amount);
      debtBorrowingCount += 1;
      debtCreated += parsePositiveFinancialAmount(tx?.amount);
      transferCount += 1;
      continue;
    }
    if (isDebtPayment(tx)) {
      debtPaid += parsePositiveFinancialAmount(tx?.amount);
      transferCount += 1;
      continue;
    }
    if (isCreditPurchase(tx)) {
      debtCreated += parsePositiveFinancialAmount(tx?.amount);
    }
    if (isInternalTransfer(tx)) {
      transferCount += 1;
      continue;
    }
    if (isRealSalaryCycleIncome(tx)) {
      totalIncome += parsePositiveFinancialAmount(tx?.amount);
      incomeCount += 1;
    } else if (isRealSalaryCycleExpense(tx)) {
      totalExpense += parsePositiveFinancialAmount(tx?.amount);
      expenseCount += 1;
    }
  }
  totalIncome = roundMoney(totalIncome);
  debtCashInflow = roundMoney(debtCashInflow);
  totalExpense = roundMoney(totalExpense);
  debtCreated = roundMoney(debtCreated);
  debtPaid = roundMoney(debtPaid);
  return {
    totalIncome,
    totalInflow: roundMoney(totalIncome + debtCashInflow),
    debtCashInflow,
    totalExpense,
    surplus: roundMoney(totalIncome - totalExpense),
    transactionCount: (transactions || []).length,
    incomeCount,
    expenseCount,
    transferCount,
    debtBorrowingCount,
    debtCreated,
    debtPaid,
    netDebtChange: roundMoney(debtCreated - debtPaid),
  };
}
