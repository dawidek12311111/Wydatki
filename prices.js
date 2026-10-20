// Ceny złota i srebra. Aplikacja tylko POBIERA publiczne ceny — nie wysyła żadnych Twoich danych.
// Złoto: NBP (zł za 1 g złota próby 1000). Srebro: gold-api.com (USD za uncję) × kurs USD z NBP.
import { usdOzToPlnGram, mergeHistory } from './valuation.js';
import { todayISO, addDays } from './dates.js';

const NBP = 'https://api.nbp.pl/api';
const GOLD_API = 'https://api.gold-api.com';

async function getJSON(url) {
  let res;
  try {
    res = await fetch(url, { headers: { Accept: 'application/json' }, credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store' });
  } catch {
    throw new Error('brak połączenia');
  }
  if (!res.ok) throw new Error(`błąd ${res.status}`);
  return res.json();
}

export async function fetchGoldNBP() {
  const j = await getJSON(`${NBP}/cenyzlota/last/1/?format=json`);
  const row = Array.isArray(j) ? j[0] : null;
  if (!row || !(row.cena > 0)) throw new Error('nieoczekiwana odpowiedź NBP');
  return { pln: row.cena, date: row.data, source: 'NBP' };
}

/** Historia ceny złota z NBP (maks. 93 dni na zapytanie — pobieramy kawałkami). */
export async function fetchGoldHistoryNBP(days = 365) {
  const out = [];
  let end = todayISO();
  let left = days;
  while (left > 0) {
    const span = Math.min(90, left);
    const start = addDays(end, -span + 1);
    try {
      const j = await getJSON(`${NBP}/cenyzlota/${start}/${end}/?format=json`);
      for (const r of j) if (r.cena > 0) out.push({ date: r.data, pln: r.cena });
    } catch { /* brak notowań w danym okresie (np. 404) — pomijamy */ }
    end = addDays(start, -1);
    left -= span;
  }
  return out;
}

export async function fetchUsdPln() {
  const j = await getJSON(`${NBP}/exchangerates/rates/a/usd/?format=json`);
  const r = j?.rates?.[0];
  if (!r || !(r.mid > 0)) throw new Error('nieoczekiwana odpowiedź NBP (kurs USD)');
  return { rate: r.mid, date: r.effectiveDate };
}

/** Bieżąca cena w USD za uncję trojańską (gold-api.com, bez klucza). */
export async function fetchSpotUsd(symbol) {
  const j = await getJSON(`${GOLD_API}/price/${symbol}`);
  if (!(j?.price > 0)) throw new Error('nieoczekiwana odpowiedź gold-api.com');
  return { usdOz: j.price, at: j.updatedAt || null };
}

/**
 * Odświeża ceny. Zwraca nowy obiekt cen (do zapisania w ustawieniach) i listę problemów.
 * prev: poprzednio zapisane ceny (używane, gdy coś się nie uda — aplikacja działa dalej).
 */
export async function refreshPrices(prev = {}, { withHistory = false } = {}) {
  const today = todayISO();
  const p = { history: { gold: [], silver: [], ...(prev.history || {}) }, ...prev };
  p.history = { gold: prev.history?.gold || [], silver: prev.history?.silver || [] };
  const problems = [];
  let usd = null;
  try { usd = await fetchUsdPln(); p.usd = usd; } catch (e) { problems.push(`kurs USD: ${e.message}`); usd = prev.usd || null; }

  // złoto: NBP, a gdy NBP nie odpowie — gold-api.com
  try {
    p.gold = await fetchGoldNBP();
  } catch (e) {
    try {
      const s = await fetchSpotUsd('XAU');
      const pln = usdOzToPlnGram(s.usdOz, usd?.rate);
      if (!pln) throw new Error('brak kursu USD');
      p.gold = { pln: Math.round(pln * 100) / 100, date: today, source: 'gold-api.com' };
    } catch (e2) { problems.push(`złoto: ${e.message} / ${e2.message}`); }
  }
  if (p.gold?.pln) p.history.gold = mergeHistory(p.history.gold, [{ date: p.gold.date || today, pln: p.gold.pln }]);
  if (withHistory) {
    try { p.history.gold = mergeHistory(p.history.gold, await fetchGoldHistoryNBP(365)); } catch { /* historia opcjonalna */ }
    p.goldHistoryAt = today;
  }

  // srebro: gold-api.com × kurs USD z NBP
  try {
    const s = await fetchSpotUsd('XAG');
    const pln = usdOzToPlnGram(s.usdOz, usd?.rate);
    if (!pln) throw new Error('brak kursu USD');
    p.silver = { pln: Math.round(pln * 100) / 100, date: today, source: 'gold-api.com', usdOz: s.usdOz };
    p.history.silver = mergeHistory(p.history.silver, [{ date: today, pln: p.silver.pln }]);
  } catch (e) { problems.push(`srebro: ${e.message}`); }

  p.updatedAt = new Date().toISOString();
  return { prices: p, problems };
}
