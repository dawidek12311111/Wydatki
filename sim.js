// Symulacja majątku w czasie i analiza kredytu inwestycyjnego — czyste funkcje.
// To SZACUNKI na założeniach użytkownika, nie prognoza ani gwarancja.
import { loanInstallment } from './purchases.js';

export const BELKA = 0.19;

export const DEFAULT_SIM = {
  years: 10,
  monthly: null, // null = średnia nadwyżka z danych
  rSafe: 5, // lokaty, obligacje, konta oszczędnościowe
  rMarket: 7, // ETF, fundusze, akcje, krypto
  rRetire: 7, // IKE, IKZE, PPK (bez podatku Belki)
  rMetal: 4, // złoto, srebro
  inflation: 3.5,
  belka: true,
  overpay: 0, // nadpłata kredytów miesięcznie (zł)
  allocSafe: 50, allocMarket: 30, allocRetire: 20,
  loanRateDefault: 8, // gdy kredyt nie ma wpisanego oprocentowania
  il: { on: false, amount: 50000, rate: 9, months: 60, ret: 8, target: 'market' },
};

/** Do jakiego „koszyka” trafia konto w symulacji. */
export function bucketOf(a) {
  if (a.type === 'loan') return 'debt';
  if (a.subtype === 'gold' || a.subtype === 'silver') return 'metal';
  if (['ike', 'ikze', 'ppk'].includes(a.subtype)) return 'retire';
  if (a.type === 'savings' || a.subtype === 'deposit' || a.subtype === 'bonds') return 'safe';
  if (a.type === 'investment') return 'market';
  return 'cash';
}

const TAXED = { safe: true, market: true, retire: false, metal: false, cash: false };

/**
 * Symulacja miesiąc po miesiącu.
 * start: { cash, safe, market, retire, metal } w groszach
 * loans: [{ name, balance (grosze, dodatnie), rate (%), installment (grosze) }]
 * monthly: miesięczna nadwyżka przed ratami (grosze) — raty i nadpłaty są z niej opłacane
 */
export function simulate({ start, loans = [], monthly = 0, years = 10, rates, inflation = 0, belka = true, overpay = 0, alloc, investLoan = null }) {
  const b = { cash: 0, safe: 0, market: 0, retire: 0, metal: 0, ...start };
  const L = loans.filter((l) => l.balance > 0).map((l) => ({ ...l, paidOff: null }));
  if (investLoan && investLoan.amount > 0 && investLoan.months > 0) {
    b[investLoan.target || 'market'] += investLoan.amount;
    L.push({ name: 'Kredyt inwestycyjny', balance: investLoan.amount, rate: investLoan.rate, installment: loanInstallment(investLoan.amount, investLoan.rate, investLoan.months), paidOff: null, invest: true });
  }
  const net = (key) => (rates[key] / 100) * (belka && TAXED[key] ? 1 - BELKA : 1);
  const monthlyRate = { safe: net('safe') / 12, market: net('market') / 12, retire: net('retire') / 12, metal: net('metal') / 12 };
  const a = { safe: (alloc?.safe ?? 100) / 100, market: (alloc?.market ?? 0) / 100, retire: (alloc?.retire ?? 0) / 100 };
  const aSum = a.safe + a.market + a.retire || 1;
  const debt = () => L.reduce((s, l) => s + l.balance, 0);
  const point = (m) => {
    const assets = b.cash + b.safe + b.market + b.retire + b.metal;
    const d = debt();
    const n = assets - d;
    return {
      month: m, cash: Math.round(b.cash), safe: Math.round(b.safe), market: Math.round(b.market), retire: Math.round(b.retire), metal: Math.round(b.metal),
      assets: Math.round(assets), debt: Math.round(d), net: Math.round(n), netReal: Math.round(n / (1 + inflation / 100) ** (m / 12)),
    };
  };
  const series = [point(0)];
  let interestPaid = 0;
  const total = Math.round(years * 12);
  for (let m = 1; m <= total; m++) {
    for (const k of ['safe', 'market', 'retire', 'metal']) b[k] *= 1 + monthlyRate[k];
    // raty
    let paid = 0;
    for (const l of L) {
      if (l.balance <= 0) continue;
      const interest = l.balance * (l.rate / 100 / 12);
      interestPaid += interest;
      const pay = Math.min(l.installment || 0, l.balance + interest);
      l.balance = l.balance + interest - pay;
      paid += pay;
    }
    // nadpłata: najpierw najdroższy kredyt
    let extra = overpay;
    for (const l of [...L].sort((x, y) => y.rate - x.rate)) {
      if (extra <= 0) break;
      if (l.balance <= 0) continue;
      const p = Math.min(extra, l.balance);
      l.balance -= p;
      extra -= p;
      paid += p;
    }
    for (const l of L) if (l.balance <= 0.5 && l.paidOff == null) { l.balance = 0; l.paidOff = m; }
    // reszta nadwyżki do koszyków albo pokrycie braku
    let free = monthly - paid;
    if (free >= 0) {
      b.safe += (free * a.safe) / aSum;
      b.market += (free * a.market) / aSum;
      b.retire += (free * a.retire) / aSum;
    } else {
      for (const k of ['cash', 'safe', 'market', 'retire', 'metal']) {
        const take = Math.min(b[k], -free);
        b[k] -= take;
        free += take;
        if (free >= 0) break;
      }
      if (free < 0) b.cash += free; // brak pieniędzy = konto na minusie
    }
    if (m % 12 === 0 || m === total) series.push(point(m));
  }
  const final = series[series.length - 1];
  const milestones = [100_000, 250_000, 500_000, 1_000_000, 2_000_000].map((zl) => zl * 100)
    .filter((g) => g > series[0].net)
    .map((g) => ({ amount: g, month: series.find((p) => p.net >= g)?.month ?? null }))
    .filter((x) => x.month != null);
  return {
    series, final, interestPaid: Math.round(interestPaid),
    payoffs: L.map((l) => ({ name: l.name, month: l.paidOff, left: Math.round(l.balance), invest: !!l.invest })),
    milestones,
  };
}

/**
 * Kredyt inwestycyjny: inwestuję pożyczoną kwotę od razu (A)
 * vs. bez kredytu odkładam co miesiąc tyle, ile wynosiłaby rata (B). Porównanie po okresie kredytu.
 */
export function investLoanAnalysis({ amount, rate, months, ret, belka = true }) {
  const inst = loanInstallment(amount, rate, months);
  const tax = belka ? 1 - BELKA : 1;
  const outcome = (r) => {
    const m = r / 100 / 12;
    const grossA = amount * (1 + m) ** months;
    const netA = amount + (grossA - amount) * (grossA > amount ? tax : 1);
    const paid = inst * months;
    const grossB = m === 0 ? paid : inst * (((1 + m) ** months - 1) / m);
    const netB = paid + (grossB - paid) * (grossB > paid ? tax : 1);
    return { netA: Math.round(netA), netB: Math.round(netB), benefit: Math.round(netA - netB) };
  };
  // próg opłacalności: zwrot, przy którym A = B (bisekcja)
  let lo = -30; let hi = 60; let breakEven = null;
  if (outcome(lo).benefit < 0 && outcome(hi).benefit > 0) {
    for (let i = 0; i < 60; i++) {
      const mid = (lo + hi) / 2;
      if (outcome(mid).benefit < 0) lo = mid; else hi = mid;
    }
    breakEven = Math.round(((lo + hi) / 2) * 10) / 10;
  }
  const scen = (r) => ({ ret: r, ...outcome(r) });
  return {
    installment: inst, totalPaid: inst * months, interest: inst * months - amount, breakEven,
    pessimistic: scen(ret - 5), base: scen(ret), optimistic: scen(ret + 3),
  };
}
