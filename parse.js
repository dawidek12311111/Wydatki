// Rozpoznawanie krótkiego tekstu, np. "Paliwo 250 zł dzisiaj", "Biedronka 87,40 wczoraj", "+6500 wypłata 10.10".
// Przyjmuje zwykły tekst — w przyszłości można tu podać wynik dyktowania głosowego lub OCR paragonu.
import { toMinor } from './money.js';
import { todayISO, addDays, isValidISODate, pad } from './dates.js';

const W = '(^|\\s)'; // "granica słowa" działająca też z polskimi znakami
const END = '(?=\\s|$|[.,!])';

const INCOME_WORDS = ['wypłata', 'wyplata', 'pensja', 'wynagrodzenie', 'premia', 'przychód', 'przychod', 'wpływ', 'wplyw'];

function takeDate(s, today) {
  const rules = [
    [new RegExp(`${W}przedwczoraj${END}`, 'i'), () => addDays(today, -2)],
    [new RegExp(`${W}wczoraj${END}`, 'i'), () => addDays(today, -1)],
    [new RegExp(`${W}(dzisiaj|dziś|dzis)${END}`, 'i'), () => today],
  ];
  for (const [re, fn] of rules) {
    if (re.test(s)) return { date: fn(), rest: s.replace(re, ' ') };
  }
  // DD.MM lub DD.MM.RRRR
  const m = s.match(/(^|\s)(\d{1,2})\.(\d{1,2})(?:\.(\d{4}))?(?=\s|$)/);
  if (m) {
    const year = m[4] ? Number(m[4]) : Number(today.slice(0, 4));
    const iso = `${year}-${pad(Number(m[3]))}-${pad(Number(m[2]))}`;
    if (isValidISODate(iso)) return { date: iso, rest: s.replace(m[0], ' ') };
  }
  return { date: today, rest: s };
}

/** Ujednolica tekst z dyktowania: „87 zł 40 gr” → „87,40 zł”, „złotych” → „zł”. */
export function normalizeSpoken(text) {
  return String(text || '')
    .replace(/(\d+)\s*(?:zł|zl|złotych|złote|złoty|zlotych|pln)\s*(?:i\s*)?(\d{1,2})\s*(?:gr|groszy|grosze|grosz)\b/gi, (_, z, g) => `${z},${g.padStart(2, '0')} zł`)
    .replace(/(\d+)\s*(?:przecinek|kropka)\s*(\d{1,2})/gi, '$1,$2')
    .replace(/\b(złotych|złote|złoty|zlotych)\b/gi, 'zł')
    .replace(/(\d)\s+(zł)(?=\s|$)/gi, '$1 zł')
    .replace(/\s+/g, ' ')
    .trim();
}

function takeAmount(s) {
  // liczba z opcjonalnymi groszami i opcjonalnym "zł"
  const re = /(^|\s)([+-]?)(\d{1,3}(?:[  ]\d{3})+|\d+)(?:[.,](\d{1,2}))?\s*(zł|zl|pln)?(?=\s|$)/i;
  const m = s.match(re);
  if (!m) return { amount: null, sign: '', rest: s };
  const amount = toMinor(m[3].replace(/[  ]/g, '') + (m[4] ? ',' + m[4] : ''));
  return { amount, sign: m[2], rest: s.replace(m[0], ' ') };
}

const norm = (s) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ł/g, 'l');

/**
 * Zgaduje kategorię: 1) ten sam opis w historii, 2) nazwa kategorii, 3) słowa kluczowe.
 * Podkategorie mają pierwszeństwo (np. "paliwo" -> Paliwo, nie Transport).
 */
export function guessCategory(description, categories, history = [], kind = 'expense') {
  if (!description) return null;
  const d = norm(description.trim());
  const usable = categories.filter((c) => c.kind === kind && !c.archived);
  const usableIds = new Set(usable.map((c) => c.id));
  const past = history.find((t) => !t.deletedAt && t.type === kind && t.description && norm(t.description.trim()) === d && usableIds.has(t.categoryId));
  if (past) return past.categoryId;
  const words = ` ${d.replace(/[^\p{L}\p{N} ]/gu, ' ')} `;
  const ordered = [...usable].sort((a, b) => (b.parentId ? 1 : 0) - (a.parentId ? 1 : 0));
  for (const c of ordered) {
    if (words.includes(` ${norm(c.name)} `)) return c.id;
  }
  for (const c of ordered) {
    for (const k of c.keywords || []) {
      if (words.includes(` ${norm(k)} `)) return c.id;
    }
  }
  return null;
}

/** Zwraca { amount (grosze|null), type, date, description, categoryId } */
export function parseQuick(text, { categories = [], history = [], today = todayISO() } = {}) {
  let s = ` ${normalizeSpoken(text)} `;
  const d = takeDate(s, today);
  s = d.rest;
  const a = takeAmount(s);
  s = a.rest;
  let description = s.replace(/\s+/g, ' ').trim();
  description = description.charAt(0).toUpperCase() + description.slice(1);

  const lowered = ` ${norm(description)} `;
  const looksIncome = INCOME_WORDS.some((w) => lowered.includes(` ${norm(w)} `));
  const type = a.sign === '+' || (a.sign !== '-' && looksIncome) ? 'income' : 'expense';

  return {
    amount: a.amount,
    type,
    date: d.date,
    description,
    categoryId: guessCategory(description, categories, history, type),
  };
}
