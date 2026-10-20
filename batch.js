// „Szybka aktualizacja”: jedno zdanie → lista operacji do zatwierdzenia.
// Przykład: „wpłynęła wypłata 9k PLN, wpłata do ppk 300, przelewam na oszczędnościowe 300, na ikze 300, spłata kredytów według planu”
// Działa bez internetu. Nic nie jest zapisywane bez zatwierdzenia przez użytkownika.
import { parseQuick, guessCategory } from './parse.js';
import { kindOf } from './plan.js';

const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ł/g, 'l');

/** Kwota z tekstu: „9k”, „9 tys.”, „9 000”, „300 zł”, „87,40”, „1,5k”. Zwraca grosze albo null. */
export function amountIn(text) {
  const t = ` ${String(text)} `;
  const re = /(?:^|[\s(])(\d{1,3}(?:[  ]\d{3})+|\d+)(?:[.,](\d{1,2}))?\s*(k|tys\.?|tysiecy|tysięcy|tysiące|tysiace)?(?=[\s.,;:)!]|zl|zł|pln|$)/i;
  const m = t.match(re);
  if (!m) return null;
  let v = Number(m[1].replace(/[  ]/g, '') + (m[2] ? '.' + m[2] : ''));
  if (m[3]) v *= 1000;
  return Number.isFinite(v) && v > 0 ? Math.round(v * 100) : null;
}

/** Dzieli zdanie na części: przecinek ze spacją, kropka ze spacją, średnik, nowa linia, „ oraz ”, „ a potem ”. */
export function splitClauses(text) {
  return String(text || '')
    .replace(/(\d)[.,](\d)/g, '$1\u0000$2') // chroń przecinek/kropkę w liczbach
    .split(/[;\n]|,\s+|\.\s+|\s+oraz\s+|\s+a potem\s+|\s+potem\s+/i)
    .map((s) => s.replace(/\u0000/g, ',').replace(/[.,]\s*$/, '').trim())
    .filter((s) => s.length > 1);
}

const INCOME_RE = /(wplyn|wyplat|wynagrodz|pensj|premi|800\+|swiadcz|zwrot podatku|przychod|dostal)/;
const LOAN_RE = /(splat|rat[ay]?\b|rate\b|kredyt)/;
const PLAN_RE = /(wedlug planu|wg planu|z planu|zgodnie z planem|jak w planie)/;
const TRANSFER_RE = /(przelew|przelewam|przelalem|przelano|wplata do|wplata na|wplacam|wplacilem|odkladam|odlozylem|na konto|^na |\bna (ike|ikze|ppk|oszczed|lokat|etf|krypto|zloto))/;

/** Konto docelowe po słowach kluczowych i nazwie. Kolejność ważna: IKZE przed IKE. */
export function matchAccount(clause, accounts) {
  const c = norm(clause);
  const live = accounts.filter((a) => !a.archived && !a.deletedAt);
  // 1) nazwa konta wprost (najdłuższa pasująca)
  const byName = live
    .filter((a) => a.name && norm(a.name).split(/\s+/).filter((w) => w.length > 2).some((w) => c.includes(w)) && !/^(konto|osobiste)$/i.test(norm(a.name)))
    .sort((x, y) => y.name.length - x.name.length);
  const rules = [
    [/ikze/, (a) => a.subtype === 'ikze'],
    [/\bike\b/, (a) => a.subtype === 'ike'],
    [/ppk/, (a) => a.subtype === 'ppk'],
    [/oszczed|odklad/, (a) => a.type === 'savings' || a.subtype === 'deposit'],
    [/lokat/, (a) => a.subtype === 'deposit' || a.type === 'savings'],
    [/obligac/, (a) => a.subtype === 'bonds'],
    [/etf|fundusz|akcj/, (a) => a.subtype === 'etf'],
    [/krypto|bitcoin|btc/, (a) => a.subtype === 'crypto'],
    [/zlot/, (a) => a.subtype === 'gold'],
    [/srebr/, (a) => a.subtype === 'silver'],
    [/gotowk|portfel|bankomat/, (a) => a.type === 'cash'],
  ];
  for (const [re, fn] of rules) {
    if (re.test(c)) {
      const hit = byName.find(fn) || live.find(fn);
      if (hit) return hit;
    }
  }
  return byName.find((a) => a.type !== 'checking') || null;
}

/**
 * Główna funkcja. ctx: { accounts, categories, bills (plan), transactions, month, today, defaultAccountId }
 * Zwraca listę operacji: { kind, label, amount, accountId, toAccountId, categoryId, planId, date, description, warn }
 */
export function parseBatch(text, ctx) {
  const { accounts = [], categories = [], bills = [], transactions = [], month, today, defaultAccountId } = ctx;
  const ops = [];
  const loans = accounts.filter((a) => a.type === 'loan' && !a.archived && !a.deletedAt);
  const planOpen = bills.filter((b) => b.month === month && !b.paid);
  const usedPlan = new Set();
  for (const clause of splitClauses(text)) {
    const c = norm(clause);
    const amount = amountIn(clause);
    // spłata kredytów (według planu = rata z kredytu)
    if (LOAN_RE.test(c) && !INCOME_RE.test(c)) {
      const GENERIC = new Set(['kredyt', 'kredytu', 'kredyty', 'pozyczka', 'pozyczki', 'rata', 'raty', 'hipoteczny', 'gotowkowy', 'bank']);
      const all = /kredytow|wszystk|\braty\b|wedlug planu|wg planu/.test(c);
      const named = all ? [] : loans.filter((l) => norm(l.name).split(/\s+/).some((w) => w.length > 2 && !GENERIC.has(w) && c.includes(w)));
      const targets = named.length ? named : (all || loans.length === 1 ? loans : []);
      if (!targets.length) { ops.push({ kind: 'unknown', label: clause, warn: 'Nie znam tego kredytu — dodaj go w Majątku' }); continue; }
      for (const l of targets) {
        const amt = targets.length === 1 && amount ? amount : l.installment || null;
        ops.push({ kind: 'loan', label: `Spłata: ${l.name}`, amount: amt, accountId: defaultAccountId, toAccountId: l.id, date: today, description: 'Spłata kredytu', warn: amt ? null : 'Brak raty — wpisz kwotę' });
      }
      continue;
    }
    // opłaty według planu
    if (PLAN_RE.test(c) && /(oplat|rachunk|zaplac|wydatk)/.test(c)) {
      for (const b of planOpen.filter((x) => kindOf(x) === 'expense' && !usedPlan.has(x.id))) {
        usedPlan.add(b.id);
        ops.push({ kind: 'plan', label: `Zapłacone: ${b.name}`, amount: b.amount, planId: b.id, date: today });
      }
      continue;
    }
    // przychód (najpierw próbujemy odhaczyć pozycję z planu)
    if (INCOME_RE.test(c)) {
      const planHit = planOpen.find((b) => kindOf(b) === 'income' && !usedPlan.has(b.id)
        && (norm(b.name).split(/\s+/).some((w) => w.length > 3 && c.includes(w.slice(0, 5))) || (/wyplat|wynagrodz|pensj/.test(c) && /wyplat|wynagrodz|pensj/.test(norm(b.name)))));
      if (planHit) {
        usedPlan.add(planHit.id);
        ops.push({ kind: 'plan', label: `Wpłynęło: ${planHit.name}`, amount: amount || planHit.amount, planId: planHit.id, date: today, income: true });
        continue;
      }
      const q = parseQuick(clause, { categories, history: transactions, today });
      const cat = guessCategory(clause, categories, transactions, 'income') || (/wyplat|wynagrodz|pensj/.test(c) ? 'inc-salary' : 'inc-other');
      ops.push({ kind: 'income', label: `Przychód: ${q.description || 'Wpływ'}`, amount, accountId: defaultAccountId, categoryId: cat, date: q.date || today, description: q.description || 'Wpływ', warn: amount ? null : 'Brak kwoty' });
      continue;
    }
    // przelew na własne konto
    const target = TRANSFER_RE.test(c) || /\b(ike|ikze|ppk|oszczedn|lokat)/.test(c) ? matchAccount(clause, accounts) : null;
    if (target) {
      ops.push({ kind: 'transfer', label: `Przelew → ${target.name}`, amount, accountId: defaultAccountId, toAccountId: target.id, date: today, description: 'Przelew', warn: amount ? null : 'Brak kwoty' });
      continue;
    }
    if (TRANSFER_RE.test(c)) { ops.push({ kind: 'unknown', label: clause, warn: 'Nie rozpoznano konta docelowego' }); continue; }
    // reszta: wydatek
    const q = parseQuick(clause, { categories, history: transactions, today });
    if (q.amount) {
      ops.push({ kind: 'expense', label: `Wydatek: ${q.description || 'bez opisu'}`, amount: q.amount, accountId: defaultAccountId, categoryId: q.categoryId || 'exp-other', date: q.date, description: q.description });
    } else {
      ops.push({ kind: 'unknown', label: clause, warn: 'Nie rozpoznano' });
    }
  }
  return ops;
}
