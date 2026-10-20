// Wyceny inwestycji i metali — czyste funkcje (testowane).
// Zasada: „wpłacony kapitał” liczymy z salda początkowego i transakcji (wpłaty/wypłaty),
// a zmianę wartości rynkowej trzymamy osobno, żeby wpłata nie wyglądała jak zysk.
import { effectOnAccount, isLive } from './calc.js';

export const TROY_OUNCE_G = 31.1034768;
export const METALS = { gold: 'Złoto', silver: 'Srebro' };
export const metalOf = (a) => (a && METALS[a.subtype] ? a.subtype : null);

const END = '9999-12-31';

/** Wpłacony kapitał (saldo z transakcji) na koniec dnia asOf. */
export function bookBalance(account, transactions, asOf = END) {
  let sum = account.openingBalance || 0;
  for (const t of transactions) if (isLive(t) && t.date <= asOf) sum += effectOnAccount(t, account.id);
  return sum;
}

export function sortedValuations(account) {
  return [...(account.valuations || [])].sort((a, b) => a.date.localeCompare(b.date) || (a.at || '').localeCompare(b.at || ''));
}

/** Zmiana wartości rynkowej względem wpłaconego kapitału, wg ostatniej wyceny z datą <= asOf. */
export function valuationAdjustment(account, transactions, asOf = END) {
  const list = sortedValuations(account).filter((v) => v.date <= asOf);
  const last = list[list.length - 1];
  if (!last) return 0;
  // „book” = wpłacony kapitał zapamiętany przy zapisie wyceny (dzięki temu dopłata tego samego dnia nie jest stratą)
  return last.value - (Number.isInteger(last.book) ? last.book : bookBalance(account, transactions, last.date));
}

/** Wartość metalu w groszach: gramy × próba × cena (zł/g czystego kruszcu) × (1 − spread). */
export function metalValue(account, pricePerGramPLN) {
  if (!(pricePerGramPLN > 0)) return null;
  const grams = Number(account.grams) || 0;
  const purity = Number(account.purity) || 1;
  const spread = Number(account.spread) || 0;
  return Math.round(grams * purity * pricePerGramPLN * 100 * (1 - spread / 100));
}

/** Ostatnia cena z historii z datą <= date. */
export function priceAt(history, date) {
  let best = null;
  for (const h of history || []) if (h.date <= date && (!best || h.date > best.date)) best = h;
  return best;
}

/**
 * Wartość konta: dla metali — wg ceny (bieżącej albo historycznej), dla pozostałych —
 * wpłacony kapitał + ostatnia zmiana wartości z wycen.
 */
export function accountValue(account, transactions, { asOf = END, prices = null, today = END } = {}) {
  const metal = metalOf(account);
  if (metal && prices) {
    const p = asOf >= today ? prices[metal]?.pln : priceAt(prices.history?.[metal], asOf)?.pln;
    const v = metalValue(account, p);
    if (v != null) return v;
  }
  return bookBalance(account, transactions, asOf) + valuationAdjustment(account, transactions, asOf);
}

/** Wynik inwestycji: wpłacono, wartość, zysk/strata i %. */
export function investmentResult(account, transactions, opts) {
  const paidIn = bookBalance(account, transactions, opts?.asOf);
  const value = accountValue(account, transactions, opts);
  const gain = value - paidIn;
  return { paidIn, value, gain, gainPct: paidIn > 0 ? gain / paidIn : null };
}

/** Majątek netto z uwzględnieniem wycen i cen metali. */
export function valuedNetWorth(accounts, transactions, opts = {}, currency = 'PLN') {
  let assets = 0;
  let liabilities = 0;
  const values = {};
  for (const a of accounts) {
    if ((a.currency || 'PLN') !== currency) continue;
    const v = accountValue(a, transactions, opts);
    values[a.id] = v;
    if (a.archived && v === 0) continue;
    if (v >= 0) assets += v; else liabilities += -v;
  }
  return { assets, liabilities, net: assets - liabilities, values };
}

/** Nowa wycena: tryb 'amount' (nowa kwota w groszach) albo 'percent' (zmiana w %). */
export function applyChange(current, mode, input) {
  if (mode === 'percent') {
    if (!Number.isFinite(input)) return null;
    const value = Math.round(current * (1 + input / 100));
    return { value, diff: value - current, pct: input };
  }
  if (!Number.isInteger(input)) return null;
  return { value: input, diff: input - current, pct: current !== 0 ? ((input - current) / Math.abs(current)) * 100 : null };
}

/** USD za uncję → zł za gram. */
export const usdOzToPlnGram = (usdPerOz, usdPln) => (usdPerOz > 0 && usdPln > 0 ? (usdPerOz * usdPln) / TROY_OUNCE_G : null);

/** Dopisuje cenę dnia do historii (jedna na dzień, najnowsza wygrywa), trzyma ostatnie `max` wpisów. */
export function mergeHistory(history, entries, max = 800) {
  const map = new Map((history || []).map((h) => [h.date, h]));
  for (const e of entries || []) if (e && e.date && e.pln > 0) map.set(e.date, { date: e.date, pln: e.pln });
  return [...map.values()].sort((a, b) => a.date.localeCompare(b.date)).slice(-max);
}
