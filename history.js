// Historia majątku miesiąc po miesiącu (z transakcji, wycen i zapisanych „zdjęć” majątku).
import { valuedNetWorth } from './valuation.js';
import { addMonths } from './dates.js';
import { isLive } from './calc.js';
import { accountGroup } from './defaults.js';

const lastDayOf = (ym) => { const [y, m] = ym.split('-').map(Number); return `${ym}-${String(new Date(y, m, 0).getDate()).padStart(2, '0')}`; };

/** Pierwszy miesiąc z danymi (transakcja, założenie konta albo zdjęcie majątku). */
export function firstMonth(accounts, transactions, snapshots = {}, fallback) {
  const c = [];
  for (const t of transactions) if (isLive(t)) c.push(t.date.slice(0, 7));
  for (const a of accounts) if (a.createdAt) c.push(a.createdAt.slice(0, 7));
  c.push(...Object.keys(snapshots));
  return c.length ? c.sort()[0] : fallback;
}

/** Podział majątku na grupy dla jednej daty. */
export function breakdown(accounts, values) {
  const out = { current: 0, savings: 0, property: 0, debt: 0 };
  for (const a of accounts) {
    if ((a.currency || 'PLN') !== 'PLN') continue;
    const v = values[a.id] || 0;
    const g = accountGroup(a);
    if (g === 'loan' || v < 0) out.debt += v; else out[g === 'property' ? 'property' : g === 'savings' ? 'savings' : 'current'] += v;
  }
  return out;
}

/** Seria [{ ym, net, assets, debt, parts, source }] od pierwszego miesiąca do currentYm. */
export function netWorthHistory({ accounts, transactions, prices, snapshots = {}, currentYm, today }) {
  const start = firstMonth(accounts, transactions, snapshots, currentYm);
  const out = [];
  for (let ym = start; ym <= currentYm; ym = addMonths(ym, 1)) {
    const asOf = ym === currentYm ? today : lastDayOf(ym);
    const w = valuedNetWorth(accounts, transactions, { asOf, prices, today });
    const snap = ym !== currentYm ? snapshots[ym] : null;
    out.push(snap
      ? { ym, net: snap.net, assets: snap.assets, debt: snap.liabilities, parts: snap.parts || breakdown(accounts, w.values), source: 'snapshot' }
      : { ym, net: w.net, assets: w.assets, debt: w.liabilities, parts: breakdown(accounts, w.values), source: 'calc' });
    if (out.length > 600) break;
  }
  return out;
}

/** Statystyki serii: zmiana m/m, r/r, najlepszy miesiąc, średni przyrost. */
export function historyStats(series) {
  const n = series.length;
  if (!n) return null;
  const last = series[n - 1];
  const diff = (k) => (n > k ? last.net - series[n - 1 - k].net : null);
  const pct = (k) => (n > k && series[n - 1 - k].net ? (last.net - series[n - 1 - k].net) / Math.abs(series[n - 1 - k].net) : null);
  let best = null;
  for (let i = 1; i < n; i++) { const d = series[i].net - series[i - 1].net; if (!best || d > best.diff) best = { ym: series[i].ym, diff: d }; }
  const avg = n > 1 ? Math.round((last.net - series[0].net) / (n - 1)) : 0;
  return { net: last.net, m1: diff(1), m1pct: pct(1), y1: diff(12), y1pct: pct(12), best, avg, months: n };
}
