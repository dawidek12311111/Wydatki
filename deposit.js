// Lokaty i konta oszczędnościowe: odsetki, podatek Belki, koniec lokaty. Czyste funkcje (testowane).
import { BELKA } from './sim.js';

const DAY = 86400000;
const toDate = (iso) => { const [y, m, d] = iso.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)); };
const iso = (dt) => dt.toISOString().slice(0, 10);

/** Data końca lokaty: start + n miesięcy (31.01 + 1 mies. → 28/29.02). */
export function addMonthsDate(startIso, months) {
  const s = toDate(startIso);
  const y = s.getUTCFullYear(); const m = s.getUTCMonth() + months; const d = s.getUTCDate();
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return iso(new Date(Date.UTC(y, m, Math.min(d, last))));
}

export const daysBetween = (a, b) => Math.round((toDate(b) - toDate(a)) / DAY);
const taxOf = (gross) => Math.round(gross * BELKA); // podatek zaokrąglony do grosza

/**
 * Lokata terminowa: principal (grosze), rate (% rocznie), months, startDate, today.
 * Odsetki = kapitał × stopa × miesiące/12 (jak w większości banków dla lokat miesięcznych).
 */
export function termDeposit({ principal, rate, months, startDate, today }) {
  const end = addMonthsDate(startDate, months);
  const gross = Math.round(principal * (rate / 100) * (months / 12));
  const tax = taxOf(gross);
  const net = gross - tax;
  const total = daysBetween(startDate, end);
  const passed = Math.min(Math.max(daysBetween(startDate, today), 0), total);
  const accrued = total > 0 ? Math.round(net * (passed / total)) : 0;
  return { end, gross, tax, net, payout: principal + net, daysLeft: Math.max(0, daysBetween(today, end)), passed, total, accrued, ended: today >= end };
}

/** Konto oszczędnościowe: zarobek netto w miesiącu i w roku (z opcjonalną promocją do limitu). */
export function savingsEstimate({ balance, rate, promoRate = null, promoLimit = null, promoActive = false }) {
  let yearGross;
  if (promoActive && promoRate != null) {
    const inPromo = promoLimit ? Math.min(balance, promoLimit) : balance;
    yearGross = inPromo * (promoRate / 100) + (balance - inPromo) * (rate / 100);
  } else yearGross = balance * (rate / 100);
  const monthGross = Math.round(yearGross / 12);
  return { month: monthGross - taxOf(monthGross), year: Math.round(yearGross) - taxOf(Math.round(yearGross)) };
}

export const isTermDeposit = (a) => a?.depositKind === 'term' && a.rate > 0 && a.termMonths > 0 && !!a.startDate;

/** Lokaty, które kończą się w ciągu `days` dni albo już się skończyły (bez odłożonych „później”). */
export function depositsDue(accounts, balances, today, days = 7, snoozed = {}) {
  return accounts.filter((a) => !a.archived && !a.deletedAt && isTermDeposit(a)).map((a) => {
    const r = termDeposit({ principal: balances[a.id] || 0, rate: a.rate, months: a.termMonths, startDate: a.startDate, today });
    return { account: a, ...r };
  }).filter((x) => x.daysLeft <= days && (balances[x.account.id] || 0) > 0 && !(snoozed[x.account.id] && snoozed[x.account.id] > today));
}
