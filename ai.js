// Asystent AI (Gemini). Obliczenia robi aplikacja — do modelu trafiają tylko zagregowane liczby
// (bez opisów transakcji, bez nazw kont bankowych). Klucz jest tylko w pamięci telefonu.
import { monthSummary, monthlySeries, averages, rollupByParent, categoryChanges, netWorth, balances, isLive } from './calc.js';
import { planSummary } from './plan.js';
import { addMonths } from './dates.js';
import { accountGroup } from './defaults.js';

export const DEFAULT_MODEL = 'gemini-3.8-flash';
const API = 'https://generativelanguage.googleapis.com/v1beta/models/';

const zl = (minor) => Math.round(minor) / 100; // grosze -> złote (liczba)

/** Zagregowany kontekst finansowy wysyłany do modelu. */
export function buildAIContext(data, ym, opts = {}) {
  const { purchases = [], purchaseAnalysis = {} } = opts;
  const txs = data.transactions.filter(isLive);
  const cats = Object.fromEntries(data.categories.map((c) => [c.id, c.name]));
  const catName = (id) => cats[id] || 'Bez kategorii';
  const cur = monthSummary(txs, ym);
  const prev = monthSummary(txs, addMonths(ym, -1));
  const byCat = (s) => Object.fromEntries(Object.entries(rollupByParent(s.expenseByCategory, data.categories))
    .filter(([, v]) => v !== 0).sort((a, b) => b[1] - a[1]).map(([id, v]) => [catName(id), zl(v)]));
  const prevYm = addMonths(ym, -1);
  const avg = (n) => { const a = averages(txs, prevYm, n); return { miesiecy_z_danymi: a.months, przychody: zl(a.income), wydatki: zl(a.expense), nadwyzka: zl(a.net) }; };
  const bal = { ...balances(data.accounts, txs), ...(opts.values || {}) };
  const live = data.accounts.filter((a) => !a.archived && a.currency === 'PLN');
  const sumGroup = (g) => zl(live.filter((a) => accountGroup(a) === g).reduce((s, a) => s + bal[a.id], 0));
  const w = opts.netWorth || netWorth(data.accounts, txs);
  const plan = planSummary(data.bills || [], ym);

  return {
    waluta: 'PLN',
    analizowany_miesiac: ym,
    ten_miesiac: {
      przychody: zl(cur.income), wydatki: zl(cur.expense), bilans: zl(cur.net),
      stopa_oszczednosci_proc: cur.savingsRate == null ? null : Math.round(cur.savingsRate * 100),
      wydatki_wg_kategorii: byCat(cur),
    },
    poprzedni_miesiac: { miesiac: prevYm, przychody: zl(prev.income), wydatki: zl(prev.expense), bilans: zl(prev.net), wydatki_wg_kategorii: byCat(prev) },
    najwieksze_zmiany_kategorii: categoryChanges(cur, prev, data.categories).filter((c) => c.diff !== 0).slice(0, 6)
      .map((c) => ({ kategoria: catName(c.categoryId), teraz: zl(c.now), wczesniej: zl(c.before), roznica: zl(c.diff) })),
    ostatnie_6_miesiecy: monthlySeries(txs, ym, 6).map((s) => ({ miesiac: s.ym, przychody: zl(s.income), wydatki: zl(s.expense), bilans: zl(s.net) })),
    srednie_miesieczne: { '3_mies': avg(3), '6_mies': avg(6), '12_mies': avg(12) },
    majatek: { netto: zl(w.net), aktywa: zl(w.assets), zobowiazania: zl(w.liabilities), oszczednosci_i_inwestycje: sumGroup('savings'), kredyty_do_splaty: -sumGroup('loan'), konta_biezace: sumGroup('current') },
    plan_miesiaca: {
      planowane_wplywy: zl(plan.income.total), juz_wplynelo: zl(plan.income.done),
      planowane_oplaty: zl(plan.expense.total), juz_zaplacone: zl(plan.expense.done), planowana_nadwyzka: zl(plan.plannedNet),
    },
    plany_zakupow: purchases.filter((p) => p.status !== 'bought').map((p) => {
      const a = purchaseAnalysis[p.id] || {};
      return {
        nazwa: p.name, cena: zl(p.price), zgromadzone: zl(a.saved || 0), priorytet: p.priority, termin: p.targetYm || null,
        szacowany_termin_przy_obecnym_tempie: a.affordYm || null,
        ...(a.loan ? { kredyt_rata: zl(a.loan.installment), kredyt_koszt_odsetek: zl(a.loan.interest) } : {}),
        ...(a.payback ? { zwrot_inwestycji_lat: Math.round(a.payback.years * 10) / 10 } : {}),
      };
    }),
  };
}

export const SYSTEM_PROMPT = `Jesteś asystentem finansowym w prywatnej aplikacji budżetu domowego. Odpowiadasz po polsku, krótko i konkretnie (maks. ok. 150–200 słów), w prostym języku.
Zasady:
- Korzystaj WYŁĄCZNIE z danych w sekcji DANE (kwoty w PLN). Nie wymyślaj liczb. Jeśli czegoś brakuje, powiedz wprost, czego brakuje.
- Liczby z DANYCH są faktami. Twoje wnioski i rady oznacz jako interpretację (np. „Moim zdaniem…”).
- Przy prognozach i symulacjach podaj przyjęte założenia; nie gwarantuj zysków ani przyszłych wyników.
- Transfery i wpłaty na oszczędności nie są wydatkami — nie traktuj ich jak konsumpcji.
- Nie wykonujesz żadnych operacji w aplikacji; możesz jedynie coś zasugerować.
- Formatowanie: krótkie akapity, ewentualnie lista z „- ”, pogrubienia **tak**. Bez tabel.`;

export function buildPrompt(question, context) {
  return `DANE:\n${JSON.stringify(context)}\n\nPYTANIE:\n${question}`;
}

/** Bezpieczne wyświetlanie odpowiedzi: najpierw escapowanie HTML, potem prosty markdown. */
export function renderAIText(text) {
  const esc = (s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const inline = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
  const lines = String(text || '').replace(/\r/g, '').split('\n');
  let html = '';
  let inList = false;
  for (const raw of lines) {
    const line = raw.trim();
    const li = line.match(/^[-*•]\s+(.*)$/) || line.match(/^\d+[.)]\s+(.*)$/);
    if (li) {
      if (!inList) { html += '<ul>'; inList = true; }
      html += `<li>${inline(li[1])}</li>`;
      continue;
    }
    if (inList) { html += '</ul>'; inList = false; }
    if (!line) continue;
    const h = line.match(/^#{1,4}\s+(.*)$/);
    html += h ? `<p><b>${inline(h[1])}</b></p>` : `<p>${inline(line)}</p>`;
  }
  if (inList) html += '</ul>';
  return html;
}

/** Zapytanie do Gemini. Rzuca błąd z polskim opisem. */
export async function askGemini({ key, model = DEFAULT_MODEL, question, context, history = [] }) {
  if (!key) throw new Error('Brak klucza Gemini — wpisz go w Ustawieniach.');
  if (!navigator.onLine) throw new Error('Brak internetu. Asystent AI wymaga połączenia.');
  const contents = [
    ...history.slice(-6).map((m) => ({ role: m.role === 'ai' ? 'model' : 'user', parts: [{ text: m.text }] })),
    { role: 'user', parts: [{ text: buildPrompt(question, context) }] },
  ];
  let res;
  try {
    res = await fetch(`${API}${encodeURIComponent(model)}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents,
        generationConfig: { temperature: 0.3, maxOutputTokens: 1200 },
      }),
    });
  } catch {
    throw new Error('Nie udało się połączyć z Gemini. Sprawdź internet.');
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(describeError(res.status, body));
  const text = body?.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('').trim();
  if (!text) {
    const reason = body?.candidates?.[0]?.finishReason || body?.promptFeedback?.blockReason;
    throw new Error(`Gemini nie zwrócił odpowiedzi${reason ? ` (${reason})` : ''}. Spróbuj zadać pytanie inaczej.`);
  }
  return text;
}

/** Sprawdza klucz i model (bez wysyłania danych finansowych). */
export async function checkGeminiKey(key, model = DEFAULT_MODEL) {
  if (!key) throw new Error('Wpisz klucz.');
  let res;
  try {
    res = await fetch(`${API}${encodeURIComponent(model)}`, { headers: { 'x-goog-api-key': key } });
  } catch {
    throw new Error('Brak połączenia z Google.');
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(describeError(res.status, body));
  return body.displayName || model;
}

export function describeError(status, body) {
  const msg = body?.error?.message || '';
  if (status === 400 && /api key/i.test(msg)) return 'Nieprawidłowy klucz API.';
  if (status === 400) return `Błędne zapytanie: ${msg || 'sprawdź nazwę modelu'}`;
  if (status === 401 || status === 403) return 'Klucz nie ma dostępu (sprawdź klucz i jego ograniczenia w Google).';
  if (status === 404) return 'Nie ma takiego modelu — sprawdź nazwę modelu w Ustawieniach.';
  if (status === 429) return 'Przekroczony limit zapytań. Spróbuj za chwilę.';
  if (status >= 500) return 'Serwer Gemini ma chwilowy problem. Spróbuj ponownie.';
  return `Błąd ${status}${msg ? ': ' + msg : ''}`;
}
