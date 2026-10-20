// v1.1 — czyste funkcje: puls finansowy, poduszka, subskrypcje, koperty, prognoza miesiąca, raport PIT,
// odznaki, seria dni, poziomy majątku, porównania, podpowiedzi przy dodawaniu, „ile mogę dziś wydać”.
import { isLive, monthSummary, averages, rollupByParent } from './calc.js';
import { addMonths, addDays, daysInMonth } from './dates.js';
import { planSummary, kindOf } from './plan.js';
import { accountGroup } from './defaults.js';

const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ł/g, 'l').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

// ---------- Poduszka bezpieczeństwa ----------
/** Pieniądze „pod ręką”: konta bieżące + oszczędności (bez IKE/IKZE/PPK, metali, krypto, nieruchomości). */
export function liquidSavings(accounts, values) {
  let sum = 0;
  for (const a of accounts) {
    if (a.archived || a.deletedAt || (a.currency || 'PLN') !== 'PLN') continue;
    const g = accountGroup(a);
    if (g === 'current' && a.type !== 'card') sum += Math.max(0, values[a.id] || 0);
    if (g === 'savings' && (a.type === 'savings' || ['deposit', 'bonds'].includes(a.subtype))) sum += Math.max(0, values[a.id] || 0);
  }
  return sum;
}

export function cushion({ liquid, avgExpense, goalMonths = 6 }) {
  const months = avgExpense > 0 ? liquid / avgExpense : null;
  const target = avgExpense * goalMonths;
  return { months, target, missing: Math.max(0, target - liquid), progress: target > 0 ? clamp(liquid / target, 0, 1) : 0 };
}

// ---------- Puls finansowy 0–100 ----------
/**
 * input: { savingsRate (0..1|null), cushionMonths, consumerDebt (grosze), avgIncome, planDone (0..1|null), trend (zmiana majątku m/m, grosze) }
 */
export function financialPulse(i) {
  const parts = [];
  const sr = i.savingsRate == null ? 0 : clamp(i.savingsRate / 0.2, 0, 1); // 20% odkładane = max
  parts.push({ key: 'savings', label: 'Odkładanie z dochodu', score: Math.round(sr * 30), max: 30,
    tip: i.savingsRate == null ? 'Wpisuj przychody i wydatki, żeby policzyć odkładanie.' : i.savingsRate < 0.2 ? `Odkładaj co najmniej 20% dochodu (teraz ${Math.round((i.savingsRate || 0) * 100)}%).` : null });
  const cu = i.cushionMonths == null ? 0 : clamp(i.cushionMonths / 6, 0, 1);
  parts.push({ key: 'cushion', label: 'Poduszka bezpieczeństwa', score: Math.round(cu * 25), max: 25,
    tip: (i.cushionMonths ?? 0) < 6 ? `Zbuduj poduszkę na 6 miesięcy (teraz ${(i.cushionMonths ?? 0).toFixed(1).replace('.', ',')}).` : null });
  const ratio = i.avgIncome > 0 ? i.consumerDebt / (i.avgIncome * 12) : (i.consumerDebt > 0 ? 1 : 0);
  const de = clamp(1 - ratio / 0.5, 0, 1); // dług konsumpcyjny ≥ pół rocznego dochodu = 0 pkt
  parts.push({ key: 'debt', label: 'Długi (bez hipoteki)', score: Math.round(de * 15), max: 15,
    tip: i.consumerDebt > 0 ? 'Nadpłacaj najdroższy kredyt konsumpcyjny.' : null });
  const pl = i.planDone == null ? 0.6 : clamp(i.planDone, 0, 1);
  parts.push({ key: 'plan', label: 'Trzymanie się planu', score: Math.round(pl * 15), max: 15,
    tip: i.planDone == null ? 'Zaplanuj miesiąc w zakładce Miesiąc.' : i.planDone < 0.9 ? 'Odhaczaj zaplanowane opłaty na bieżąco.' : null });
  const tr = i.trend == null ? 0.5 : i.trend > 0 ? 1 : i.trend === 0 ? 0.5 : 0;
  parts.push({ key: 'trend', label: 'Kierunek majątku', score: Math.round(tr * 15), max: 15,
    tip: i.trend != null && i.trend < 0 ? 'Majątek spadł w tym miesiącu — sprawdź, co wzrosło w wydatkach.' : null });
  const score = parts.reduce((s, p) => s + p.score, 0);
  const tips = parts.filter((p) => p.tip).sort((a, b) => (b.max - b.score) - (a.max - a.score)).map((p) => p.tip);
  const label = score >= 85 ? 'Świetnie' : score >= 70 ? 'Dobrze' : score >= 50 ? 'Nieźle' : score >= 30 ? 'Do poprawy' : 'Alarm';
  return { score, label, parts, tips };
}

// ---------- Subskrypcje ----------
const SUB_WORDS = /(netflix|spotify|youtube|disney|hbo|\bmax\b|apple|icloud|google one|amazon prime|prime video|canal|player|tidal|xbox|playstation|ps plus|nintendo|silowni|gym|fitness|multisport|abonament|subskrypc|chatgpt|claude|microsoft 365|office 365|dropbox|adobe|audioteka|storytel|legimi|empik go)/;

/** Wykrywa powtarzające się płatności. Zwraca [{ name, amount (średnia), months, yearly, keyword }] od najdroższych. */
export function detectSubscriptions(transactions, { endYm, lookback = 6 } = {}) {
  const from = addMonths(endYm, -(lookback - 1));
  const groups = new Map();
  for (const t of transactions) {
    if (!isLive(t) || t.type !== 'expense' || t.refund) continue;
    const ym = t.date.slice(0, 7);
    if (ym < from || ym > endYm) continue;
    const key = norm(t.description);
    if (['exp-food', 'exp-fuel', 'exp-transport'].includes(t.categoryId) && !SUB_WORDS.test(key)) continue; // zakupy i paliwo to nie subskrypcje
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, { name: t.description, list: [] });
    groups.get(key).list.push(t);
  }
  const out = [];
  for (const [key, g] of groups) {
    const months = new Set(g.list.map((t) => t.date.slice(0, 7)));
    const amounts = g.list.map((t) => t.amount);
    const avg = Math.round(amounts.reduce((s, a) => s + a, 0) / amounts.length);
    const stable = amounts.every((a) => Math.abs(a - avg) <= Math.max(200, avg * 0.15));
    const keyword = SUB_WORDS.test(key);
    const perMonth = g.list.length / months.size;
    if ((months.size >= 3 && stable && perMonth <= 1.5) || (keyword && months.size >= 1 && perMonth <= 1.5)) {
      out.push({ name: g.name, amount: avg, months: months.size, yearly: avg * 12, keyword });
    }
  }
  return out.sort((a, b) => b.yearly - a.yearly);
}

// ---------- Koperty ----------
/** envelopes: [{ id, name, icon, limit, categoryIds[] }] → stan na miesiąc (podkategorie liczą się do rodzica). */
export function envelopeStatus(envelopes, transactions, categories, ym) {
  const s = monthSummary(transactions.filter(isLive), ym);
  const byParent = rollupByParent(s.expenseByCategory, categories);
  const byCat = s.expenseByCategory;
  return envelopes.map((e) => {
    const spent = (e.categoryIds || []).reduce((sum, id) => sum + (byParent[id] ?? byCat[id] ?? 0), 0);
    return { ...e, spent, left: e.limit - spent, ratio: e.limit > 0 ? spent / e.limit : 0 };
  });
}

// ---------- Prognoza końca miesiąca ----------
/**
 * Wydatki „zmienne” (bez powiązanych z planem) liczone tempem z dotychczasowych dni,
 * do tego niezapłacone opłaty i niewpłynięte wpływy z planu.
 */
export function monthForecast({ transactions, bills, ym, today }) {
  const live = transactions.filter(isLive);
  const s = monthSummary(live, ym);
  const days = daysInMonth(ym);
  const day = today.slice(0, 7) === ym ? Number(today.slice(8, 10)) : (today > ym ? days : 0);
  const planTx = new Set(bills.filter((b) => b.month === ym && b.txId).map((b) => b.txId));
  const variable = live.filter((t) => t.type === 'expense' && t.date.startsWith(ym) && !planTx.has(t.id)).reduce((sum, t) => sum + (t.refund ? -t.amount : t.amount), 0);
  const perDay = day > 0 ? variable / day : 0;
  const restVariable = Math.round(perDay * (days - day));
  const ps = planSummary(bills, ym);
  const expense = s.expense + restVariable + ps.expense.left;
  const income = s.income + ps.income.left;
  return { income, expense, net: income - expense, perDay: Math.round(perDay), daysLeft: days - day, restVariable, unpaid: ps.expense.left, pendingIncome: ps.income.left };
}

// ---------- Ile mogę dziś wydać ----------
export function dailyAllowance({ transactions, bills, ym, today, savingGoal = 0, fallbackIncome = 0 }) {
  const live = transactions.filter(isLive);
  const s = monthSummary(live, ym);
  const ps = planSummary(bills, ym);
  const days = daysInMonth(ym);
  const day = Number(today.slice(8, 10));
  // brak wpływu i planu w tym miesiącu → przyjmij średni dochód z poprzednich miesięcy
  const estimated = s.income + ps.income.total === 0 && fallbackIncome > 0;
  const income = estimated ? fallbackIncome : s.income + ps.income.left;
  const left = income - s.expense - ps.expense.left - savingGoal;
  const daysLeft = days - day + 1;
  const spentToday = live.filter((t) => t.type === 'expense' && t.date === today).reduce((sum, t) => sum + (t.refund ? -t.amount : t.amount), 0);
  const perDay = daysLeft > 0 ? Math.floor((left + spentToday) / daysLeft) : 0;
  return { left, daysLeft, perDay, spentToday, todayLeft: perDay - spentToday, estimated };
}

// ---------- Raport do PIT ----------
const DONATION = /(darowizn|fundacj|stowarzyszen|caritas|wosp|siepomaga|zrzutka|pomagam)/;
const THERMO = /(termomoderniz|pompa ciepla|docieplen|fotowolt|kociol|okna|ocieplen)/;
const INTERNET = /(internet|swiatlowod|orange|upc|vectra|netia|play|t mobile|plus)/;

export function taxReport({ transactions, accounts, categories, year }) {
  const y = String(year);
  const live = transactions.filter((t) => isLive(t) && t.date.startsWith(y));
  const acc = Object.fromEntries(accounts.map((a) => [a.id, a]));
  const cat = Object.fromEntries(categories.map((c) => [c.id, c]));
  const r = { ikze: 0, ike: 0, ppk: 0, donations: [], thermo: [], internet: 0, income: 0 };
  for (const t of live) {
    const text = norm(`${t.description || ''} ${(t.tags || []).join(' ')} ${cat[t.categoryId]?.name || ''}`);
    if (t.type === 'income') r.income += t.amount;
    if (t.type === 'transfer' && t.toAccountId) {
      const sub = acc[t.toAccountId]?.subtype;
      if (sub === 'ikze') r.ikze += t.amount;
      if (sub === 'ike') r.ike += t.amount;
      if (sub === 'ppk') r.ppk += t.amount;
    }
    if (t.type === 'expense' && !t.refund) {
      if (DONATION.test(text)) r.donations.push(t);
      if (THERMO.test(text)) r.thermo.push(t);
      if (cat[t.categoryId]?.id === 'exp-bills' && INTERNET.test(text)) r.internet += t.amount;
    }
  }
  r.donationsSum = r.donations.reduce((s, t) => s + t.amount, 0);
  r.thermoSum = r.thermo.reduce((s, t) => s + t.amount, 0);
  r.internetDeductible = Math.min(r.internet, 76000); // ulga internetowa: maks. 760 zł rocznie
  return r;
}

// ---------- Poziomy majątku ----------
export const LEVELS = [
  [0, '🌱', 'Nasionko'], [1000000, '🌿', 'Kiełek'], [5000000, '🪴', 'Sadzonka'], [10000000, '🌳', 'Drzewo'],
  [25000000, '🌲', 'Las'], [50000000, '🏡', 'Dworek'], [100000000, '🏰', 'Zamek'], [250000000, '👑', 'Królestwo'],
];
export function levelOf(net) {
  let i = 0;
  while (i + 1 < LEVELS.length && net >= LEVELS[i + 1][0]) i++;
  const [from, icon, name] = LEVELS[i];
  const next = LEVELS[i + 1] || null;
  return { index: i + 1, icon, name, from, next: next ? { amount: next[0], icon: next[1], name: next[2] } : null,
    progress: next ? clamp((net - from) / (next[0] - from), 0, 1) : 1 };
}

// ---------- „W przeliczeniu na…” ----------
export const EQUIVALENTS = [
  ['🍕', 'pizz', 4500], ['☕', 'kaw na mieście', 1600], ['⛽', 'tankowań do pełna', 30000], ['🎬', 'biletów do kina', 3200],
  ['📱', 'iPhone’ów', 450000], ['✈️', 'lotów do Rzymu', 60000], ['🍔', 'zestawów w fast foodzie', 3500], ['🛒', 'tygodniowych zakupów', 40000],
];
/** 1–3 zabawne porównania dla kwoty (grosze). seed — żeby zestaw zmieniał się co miesiąc. */
export function equivalents(amount, seed = 0, n = 2) {
  if (!(amount > 0)) return [];
  const usable = EQUIVALENTS.filter(([, , price]) => amount / price >= 1);
  const list = usable.length ? usable : EQUIVALENTS.slice(0, 1);
  const out = [];
  for (let i = 0; i < Math.min(n, list.length); i++) {
    const [icon, label, price] = list[(seed + i * 3) % list.length];
    if (out.some((x) => x.label === label)) continue;
    const q = amount / price;
    out.push({ icon, label, count: q >= 10 ? Math.round(q) : Math.round(q * 10) / 10 });
  }
  return out;
}

// ---------- Seria dni ----------
/** Dzień się liczy, gdy jest w nim transakcja albo oznaczono „nic dziś nie wydałem”. */
export function streak(transactions, noSpendDays = [], today) {
  const days = new Set(noSpendDays);
  for (const t of transactions) if (isLive(t)) days.add(t.date);
  let current = 0;
  let d = days.has(today) ? today : addDays(today, -1); // dziś jeszcze można dopisać
  while (days.has(d)) { current++; d = addDays(d, -1); }
  const sorted = [...days].sort();
  let best = 0; let run = 0; let prev = null;
  for (const x of sorted) { run = prev && addDays(prev, 1) === x ? run + 1 : 1; best = Math.max(best, run); prev = x; }
  return { current, best: Math.max(best, current), today: days.has(today) };
}

// ---------- Odznaki ----------
export const BADGES = [
  { id: 'first-tx', icon: '✍️', name: 'Pierwszy wpis', desc: 'Dodaj pierwszą transakcję' },
  { id: 'tx-100', icon: '📚', name: 'Kronikarz', desc: '100 zapisanych transakcji' },
  { id: 'streak-7', icon: '🔥', name: 'Tydzień w rytmie', desc: 'Seria 7 dni' },
  { id: 'streak-30', icon: '🌋', name: 'Miesiąc w rytmie', desc: 'Seria 30 dni' },
  { id: 'plus-1', icon: '➕', name: 'Na plusie', desc: 'Zamknij miesiąc na plusie' },
  { id: 'plus-3', icon: '📈', name: 'Trzy na plusie', desc: '3 miesiące z rzędu na plusie' },
  { id: 'save-20', icon: '🐷', name: 'Oszczędny', desc: 'Odłóż 20% dochodu w miesiącu' },
  { id: 'nw-10k', icon: '💰', name: 'Pierwsze 10 000 zł', desc: 'Majątek netto 10 000 zł' },
  { id: 'nw-100k', icon: '💎', name: 'Sto tysięcy', desc: 'Majątek netto 100 000 zł' },
  { id: 'nw-1m', icon: '🏆', name: 'Milioner', desc: 'Majątek netto 1 000 000 zł' },
  { id: 'cushion-3', icon: '🛟', name: 'Mała poduszka', desc: 'Oszczędności na 3 miesiące' },
  { id: 'cushion-6', icon: '🛡️', name: 'Pełna poduszka', desc: 'Oszczędności na 6 miesięcy' },
  { id: 'plan-all', icon: '✅', name: 'Wszystko opłacone', desc: 'Odhacz cały plan miesiąca' },
  { id: 'loan-25', icon: '🔓', name: 'Ćwierć kredytu', desc: 'Spłać 25% kredytu' },
  { id: 'loan-done', icon: '🎉', name: 'Bez długu', desc: 'Spłać kredyt do zera' },
  { id: 'goal', icon: '🎯', name: 'Cel osiągnięty', desc: 'Zgromadź całą kwotę na zakup' },
  { id: 'pulse-80', icon: '❤️', name: 'Zdrowe finanse', desc: 'Puls finansowy 80+' },
  { id: 'capsule', icon: '💌', name: 'List do siebie', desc: 'Napisz kapsułę czasu' },
];

/** facts → lista id zdobytych odznak. */
export function earnedBadges(f) {
  const e = [];
  if (f.txCount >= 1) e.push('first-tx');
  if (f.txCount >= 100) e.push('tx-100');
  if (f.bestStreak >= 7) e.push('streak-7');
  if (f.bestStreak >= 30) e.push('streak-30');
  if (f.plusMonthsBest >= 1) e.push('plus-1');
  if (f.plusMonthsBest >= 3) e.push('plus-3');
  if (f.bestSavingsRate >= 0.2) e.push('save-20');
  if (f.net >= 1000000) e.push('nw-10k');
  if (f.net >= 10000000) e.push('nw-100k');
  if (f.net >= 100000000) e.push('nw-1m');
  if (f.cushionMonths >= 3) e.push('cushion-3');
  if (f.cushionMonths >= 6) e.push('cushion-6');
  if (f.planAllPaid) e.push('plan-all');
  if (f.loanBestRepaid >= 0.25) e.push('loan-25');
  if (f.loanPaidOff) e.push('loan-done');
  if (f.goalReached) e.push('goal');
  if (f.pulse >= 80) e.push('pulse-80');
  if (f.capsules >= 1) e.push('capsule');
  return e;
}

/** Najdłuższa seria zamkniętych miesięcy na plusie (bez bieżącego). */
export function plusMonthsBest(transactions, currentYm, back = 24) {
  let best = 0; let run = 0;
  for (let i = back; i >= 1; i--) {
    const ym = addMonths(currentYm, -i);
    const s = monthSummary(transactions, ym);
    if (s.income === 0 && s.expense === 0) { run = 0; continue; }
    run = s.net > 0 ? run + 1 : 0;
    best = Math.max(best, run);
  }
  return best;
}

// ---------- Podpowiedzi przy dodawaniu ----------
/** Szablony z historii, najlepiej pasujące do pory dnia i dnia tygodnia (np. „Żabka 15 zł” rano w dzień roboczy). */
export function smartSuggestions(transactions, now = new Date(), n = 6) {
  const hour = now.getHours();
  const wd = now.getDay();
  const map = new Map();
  for (const t of transactions) {
    if (!isLive(t) || !t.description || t.type === 'transfer') continue;
    const key = `${t.type}|${norm(t.description)}|${t.categoryId}`;
    const created = t.createdAt ? new Date(t.createdAt) : null;
    let score = 1;
    if (created && !Number.isNaN(created.getTime())) {
      const dh = Math.abs(created.getHours() - hour);
      if (Math.min(dh, 24 - dh) <= 2) score += 2;
      if (created.getDay() === wd) score += 1;
      const age = (now - created) / 864e5;
      if (age < 30) score += 1;
    }
    const cur = map.get(key);
    if (cur) { cur.score += score; cur.count += 1; if ((t.createdAt || '') > (cur.t.createdAt || '')) cur.t = t; }
    else map.set(key, { t, score, count: 1 });
  }
  return [...map.values()].sort((a, b) => b.score - a.score || b.count - a.count).slice(0, n).map((x) => x.t);
}

// ---------- Rok w pigułce ----------
export function yearSummary(transactions, categories, year) {
  const y = String(year);
  const months = Array.from({ length: 12 }, (_, i) => `${y}-${String(i + 1).padStart(2, '0')}`);
  const live = transactions.filter(isLive);
  const per = months.map((ym) => ({ ym, ...monthSummary(live, ym) }));
  const used = per.filter((m) => m.income || m.expense);
  const income = per.reduce((s, m) => s + m.income, 0);
  const expense = per.reduce((s, m) => s + m.expense, 0);
  const byCat = {};
  for (const m of per) for (const [id, v] of Object.entries(rollupByParent(m.expenseByCategory, categories))) byCat[id] = (byCat[id] || 0) + v;
  const topCat = Object.entries(byCat).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1])[0] || null;
  const shops = {};
  for (const t of live) if (t.date.startsWith(y) && t.type === 'expense' && t.description) { const k = t.description.trim(); shops[k] = (shops[k] || 0) + 1; }
  const topShop = Object.entries(shops).sort((a, b) => b[1] - a[1])[0] || null;
  const priciest = used.length ? used.reduce((a, b) => (b.expense > a.expense ? b : a)) : null;
  const best = used.length ? used.reduce((a, b) => (b.net > a.net ? b : a)) : null;
  return { year: Number(y), income, expense, net: income - expense, savingsRate: income > 0 ? (income - expense) / income : null,
    months: used.length, topCategory: topCat ? { id: topCat[0], amount: topCat[1] } : null, topShop: topShop ? { name: topShop[0], count: topShop[1] } : null,
    priciest: priciest ? { ym: priciest.ym, amount: priciest.expense } : null, best: best ? { ym: best.ym, net: best.net } : null,
    txCount: live.filter((t) => t.date.startsWith(y)).length };
}

/** Do planu „ile mogę dziś wydać”: czy pozycja jest wydatkiem z planu. */
export const isPlanExpense = (b) => kindOf(b) === 'expense';
export { averages };
