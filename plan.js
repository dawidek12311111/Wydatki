// Plan miesiąca (wpływy i rzeczy do zapłaty) oraz kalendarz — czyste funkcje.
// Pozycje planu są w magazynie „bills”; kind: 'expense' (domyślnie) albo 'income'.
import { daysInMonth, dateInMonth, pad } from './dates.js';
import { isLive, monthSummary } from './calc.js';

export const kindOf = (b) => (b.kind === 'income' ? 'income' : 'expense');

function part(list) {
  const total = list.reduce((s, b) => s + b.amount, 0);
  const done = list.filter((b) => b.paid).reduce((s, b) => s + b.amount, 0);
  return { count: list.length, doneCount: list.filter((b) => b.paid).length, total, done, left: total - done };
}

/** Podsumowanie planu: wpływy, wydatki, ile zostanie (plan) i ile jest już faktycznie (zrealizowane pozycje). */
export function planSummary(bills, ym) {
  const list = bills.filter((b) => b.month === ym);
  const income = part(list.filter((b) => kindOf(b) === 'income'));
  const expense = part(list.filter((b) => kindOf(b) === 'expense'));
  return { income, expense, plannedNet: income.total - expense.total, doneNet: income.done - expense.done };
}

const keyOf = (b) => `${kindOf(b)}|${b.name.trim().toLowerCase()}`;

/** Pozycje z fromYm, których nie ma jeszcze w toYm — do skopiowania (jako niezrealizowane, bez powiązanej transakcji). */
export function planToCopy(bills, fromYm, toYm) {
  const existing = new Set(bills.filter((b) => b.month === toYm).map(keyOf));
  return bills
    .filter((b) => b.month === fromYm && !existing.has(keyOf(b)))
    .sort((a, b) => kindOf(b).localeCompare(kindOf(a)) || (a.day || 99) - (b.day || 99) || (a.order || 0) - (b.order || 0))
    .map((b) => ({
      kind: kindOf(b), name: b.name, amount: b.amount, icon: b.icon, note: b.note || '',
      day: b.day || null, categoryId: b.categoryId || null, accountId: b.accountId || null,
      month: toYm, paid: false, paidAt: null, txId: null, sourceId: b.id,
    }));
}

/**
 * Transakcja tworzona przy odhaczeniu pozycji planu.
 * Data: dziś, jeśli to bieżący miesiąc; inaczej dzień z planu (albo 1.) w tym miesiącu.
 */
export function autoTransaction(item, { today, paidDate = null, accountId, fallbackCategory }) {
  const kind = kindOf(item);
  // kolejność: dzień odhaczenia (jeśli w tym miesiącu) → dziś (jeśli bieżący miesiąc) → dzień z planu
  const date = paidDate && paidDate.slice(0, 7) === item.month ? paidDate
    : today.slice(0, 7) === item.month ? today : dateInMonth(item.month, item.day);
  return {
    type: kind,
    amount: item.amount,
    currency: 'PLN',
    date,
    categoryId: item.categoryId || fallbackCategory,
    accountId: item.accountId || accountId,
    toAccountId: null,
    description: item.name,
    tags: [],
    recurring: false,
    refund: false,
    planId: item.id,
  };
}

/** Siatka kalendarza (poniedziałek pierwszy): tablica tygodni po 7 dni, puste pola = null. */
export function calendarGrid(ym) {
  const [y, m] = ym.split('-').map(Number);
  const first = (new Date(y, m - 1, 1).getDay() + 6) % 7; // 0 = poniedziałek
  const days = daysInMonth(ym);
  const cells = Array(first).fill(null);
  for (let d = 1; d <= days; d++) cells.push(`${ym}-${pad(d)}`);
  while (cells.length % 7) cells.push(null);
  const weeks = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
  return weeks;
}

/** Znaczniki dni: transakcje (przychód/wydatek) i pozycje planu z ustawionym dniem. */
export function dayMarks(transactions, bills, ym) {
  const marks = {};
  const get = (iso) => (marks[iso] ||= { income: 0, expense: 0, planIncome: 0, planExpense: 0, planOpen: 0 });
  for (const t of transactions) {
    if (!isLive(t) || !t.date.startsWith(ym) || t.currency !== 'PLN') continue;
    if (t.type === 'income') get(t.date).income += t.amount;
    else if (t.type === 'expense') get(t.date).expense += t.refund ? -t.amount : t.amount;
  }
  for (const b of bills) {
    if (b.month !== ym || !b.day) continue;
    const m = get(dateInMonth(ym, b.day));
    if (kindOf(b) === 'income') m.planIncome += b.amount; else m.planExpense += b.amount;
    if (!b.paid) m.planOpen += 1;
  }
  return marks;
}

/**
 * Kafelek roku: rzeczywisty bilans z transakcji (jeśli są) oraz bilans planu.
 * source: 'actual' gdy są transakcje, 'plan' gdy jest tylko plan, null gdy pusto.
 */
export function yearTiles(transactions, bills, year) {
  const out = [];
  for (let m = 1; m <= 12; m++) {
    const ym = `${year}-${pad(m)}`;
    const s = monthSummary(transactions, ym);
    const hasTx = transactions.some((t) => isLive(t) && t.date.startsWith(ym) && t.type !== 'transfer');
    const p = planSummary(bills, ym);
    const hasPlan = p.income.count + p.expense.count > 0;
    out.push({ ym, actual: hasTx ? s.net : null, plan: hasPlan ? p.plannedNet : null, source: hasTx ? 'actual' : hasPlan ? 'plan' : null });
  }
  return out;
}

/** Odhaczone pozycje bez (żywej) powiązanej transakcji — np. odhaczone w starszej wersji aplikacji. */
export function paidWithoutTx(bills, transactions, ym) {
  const live = new Set(transactions.filter(isLive).map((t) => t.id));
  return bills.filter((b) => b.month === ym && b.paid && !(b.txId && live.has(b.txId)));
}
