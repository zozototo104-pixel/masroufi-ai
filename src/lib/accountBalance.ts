import { parseFiniteAmount } from './amount';
import { normalizeAccount, normalizeLedgerAccount, type Balances } from './balanceCalc';

export type AccountBalanceDelta = { cash: number; palPay: number; debt: number; vault: number };

export function roundBalance(value: number): number {
  return Math.round((Number.isFinite(value) ? value : 0) * 100) / 100;
}

export function zeroBalanceDelta(): AccountBalanceDelta {
  return { cash: 0, palPay: 0, debt: 0 };
}

export function txBalanceDelta(tx: any): AccountBalanceDelta {
  const delta = zeroBalanceDelta();
  const amount = parseFiniteAmount(tx?.amount);
  const type = String(tx?.type || '');
  if (!amount || !type) return delta;

  if (type === 'expense') {
    const account = normalizeAccount(tx?.account);
    if (account === 'palPay') delta.palPay -= amount;
    else if (account === 'debt') delta.debt += amount;
    else delta.cash -= amount;
  } else if (type === 'income') {
    const account = normalizeAccount(tx?.account);
    if (account === 'palPay') delta.palPay += amount;
    else if (account === 'debt') delta.debt -= amount;
    else delta.cash += amount;
  } else if (type === 'transfer') {
    const from = normalizeAccount(tx?.fromAccount || tx?.account);
    const to = normalizeAccount(tx?.toAccount);
    if (from === 'palPay') delta.palPay -= amount;
    else if (from === 'debt') delta.debt += amount;
    else delta.cash -= amount;

    if (to === 'palPay') delta.palPay += amount;
    else if (to === 'debt') delta.debt -= amount;
    else delta.cash += amount;
  }

  return {
    cash: roundBalance(delta.cash),
    palPay: roundBalance(delta.palPay),
    debt: roundBalance(delta.debt),
  };
}

export function addBalanceDelta(balance: Balances | AccountBalanceDelta, delta: AccountBalanceDelta): Balances {
  const cash = roundBalance(Number((balance as any).cash || 0) + delta.cash);
  const palPay = roundBalance(Number((balance as any).palPay || 0) + delta.palPay);
  const debt = roundBalance(Number((balance as any).debt || 0) + delta.debt);
  return { cash, palPay, debt, total: roundBalance(cash + palPay) };
}

export function subtractBalanceDelta(a: AccountBalanceDelta, b: AccountBalanceDelta): AccountBalanceDelta {
  return {
    cash: roundBalance(a.cash - b.cash),
    palPay: roundBalance(a.palPay - b.palPay),
    debt: roundBalance(a.debt - b.debt),
  };
}

export function transactionReplacementDelta(beforeTx: any | null, afterTx: any | null): AccountBalanceDelta {
  return subtractBalanceDelta(txBalanceDelta(afterTx || null), txBalanceDelta(beforeTx || null));
}
