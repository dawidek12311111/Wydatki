// Czyste funkcje obliczeniowe — bez dostępu do bazy i interfejsu. Pokryte testami w tests/.
import { addMonths } from './dates.js';

export const isLive = (t) => !t.deletedAt;

/** Wpływ jednej transakcji na saldo wskazanego konta (w groszach). */
export function effectOnAccount(t, accountId) {
  if (!isLive(t)) return 0;
  switch (t.type) {
    case 'income':
      return t.accountId === accountId ? t.amount : 0;
    case 'expense':
      if (t.accountId !== accountId) return 0;
      return t.refund ? t.amount : -t.amount; // zwrot wraca na konto
    case 'transfer': {
      let v = 0;
      if (t.accountId === accountId) v -= t.amount;
      if (t.toAccountId === accountId) v += (t.toAmount ?? t.amount);
      return v;
    }
    default:
      return 0;
  }
}

export function accountBalance(account, transactions) {
  let sum = account.openingBalance || 0;
  for (const t of transactions) sum += effectOnAccount(t, account.id);
  return sum;
}

/** Mapa id konta -> saldo */
export function balances(accounts, transactions) {
  const map = Object.fromEntries(accounts.map((a) => [a.id, a.openingBalance || 0]));
  for (const t of transactions) {
    if (!isLive(t)) continue;
    for (const id of new Set([t.accountId, t.toAccountId])) {
      if (id && id in map) map[id] += effectOnAccount(t, id);
    }
  }
  return map;
}

/**
 * Majątek netto w danej walucie: aktywa (salda dodatnie), zobowiązania (salda ujemne), netto.
 * Transfer między własnymi kontami nie zmienia netto.
 */
export function netWorth(accounts, transactions, currency = 'PLN') {
  const bal = balances(accounts, transactions);
  let assets = 0;
  let liabilities = 0;
  for (const a of accounts) {
    if (a.archived && bal[a.id] === 0) continue;
    if ((a.currency || 'PLN') !== currency) continue;
    const b = bal[a.id];
    if (b >= 0) assets += b; else liabilities += -b;
  }
  return { assets, liabilities, net: assets - liabilities };
}

/**
 * Podsumowanie miesiąca. Transfery (w tym wpłaty na oszczędności i inwestycje) są pomijane.
 * Zwroty zmniejszają wydatki w swojej kategorii.
 */
export function monthSummary(transactions, ym, { currency = 'PLN' } = {}) {
  let income = 0;
  let expense = 0;
  let transfersOut = 0;
  const expenseByCategory = {};
  const incomeByCategory = {};
  for (const t of transactions) {
    if (!isLive(t) || !t.date.startsWith(ym) || (t.currency || 'PLN') !== currency) continue;
    const cat = t.categoryId || 'none';
    if (t.type === 'income') {
      income += t.amount;
      incomeByCategory[cat] = (incomeByCategory[cat] || 0) + t.amount;
    } else if (t.type === 'expense') {
      const v = t.refund ? -t.amount : t.amount;
      expense += v;
      expenseByCategory[cat] = (expenseByCategory[cat] || 0) + v;
    } else if (t.type === 'transfer') {
      transfersOut += t.amount;
    }
  }
  const net = income - expense;
  return {
    ym, income, expense, net, transfersOut,
    savingsRate: income > 0 ? net / income : null,
    expenseByCategory, incomeByCategory,
  };
}

/** Sumuje podkategorie do kategorii nadrzędnych. */
export function rollupByParent(byCategory, categories) {
  const parentOf = Object.fromEntries(categories.map((c) => [c.id, c.parentId || c.id]));
  const out = {};
  for (const [id, v] of Object.entries(byCategory)) {
    const p = parentOf[id] || id;
    out[p] = (out[p] || 0) + v;
  }
  return out;
}

/** Seria miesięcy kończąca się na endYm (włącznie), od najstarszego. */
export function monthsRange(endYm, n) {
  const out = [];
  for (let i = n - 1; i >= 0; i--) out.push(addMonths(endYm, -i));
  return out;
}

export function monthlySeries(transactions, endYm, n, opts) {
  return monthsRange(endYm, n).map((ym) => monthSummary(transactions, ym, opts));
}

/**
 * Średnie miesięczne z n miesięcy kończących się na endYm.
 * Liczymy tylko miesiące od pierwszej transakcji, żeby puste miesiące przed startem aplikacji nie zaniżały średniej.
 */
export function averages(transactions, endYm, n, opts) {
  const live = transactions.filter(isLive);
  if (!live.length) return { months: 0, income: 0, expense: 0, net: 0 };
  const firstYm = live.reduce((min, t) => (t.date < min ? t.date : min), live[0].date).slice(0, 7);
  const series = monthlySeries(live, endYm, n, opts).filter((s) => s.ym >= firstYm);
  const months = series.length;
  if (!months) return { months: 0, income: 0, expense: 0, net: 0 };
  const sum = (k) => series.reduce((a, s) => a + s[k], 0);
  return {
    months,
    income: Math.round(sum('income') / months),
    expense: Math.round(sum('expense') / months),
    net: Math.round(sum('net') / months),
  };
}

/** Status budżetów: limit miesięczny dla miesiąca ma pierwszeństwo przed domyślnym. */
export function budgetStatus(budgets, summary, categories) {
  const byParent = rollupByParent(summary.expenseByCategory, categories);
  const limits = {};
  for (const b of budgets) {
    const [scope, catId] = b.id.split(':');
    if (scope === 'default' && !(catId in limits)) limits[catId] = b.limit;
  }
  for (const b of budgets) {
    const [scope, catId] = b.id.split(':');
    if (scope === summary.ym) limits[catId] = b.limit;
  }
  return Object.entries(limits)
    .filter(([, limit]) => limit > 0)
    .map(([categoryId, limit]) => {
      const spent = byParent[categoryId] || 0;
      return { categoryId, limit, spent, left: limit - spent, ratio: spent / limit };
    });
}

/** Porównanie kategorii między dwoma miesiącami — posortowane od największego wzrostu. */
export function categoryChanges(current, previous, categories) {
  const a = rollupByParent(current.expenseByCategory, categories);
  const b = rollupByParent(previous.expenseByCategory, categories);
  const ids = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...ids]
    .map((id) => ({ categoryId: id, now: a[id] || 0, before: b[id] || 0, diff: (a[id] || 0) - (b[id] || 0) }))
    .sort((x, y) => y.diff - x.diff);
}
