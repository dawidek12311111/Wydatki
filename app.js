// Smart Finance — interfejs aplikacji (ekrany, formularze, nawigacja).
import * as db from './db.js';
import {
  balances, netWorth, monthSummary, rollupByParent, budgetStatus, averages,
  monthlySeries, categoryChanges, isLive,
} from './calc.js';
import { toMinor, formatMoney, minorToInput } from './money.js';
import { todayISO, monthKey, addMonths, monthNamePL, monthShortPL, dayLabelPL, formatDatePL } from './dates.js';
import { parseQuick, guessCategory } from './parse.js';
import { validateTransaction, validateBackup } from './validate.js';
import { transactionsToCSV } from './csv.js';
import { ACCOUNT_TYPES, CURRENCIES } from './defaults.js';

export const APP_VERSION = '0.2.1 (MVP)';

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (m, cur = 'PLN', o) => `<span class="num">${esc(formatMoney(m, cur, o))}</span>`;

const state = {
  data: { accounts: [], categories: [], transactions: [], budgets: [] },
  view: 'dashboard',
  month: monthKey(todayISO()),
  txFilter: 'all',
  txSearch: '',
  lastBackup: null,
  persisted: false,
};

const VIEWS = {
  dashboard: { title: 'Start', month: true },
  transactions: { title: 'Transakcje', month: true },
  budget: { title: 'Budżet', month: true },
  wealth: { title: 'Majątek', month: false },
  analytics: { title: 'Analityka', month: true },
  settings: { title: 'Ustawienia', month: false },
};

// ---------- pomocnicze ----------
const catById = () => Object.fromEntries(state.data.categories.map((c) => [c.id, c]));
const accById = () => Object.fromEntries(state.data.accounts.map((a) => [a.id, a]));
const liveTx = () => state.data.transactions.filter(isLive);
const activeAccounts = () => state.data.accounts.filter((a) => !a.archived);

function catLabel(id, cats = catById()) {
  const c = cats[id];
  if (!c) return 'Bez kategorii';
  return c.parentId && cats[c.parentId] ? `${cats[c.parentId].name} › ${c.name}` : c.name;
}
function catIcon(id, cats = catById()) {
  return cats[id]?.icon || '•';
}
function txIcon(t, cats) {
  if (t.type === 'transfer') return '⇄';
  return catIcon(t.categoryId, cats);
}
function signedAmount(t) {
  if (t.type === 'income' || (t.type === 'expense' && t.refund)) return t.amount;
  if (t.type === 'expense') return -t.amount;
  return t.amount;
}
function amountClass(t) {
  if (t.type === 'transfer') return 'tr';
  return signedAmount(t) >= 0 ? 'pos' : 'neg';
}
const pct = (x) => (x == null ? '—' : `${Math.round(x * 100)}%`);

function txRow(t, cats = catById(), accs = accById()) {
  const title = t.description || (t.type === 'transfer' ? 'Transfer' : catLabel(t.categoryId, cats));
  const sub = t.type === 'transfer'
    ? `${accs[t.accountId]?.name || '?'} → ${accs[t.toAccountId]?.name || '?'}`
    : `${catLabel(t.categoryId, cats)} · ${accs[t.accountId]?.name || '?'}`;
  const amt = t.type === 'transfer' ? formatMoney(t.amount, t.currency) : formatMoney(signedAmount(t), t.currency, { sign: true });
  const badges = `${t.refund ? '<span class="badge">zwrot</span>' : ''}${t.recurring ? '<span class="badge">cykl.</span>' : ''}`;
  return `<button class="item" data-action="edit-tx" data-id="${esc(t.id)}">
    <span class="ico" aria-hidden="true">${esc(txIcon(t, cats))}</span>
    <span class="mid"><span class="t1">${esc(title)}${badges}</span><span class="t2">${esc(sub)}</span></span>
    <span class="amt num ${amountClass(t)}">${esc(amt)}</span>
  </button>`;
}

function toast(msg, action) {
  const el = $('#toast');
  el.innerHTML = `<span>${esc(msg)}</span>${action ? `<button>${esc(action.label)}</button>` : ''}`;
  el.hidden = false;
  if (action) el.querySelector('button').onclick = () => { el.hidden = true; action.run(); };
  clearTimeout(toast.t);
  toast.t = setTimeout(() => { el.hidden = true; }, action ? 6000 : 2800);
}

function download(filename, content, type) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

async function reload() {
  state.data = await db.loadAll();
  render();
}

// ---------- nawigacja ----------
function route() {
  const v = location.hash.slice(1);
  state.view = VIEWS[v] ? v : 'dashboard';
  render();
  window.scrollTo(0, 0);
}

function render() {
  const v = VIEWS[state.view];
  $('#title').textContent = v.title;
  $('#month-nav').hidden = !v.month;
  $('#month-label').textContent = monthNamePL(state.month);
  document.querySelectorAll('.tabbar a').forEach((a) => {
    if (a.dataset.tab === state.view) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  });
  const html = {
    dashboard: viewDashboard, transactions: viewTransactions, budget: viewBudget,
    wealth: viewWealth, analytics: viewAnalytics, settings: viewSettings,
  }[state.view]();
  $('#view').innerHTML = html;
  if (state.view === 'transactions') {
    const s = $('#tx-search');
    if (s) s.oninput = () => { state.txSearch = s.value; renderTxList(); };
  }
}

// ---------- Dashboard ----------
function viewDashboard() {
  const txs = liveTx();
  const cats = catById();
  const s = monthSummary(txs, state.month);
  const w = netWorth(state.data.accounts, txs);
  const parts = [];

  if (!state.data.transactions.length) {
    parts.push(`<div class="note">👋 Witaj! Zacznij od <b>Majątek</b> → wpisz aktualne salda swoich kont, a potem dodawaj wydatki przyciskiem <b>+</b>.<br>Dane zapisują się tylko w tym telefonie.</div>`);
  }

  parts.push(`<section class="card hero">
    <h2>Bilans: ${esc(monthNamePL(state.month).toLowerCase())}</h2>
    <div class="big num">${esc(formatMoney(s.net, 'PLN', { sign: true }))}</div>
    <div class="split">
      <div><small>Przychody</small><b class="num">${esc(formatMoney(s.income))}</b></div>
      <div><small>Wydatki</small><b class="num">${esc(formatMoney(s.expense))}</b></div>
    </div>
    <div class="foot">Odłożone z dochodu: <b>${pct(s.savingsRate)}</b>${s.transfersOut ? ` · transfery: ${esc(formatMoney(s.transfersOut))} (nie liczone jako wydatki)` : ''}</div>
  </section>`);

  parts.push(`<section class="card">
    <h2>Majątek netto <a href="#wealth">Konta ›</a></h2>
    <div class="stat-row">
      <div class="stat"><small>Netto</small><b class="${w.net < 0 ? 'neg' : ''}">${money(w.net)}</b></div>
      <div class="stat"><small>Aktywa</small><b>${money(w.assets)}</b></div>
      <div class="stat"><small>Długi</small><b>${money(w.liabilities)}</b></div>
    </div>
  </section>`);

  const status = budgetStatus(state.data.budgets, s, state.data.categories).filter((b) => b.ratio >= 0.8).sort((a, b) => b.ratio - a.ratio);
  if (status.length) {
    parts.push(`<section class="card"><h2>Uwaga na budżet <a href="#budget">Budżet ›</a></h2><ul class="bars">${status.map((b) => budgetBar(b, cats)).join('')}</ul></section>`);
  }

  const byParent = Object.entries(rollupByParent(s.expenseByCategory, state.data.categories))
    .filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
  if (byParent.length) {
    const max = byParent[0][1];
    const top = byParent.slice(0, 6);
    parts.push(`<section class="card"><h2>Na co poszło <a href="#analytics">Więcej ›</a></h2><ul class="bars">${top.map(([id, v]) => `
      <li><div class="row"><span>${esc(catIcon(id, cats))} ${esc(catLabel(id, cats))}</span><span class="num">${esc(formatMoney(v))}</span></div>
      <div class="track"><div class="fill" style="width:${Math.max(2, (v / max) * 100).toFixed(1)}%"></div></div></li>`).join('')}</ul></section>`);
  }

  const recent = txs.filter((t) => t.date.startsWith(state.month)).sort(byDateDesc).slice(0, 5);
  parts.push(`<section class="card"><h2>Ostatnie <a href="#transactions">Wszystkie ›</a></h2>${recent.length
    ? `<div class="list">${recent.map((t) => txRow(t, cats)).join('')}</div>`
    : '<p class="muted small">Brak transakcji w tym miesiącu.</p>'}</section>`);

  const days = state.lastBackup ? (Date.now() - new Date(state.lastBackup).getTime()) / 864e5 : Infinity;
  if (state.data.transactions.length >= 5 && days > 30) {
    parts.push(`<div class="note warn">💾 ${state.lastBackup ? `Ostatnia kopia zapasowa: ${Math.floor(days)} dni temu.` : 'Nie masz jeszcze kopii zapasowej.'} Dane są tylko w telefonie. <button class="link" data-action="backup">Zrób kopię teraz</button></div>`);
  }
  return parts.join('');
}

const byDateDesc = (a, b) => b.date.localeCompare(a.date) || (b.createdAt || '').localeCompare(a.createdAt || '');

// ---------- Transakcje ----------
function viewTransactions() {
  const f = state.txFilter;
  const chip = (id, label) => `<button class="chip" data-action="tx-filter" data-f="${id}" aria-pressed="${f === id}">${label}</button>`;
  return `<input id="tx-search" class="search" type="search" placeholder="Szukaj opisu, kategorii, tagu…" value="${esc(state.txSearch)}" aria-label="Szukaj">
    <div class="chips">${chip('all', 'Wszystkie')}${chip('expense', 'Wydatki')}${chip('income', 'Przychody')}${chip('transfer', 'Transfery')}</div>
    <div id="tx-list">${txListHtml()}</div>`;
}

function txListHtml() {
  const cats = catById();
  const accs = accById();
  const q = state.txSearch.trim().toLowerCase();
  const txs = liveTx()
    .filter((t) => t.date.startsWith(state.month))
    .filter((t) => state.txFilter === 'all' || t.type === state.txFilter)
    .filter((t) => !q || [t.description, catLabel(t.categoryId, cats), (t.tags || []).join(' '), accs[t.accountId]?.name]
      .join(' ').toLowerCase().includes(q))
    .sort(byDateDesc);
  if (!txs.length) {
    return `<div class="empty"><span class="em">🧾</span>${q ? 'Nic nie znaleziono.' : 'Brak transakcji w tym miesiącu.'}<br><br><button class="btn primary" data-action="add">Dodaj transakcję</button></div>`;
  }
  const groups = new Map();
  for (const t of txs) {
    if (!groups.has(t.date)) groups.set(t.date, []);
    groups.get(t.date).push(t);
  }
  let html = '';
  for (const [date, list] of groups) {
    const dayNet = list.filter((t) => t.type !== 'transfer' && t.currency === 'PLN').reduce((s, t) => s + signedAmount(t), 0);
    html += `<div class="day"><span>${esc(dayLabelPL(date))}</span><span class="num">${dayNet ? esc(formatMoney(dayNet, 'PLN', { sign: true })) : ''}</span></div>
      <div class="list">${list.map((t) => txRow(t, cats, accs)).join('')}</div>`;
  }
  return html;
}
function renderTxList() {
  const el = $('#tx-list');
  if (el) el.innerHTML = txListHtml();
}

// ---------- Budżet ----------
function budgetBar(b, cats) {
  const cls = b.ratio > 1 ? 'over' : b.ratio >= 0.8 ? 'near' : '';
  return `<li><button class="rowbtn" data-action="edit-budget" data-id="${esc(b.categoryId)}">
    <div class="row"><span>${esc(catIcon(b.categoryId, cats))} ${esc(catLabel(b.categoryId, cats))}</span>
    <span class="num ${b.ratio > 1 ? 'neg' : ''}">${esc(formatMoney(b.spent))} / ${esc(formatMoney(b.limit))}</span></div>
    <div class="track"><div class="fill ${cls}" style="width:${Math.min(100, b.ratio * 100).toFixed(1)}%"></div></div>
    <div class="small muted">${b.left >= 0 ? `Zostało ${esc(formatMoney(b.left))}` : `Przekroczono o ${esc(formatMoney(-b.left))}`}</div>
  </button></li>`;
}

function viewBudget() {
  const cats = catById();
  const s = monthSummary(liveTx(), state.month);
  const status = budgetStatus(state.data.budgets, s, state.data.categories);
  const withLimit = new Set(status.map((b) => b.categoryId));
  const byParent = rollupByParent(s.expenseByCategory, state.data.categories);
  const totalLimit = status.reduce((a, b) => a + b.limit, 0);
  const spentInBudgets = status.reduce((a, b) => a + b.spent, 0);
  const noLimit = state.data.categories
    .filter((c) => c.kind === 'expense' && !c.parentId && !c.archived && !withLimit.has(c.id))
    .sort((a, b) => (byParent[b.id] || 0) - (byParent[a.id] || 0));

  return `<section class="card">
      <h2>Podsumowanie miesiąca</h2>
      <div class="stat-row">
        <div class="stat"><small>Wydatki</small><b>${money(s.expense)}</b></div>
        <div class="stat"><small>Suma limitów</small><b>${money(totalLimit)}</b></div>
        <div class="stat"><small>Zostało</small><b class="${totalLimit - spentInBudgets < 0 ? 'neg' : ''}">${money(totalLimit - spentInBudgets)}</b></div>
      </div>
    </section>
    ${status.length ? `<section class="card"><h2>Limity kategorii</h2><ul class="bars">${status.sort((a, b) => b.ratio - a.ratio).map((b) => budgetBar(b, cats)).join('')}</ul></section>` : ''}
    <section class="card"><h2>Bez limitu</h2>
      <ul class="menu">${noLimit.map((c) => `<li><button data-action="edit-budget" data-id="${esc(c.id)}">
        <span>${esc(c.icon || '')} ${esc(c.name)}<span class="sub">wydano ${esc(formatMoney(byParent[c.id] || 0))}</span></span>
        <span class="link">Ustaw limit</span></button></li>`).join('')}</ul>
    </section>
    <p class="note">Limit „co miesiąc” obowiązuje w każdym miesiącu; limit „tylko ten miesiąc” go nadpisuje. Podkategorie (np. Paliwo) liczą się do kategorii nadrzędnej (Transport).</p>`;
}

function openBudgetSheet(categoryId) {
  const cat = catById()[categoryId];
  const monthB = state.data.budgets.find((b) => b.id === `${state.month}:${categoryId}`);
  const defB = state.data.budgets.find((b) => b.id === `default:${categoryId}`);
  const current = monthB || defB;
  openSheet(`Limit: ${cat?.name || ''}`, `
    <label class="field"><span>Kwota limitu (zł)</span>
      <input id="b-amount" class="amount-input" inputmode="decimal" placeholder="0" value="${current ? esc(minorToInput(current.limit)) : ''}"></label>
    <div class="field"><span>Obowiązuje</span>
      <div class="seg" id="b-scope">
        <button type="button" data-scope="default" aria-pressed="${!monthB}">Co miesiąc</button>
        <button type="button" data-scope="month" aria-pressed="${!!monthB}">Tylko ${esc(monthNamePL(state.month).toLowerCase())}</button>
      </div></div>
    <div class="err" id="b-err"></div>
    <div class="actions two">
      <button class="btn danger" id="b-del" ${current ? '' : 'disabled'}>Usuń limit</button>
      <button class="btn primary" id="b-save">Zapisz</button>
    </div>`);
  const sheet = $('#sheet');
  sheet.querySelectorAll('#b-scope button').forEach((b) => {
    b.onclick = () => sheet.querySelectorAll('#b-scope button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
  });
  const scopeId = () => (sheet.querySelector('#b-scope [aria-pressed="true"]').dataset.scope === 'month' ? `${state.month}:${categoryId}` : `default:${categoryId}`);
  $('#b-save').onclick = async () => {
    const limit = toMinor($('#b-amount').value);
    if (!Number.isInteger(limit) || limit <= 0) { $('#b-err').textContent = 'Podaj kwotę większą od zera.'; return; }
    await db.put('budgets', { id: scopeId(), limit });
    closeSheet();
    await reload();
    toast('Zapisano limit');
  };
  $('#b-del').onclick = async () => {
    await db.remove('budgets', scopeId());
    closeSheet();
    await reload();
    toast('Usunięto limit');
  };
}

// ---------- Majątek ----------
function viewWealth() {
  const txs = liveTx();
  const bal = balances(state.data.accounts, txs);
  const w = netWorth(state.data.accounts, txs);
  const groups = {};
  for (const a of state.data.accounts) {
    if (a.archived) continue;
    (groups[a.type] ||= []).push(a);
  }
  const otherCur = state.data.accounts.filter((a) => !a.archived && a.currency !== 'PLN');
  const archived = state.data.accounts.filter((a) => a.archived);
  return `<section class="card hero">
      <h2>Majątek netto (PLN)</h2>
      <div class="big num">${esc(formatMoney(w.net))}</div>
      <div class="split">
        <div><small>Aktywa</small><b class="num">${esc(formatMoney(w.assets))}</b></div>
        <div><small>Zobowiązania</small><b class="num">${esc(formatMoney(w.liabilities))}</b></div>
      </div>
      ${otherCur.length ? '<div class="foot">Konta w innych walutach nie są wliczane do sumy (przeliczanie kursów — później).</div>' : ''}
    </section>
    ${Object.keys(ACCOUNT_TYPES).filter((t) => groups[t]).map((type) => `
      <div class="day"><span>${esc(ACCOUNT_TYPES[type])}</span></div>
      <div class="list">${groups[type].map((a) => `<button class="item" data-action="edit-account" data-id="${esc(a.id)}">
        <span class="ico">${accountIcon(a.type)}</span>
        <span class="mid"><span class="t1">${esc(a.name)}</span><span class="t2">${esc(a.currency)}</span></span>
        <span class="amt num ${bal[a.id] < 0 ? 'neg' : ''}">${esc(formatMoney(bal[a.id], a.currency))}</span></button>`).join('')}</div>`).join('')}
    <div class="actions"><button class="btn block" data-action="add-account">+ Dodaj konto</button></div>
    ${archived.length ? `<p class="small muted" style="margin-top:16px">Zarchiwizowane: ${archived.map((a) => `<button class="link" data-action="edit-account" data-id="${esc(a.id)}">${esc(a.name)}</button>`).join(', ')}</p>` : ''}
    <p class="note">Salda liczone są z salda początkowego i transakcji. Wpłata na oszczędności czy IKE to <b>transfer</b> — nie zmienia majątku i nie jest wydatkiem. Szczegółowe inwestycje (jednostki, wyceny, wynik) dojdą w Etapie 3.</p>`;
}

function accountIcon(type) {
  return { checking: '🏦', savings: '🐷', cash: '💵', card: '💳', investment: '📈', loan: '📉', other: '📁' }[type] || '📁';
}

function openAccountSheet(id) {
  const a = id ? accById()[id] : null;
  const used = id && state.data.transactions.some((t) => t.accountId === id || t.toAccountId === id);
  openSheet(a ? 'Edytuj konto' : 'Nowe konto', `
    <label class="field"><span>Nazwa</span><input id="a-name" maxlength="60" value="${esc(a?.name || '')}" placeholder="np. mBank, IKE, Kredyt"></label>
    <label class="field"><span>Rodzaj</span><select id="a-type">${Object.entries(ACCOUNT_TYPES).map(([k, v]) => `<option value="${k}" ${a?.type === k ? 'selected' : ''}>${esc(v)}</option>`).join('')}</select></label>
    <div class="grid2">
      <label class="field"><span>Saldo początkowe</span><input id="a-open" inputmode="decimal" value="${a ? esc(minorToInput(a.openingBalance)) : ''}" placeholder="0,00"></label>
      <label class="field"><span>Waluta</span><select id="a-cur" ${used ? 'disabled' : ''}>${CURRENCIES.map((c) => `<option ${(a?.currency || 'PLN') === c ? 'selected' : ''}>${c}</option>`).join('')}</select></label>
    </div>
    <p class="small muted">Saldo początkowe = ile było na koncie, zanim zacząłeś zapisywać transakcje. Dla kredytu wpisz kwotę ze znakiem minus, np. -150000.</p>
    ${a ? `<label class="check"><input type="checkbox" id="a-arch" ${a.archived ? 'checked' : ''}> Zarchiwizuj (ukryj konto, historia zostaje)</label>` : ''}
    <div class="err" id="a-err"></div>
    <div class="actions"><button class="btn primary block" id="a-save">Zapisz</button></div>`);
  $('#a-save').onclick = async () => {
    const name = $('#a-name').value.trim();
    const opening = $('#a-open').value.trim() ? toMinor($('#a-open').value) : 0;
    if (!name) { $('#a-err').textContent = 'Podaj nazwę konta.'; return; }
    if (!Number.isInteger(opening)) { $('#a-err').textContent = 'Nieprawidłowe saldo początkowe.'; return; }
    const item = {
      ...(a || { id: db.newId('acc'), createdAt: new Date().toISOString() }),
      name, type: $('#a-type').value, currency: $('#a-cur').value, openingBalance: opening,
      archived: a ? $('#a-arch').checked : false,
    };
    await db.put('accounts', item);
    closeSheet();
    await reload();
    toast('Zapisano konto');
  };
}

// ---------- Analityka ----------
function viewAnalytics() {
  const txs = liveTx();
  const cats = catById();
  const series = monthlySeries(txs, state.month, 6);
  const cur = monthSummary(txs, state.month);
  const prev = monthSummary(txs, addMonths(state.month, -1));
  const lastYear = monthSummary(txs, addMonths(state.month, -12));
  const prevYm = addMonths(state.month, -1);
  const avg = [3, 6, 12].map((n) => ({ n, ...averages(txs, prevYm, n) }));
  const changes = categoryChanges(cur, prev, state.data.categories).filter((c) => c.diff !== 0);
  const up = changes.filter((c) => c.diff > 0).slice(0, 4);
  const down = changes.filter((c) => c.diff < 0).sort((a, b) => a.diff - b.diff).slice(0, 3);
  const diffLine = (c) => `<li><div class="row"><span>${esc(catIcon(c.categoryId, cats))} ${esc(catLabel(c.categoryId, cats))}</span>
    <span class="num ${c.diff > 0 ? 'neg' : 'pos'}">${esc(formatMoney(c.diff, 'PLN', { sign: true }))}</span></div>
    <div class="small muted">${esc(formatMoney(c.before))} → ${esc(formatMoney(c.now))}</div></li>`;

  return `<section class="card chart"><h2>Ostatnie 6 miesięcy</h2>${barChart(series)}
      <div class="legend"><span><i style="background:var(--income)"></i>Przychody</span><span><i style="background:var(--expense)"></i>Wydatki</span></div></section>
    <section class="card"><h2>Średnio miesięcznie <span class="small muted">(pełne miesiące przed ${esc(monthShortPL(state.month))})</span></h2>
      ${avg[0].months ? `<ul class="menu">${avg.map((a) => `<li><button disabled style="opacity:1;cursor:default">
        <span>${a.n} mies.${a.months < a.n ? `<span class="sub">dane z ${a.months} mies.</span>` : ''}</span>
        <span style="text-align:right"><span class="num pos">${esc(formatMoney(a.income))}</span><br><span class="num neg">${esc(formatMoney(a.expense))}</span></span></button></li>`).join('')}</ul>`
        : '<p class="muted small">Za mało danych — średnie pojawią się po pierwszym pełnym miesiącu.</p>'}
    </section>
    <section class="card"><h2>Zmiana vs ${esc(monthNamePL(prevYm).toLowerCase())}</h2>
      <div class="stat-row" style="grid-template-columns:1fr 1fr">
        <div class="stat"><small>Wydatki</small><b class="${cur.expense > prev.expense ? 'neg' : 'pos'}">${esc(formatMoney(cur.expense - prev.expense, 'PLN', { sign: true }))}</b></div>
        <div class="stat"><small>Przychody</small><b class="${cur.income >= prev.income ? 'pos' : 'neg'}">${esc(formatMoney(cur.income - prev.income, 'PLN', { sign: true }))}</b></div>
      </div>
      ${up.length ? `<h2 style="margin-top:16px">Najbardziej wzrosły</h2><ul class="bars">${up.map(diffLine).join('')}</ul>` : ''}
      ${down.length ? `<h2 style="margin-top:16px">Spadły</h2><ul class="bars">${down.map(diffLine).join('')}</ul>` : ''}
      ${!changes.length ? '<p class="muted small">Brak danych do porównania.</p>' : ''}
    </section>
    ${lastYear.expense || lastYear.income ? `<section class="card"><h2>Rok do roku (${esc(monthNamePL(addMonths(state.month, -12)).toLowerCase())})</h2>
      <div class="stat-row" style="grid-template-columns:1fr 1fr">
        <div class="stat"><small>Wydatki wtedy</small><b>${money(lastYear.expense)}</b></div>
        <div class="stat"><small>Różnica teraz</small><b class="${cur.expense > lastYear.expense ? 'neg' : 'pos'}">${money(cur.expense - lastYear.expense, 'PLN', { sign: true })}</b></div>
      </div></section>` : ''}
    <p class="note">Wszystkie liczby wyliczone z Twoich zapisanych transakcji. Transfery i wpłaty na oszczędności nie są liczone jako wydatki.</p>`;
}

function barChart(series) {
  const W = 340; const H = 190; const pad = 22; const top = 20;
  const max = Math.max(1, ...series.flatMap((s) => [s.income, s.expense]));
  const slot = (W - 10) / series.length;
  const bw = Math.min(16, slot / 3);
  const y = (v) => top + (H - pad - top) * (1 - v / max);
  const bars = series.map((s, i) => {
    const x = 5 + slot * i + slot / 2;
    return `<rect x="${x - bw - 1}" y="${y(s.income)}" width="${bw}" height="${H - pad - y(s.income)}" rx="3" fill="var(--income)"><title>${esc(monthNamePL(s.ym))}: przychody ${esc(formatMoney(s.income))}</title></rect>
      <rect x="${x + 1}" y="${y(s.expense)}" width="${bw}" height="${H - pad - y(s.expense)}" rx="3" fill="var(--expense)"><title>${esc(monthNamePL(s.ym))}: wydatki ${esc(formatMoney(s.expense))}</title></rect>
      <text x="${x}" y="${H - 6}" text-anchor="middle" ${s.ym === state.month ? 'style="font-weight:700;fill:var(--text)"' : ''}>${esc(monthShortPL(s.ym))}</text>`;
  }).join('');
  const maxLabel = formatMoney(max).replace(/,00/, '');
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Przychody i wydatki w ostatnich 6 miesiącach">
    <line x1="0" x2="${W}" y1="${H - pad}" y2="${H - pad}" stroke="var(--line)"/>
    <line x1="0" x2="${W}" y1="${top}" y2="${top}" stroke="var(--line)" stroke-dasharray="3 4"/>
    <text x="2" y="${top - 2}" text-anchor="start">${esc(maxLabel)}</text>${bars}</svg>`;
}

// ---------- Ustawienia ----------
function viewSettings() {
  let theme = 'system';
  try { theme = localStorage.getItem('sf-theme') || 'system'; } catch { /* brak dostępu */ }
  const deleted = state.data.transactions.filter((t) => t.deletedAt).length;
  const t = (id, label) => `<button type="button" data-action="theme" data-theme="${id}" aria-pressed="${theme === id}">${label}</button>`;
  return `<section class="card"><h2>Wygląd</h2><div class="seg">${t('system', 'Systemowy')}${t('light', 'Jasny')}${t('dark', 'Ciemny')}</div></section>
    <section class="card"><h2>Kategorie</h2><ul class="menu">
      <li><button data-action="categories" data-kind="expense"><span>Kategorie wydatków<span class="sub">${state.data.categories.filter((c) => c.kind === 'expense' && !c.archived).length} aktywnych</span></span>›</button></li>
      <li><button data-action="categories" data-kind="income"><span>Kategorie przychodów<span class="sub">${state.data.categories.filter((c) => c.kind === 'income' && !c.archived).length} aktywnych</span></span>›</button></li>
    </ul></section>
    <section class="card"><h2>Dane i kopie</h2><ul class="menu">
      <li><button data-action="backup"><span>Zrób kopię zapasową<span class="sub">${state.lastBackup ? 'Ostatnia: ' + esc(formatDatePL(state.lastBackup.slice(0, 10))) : 'Jeszcze nie zrobiona'} · plik .json</span></span>💾</button></li>
      <li><button data-action="restore"><span>Przywróć z kopii<span class="sub">Zastępuje obecne dane (najpierw zapiszemy ich kopię)</span></span>📂</button></li>
      <li><button data-action="export-csv"><span>Eksport do CSV<span class="sub">Do Excela / Arkuszy Google</span></span>📄</button></li>
      <li><button data-action="trash"><span>Kosz<span class="sub">${deleted} usuniętych transakcji</span></span>🗑️</button></li>
      <li><button data-action="wipe" class="danger"><span class="neg">Usuń wszystkie dane<span class="sub">Nieodwracalne</span></span>⚠️</button></li>
    </ul></section>
    <section class="card"><h2>Informacje</h2>
      <p class="small">Wersja ${esc(APP_VERSION)}<br>
      Dane: tylko w tym telefonie (pamięć przeglądarki) — ${state.persisted ? '<span class="pos">chronione przed automatycznym czyszczeniem</span>' : '<span class="neg">system może je wyczyścić przy braku miejsca — rób kopie</span>'}<br>
      Transakcji: ${state.data.transactions.length - deleted} · Kont: ${state.data.accounts.length}</p>
    </section>`;
}

function openCategoriesSheet(kind) {
  const cats = state.data.categories.filter((c) => c.kind === kind);
  const tops = cats.filter((c) => !c.parentId).sort((a, b) => a.name.localeCompare(b.name, 'pl'));
  const row = (c, child) => `<li><button data-action="edit-cat" data-id="${esc(c.id)}"><span>${child ? '&nbsp;&nbsp;↳ ' : ''}${esc(c.icon || '')} ${esc(c.name)}${c.archived ? ' <span class="badge">ukryta</span>' : ''}</span>›</button></li>`;
  openSheet(kind === 'expense' ? 'Kategorie wydatków' : 'Kategorie przychodów', `
    <ul class="menu">${tops.map((p) => row(p) + cats.filter((c) => c.parentId === p.id).map((c) => row(c, true)).join('')).join('')}</ul>
    <div class="actions"><button class="btn primary block" data-action="new-cat" data-kind="${kind}">+ Nowa kategoria</button></div>`);
}

function openCategorySheet(id, kind) {
  const c = id ? catById()[id] : null;
  kind = c?.kind || kind;
  const parents = state.data.categories.filter((x) => x.kind === kind && !x.parentId && x.id !== id && !x.archived);
  const hasChildren = c && state.data.categories.some((x) => x.parentId === c.id);
  openSheet(c ? 'Edytuj kategorię' : 'Nowa kategoria', `
    <div class="grid2" style="grid-template-columns:80px 1fr">
      <label class="field"><span>Ikona</span><input id="c-icon" maxlength="4" value="${esc(c?.icon || '')}" placeholder="🙂" style="text-align:center;font-size:22px"></label>
      <label class="field"><span>Nazwa</span><input id="c-name" maxlength="40" value="${esc(c?.name || '')}"></label>
    </div>
    <label class="field"><span>Kategoria nadrzędna (opcjonalnie)</span><select id="c-parent" ${hasChildren ? 'disabled' : ''}>
      <option value="">— brak (kategoria główna) —</option>
      ${parents.map((p) => `<option value="${esc(p.id)}" ${c?.parentId === p.id ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select></label>
    <label class="field"><span>Słowa kluczowe (po przecinku) — do rozpoznawania z tekstu</span>
      <input id="c-kw" value="${esc((c?.keywords || []).join(', '))}" placeholder="np. orlen, bp, tankowanie"></label>
    ${c ? `<label class="check"><input type="checkbox" id="c-arch" ${c.archived ? 'checked' : ''}> Ukryj kategorię (historia zostaje)</label>` : ''}
    <div class="err" id="c-err"></div>
    <div class="actions"><button class="btn primary block" id="c-save">Zapisz</button></div>`);
  $('#c-save').onclick = async () => {
    const name = $('#c-name').value.trim();
    if (!name) { $('#c-err').textContent = 'Podaj nazwę.'; return; }
    const item = {
      ...(c || { id: db.newId('cat'), kind }),
      name, icon: $('#c-icon').value.trim(),
      parentId: $('#c-parent').value || null,
      keywords: $('#c-kw').value.split(',').map((s) => s.trim()).filter(Boolean),
      archived: c ? $('#c-arch').checked : false,
    };
    await db.put('categories', item);
    await reload();
    openCategoriesSheet(kind);
    toast('Zapisano kategorię');
  };
}

function openTrashSheet() {
  const cats = catById();
  const del = state.data.transactions.filter((t) => t.deletedAt).sort((a, b) => b.deletedAt.localeCompare(a.deletedAt));
  openSheet('Kosz', del.length ? `
    <div class="list">${del.map((t) => `<div class="item"><span class="ico">${esc(txIcon(t, cats))}</span>
      <span class="mid"><span class="t1">${esc(t.description || catLabel(t.categoryId, cats))}</span><span class="t2">${esc(formatDatePL(t.date))} · ${esc(formatMoney(t.amount, t.currency))}</span></span>
      <button class="link" data-action="restore-tx" data-id="${esc(t.id)}">Przywróć</button></div>`).join('')}</div>
    <div class="actions"><button class="btn danger block" data-action="empty-trash">Opróżnij kosz (nieodwracalne)</button></div>`
    : '<p class="empty">Kosz jest pusty.</p>');
}

// ---------- Formularz transakcji ----------
function recentTemplates() {
  const seen = new Set();
  const out = [];
  for (const t of liveTx().sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''))) {
    if (!t.description) continue;
    const key = `${t.type}|${t.description.toLowerCase()}|${t.categoryId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
    if (out.length >= 6) break;
  }
  return out;
}

async function openTxSheet(id) {
  const existing = id ? state.data.transactions.find((t) => t.id === id) : null;
  const lastAccount = await db.getSetting('lastAccount', null);
  const accounts = activeAccounts();
  if (!accounts.length) { toast('Najpierw dodaj konto w zakładce Majątek'); return; }
  const defAcc = (accounts.find((a) => a.id === lastAccount)
    || accounts.find((a) => a.type === 'checking') || accounts[0]).id;
  const f = {
    type: existing?.type || 'expense',
    amount: existing ? minorToInput(existing.amount) : '',
    date: existing?.date || todayISO(),
    categoryId: existing?.categoryId || null,
    accountId: existing?.accountId || defAcc,
    toAccountId: existing?.toAccountId || accounts.find((a) => a.id !== defAcc)?.id || '',
    toAmount: existing?.toAmount != null ? minorToInput(existing.toAmount) : '',
    description: existing?.description || '',
    tags: (existing?.tags || []).join(', '),
    recurring: !!existing?.recurring,
    refund: !!existing?.refund,
  };
  // edycja konta zarchiwizowanego: pokaż je na liście
  const accOptions = (sel) => state.data.accounts.filter((a) => !a.archived || a.id === sel)
    .map((a) => `<option value="${esc(a.id)}" ${a.id === sel ? 'selected' : ''}>${esc(a.name)} (${esc(a.currency)})</option>`).join('');
  const recent = existing ? [] : recentTemplates();

  openSheet(existing ? 'Edytuj transakcję' : 'Nowa transakcja', `
    <div class="seg" id="t-type">
      <button type="button" data-type="expense">Wydatek</button>
      <button type="button" data-type="income">Przychód</button>
      <button type="button" data-type="transfer">Transfer</button>
    </div>
    ${existing ? '' : `<div class="quick"><input id="t-quick" placeholder="Szybko: „Paliwo 250 zł dzisiaj”" autocomplete="off" enterkeyhint="done"></div>
    <div class="quick-hint" id="t-hint"></div>`}
    ${recent.length ? `<div class="chips" style="margin-top:6px">${recent.map((t, i) => `<button type="button" class="chip" data-recent="${i}">${esc(catIcon(t.categoryId))} ${esc(t.description)}</button>`).join('')}</div>` : ''}
    <label class="field"><span>Kwota</span><input id="t-amount" class="amount-input" inputmode="decimal" placeholder="0,00" value="${esc(f.amount)}" autocomplete="off"></label>
    <div id="t-cat-wrap" class="field"><span>Kategoria</span><div class="catgrid" id="t-cats"></div></div>
    <div class="grid2">
      <label class="field"><span id="t-acc-label">Konto</span><select id="t-acc">${accOptions(f.accountId)}</select></label>
      <label class="field"><span>Data</span><input id="t-date" type="date" value="${esc(f.date)}" required></label>
    </div>
    <div id="t-to-wrap" hidden>
      <label class="field"><span>Na konto</span><select id="t-to">${accOptions(f.toAccountId)}</select></label>
      <label class="field" id="t-toamt-wrap" hidden><span>Kwota na koncie docelowym (inna waluta)</span><input id="t-toamt" inputmode="decimal" value="${esc(f.toAmount)}"></label>
      <p class="small muted">Transfer to przeniesienie między Twoimi kontami (np. na oszczędności, IKE, wypłata z bankomatu). Nie jest liczony jako wydatek ani przychód.</p>
    </div>
    <label class="field"><span>Opis</span><input id="t-desc" maxlength="200" value="${esc(f.description)}" placeholder="np. Orlen, Biedronka" autocomplete="off"></label>
    <details class="more" ${f.tags || f.recurring || f.refund ? 'open' : ''}><summary>Więcej opcji</summary>
      <label class="field"><span>Tagi (po przecinku)</span><input id="t-tags" value="${esc(f.tags)}" placeholder="np. wakacje2026, firma"></label>
      <label class="check" id="t-refund-wrap"><input type="checkbox" id="t-refund" ${f.refund ? 'checked' : ''}> To jest zwrot (np. oddany towar) — zmniejsza wydatki</label>
      <label class="check"><input type="checkbox" id="t-rec" ${f.recurring ? 'checked' : ''}> Oznacz jako cykliczną</label>
      <p class="small muted">Oznaczenie służy na razie do filtrowania. Automatyczne powtarzanie dojdzie w Etapie 4.</p>
    </details>
    <div class="err" id="t-err" role="alert"></div>
    <div class="actions ${existing ? 'two' : ''}">
      ${existing ? '<button class="btn danger" id="t-del">Usuń</button>' : ''}
      <button class="btn primary block" id="t-save">${existing ? 'Zapisz zmiany' : 'Dodaj'}</button>
    </div>`);

  const sheet = $('#sheet');
  const cats = () => state.data.categories.filter((c) => c.kind === f.type && (!c.archived || c.id === f.categoryId));
  const usage = {};
  for (const t of liveTx()) if (t.categoryId) usage[t.categoryId] = (usage[t.categoryId] || 0) + 1;

  function paintCats() {
    const all = catById();
    const list = cats().sort((a, b) => (usage[b.id] || 0) - (usage[a.id] || 0) || a.name.localeCompare(b.name, 'pl'));
    $('#t-cats').innerHTML = list.map((c) => `<button type="button" class="cat" data-cat="${esc(c.id)}" aria-pressed="${c.id === f.categoryId}">
      <b>${esc(c.icon || '•')}</b>${esc(c.name)}${c.parentId && all[c.parentId] ? `<small class="muted">${esc(all[c.parentId].name)}</small>` : ''}</button>`).join('')
      || '<p class="muted small">Brak kategorii — dodaj w Ustawieniach.</p>';
  }
  function paintType() {
    sheet.querySelectorAll('#t-type button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.type === f.type)));
    const tr = f.type === 'transfer';
    $('#t-cat-wrap').hidden = tr;
    $('#t-to-wrap').hidden = !tr;
    $('#t-refund-wrap').hidden = f.type !== 'expense';
    $('#t-acc-label').textContent = tr ? 'Z konta' : f.type === 'income' ? 'Na konto' : 'Z konta';
    const ab = accById();
    $('#t-toamt-wrap').hidden = !(tr && ab[$('#t-acc').value]?.currency !== ab[$('#t-to').value]?.currency);
    if (f.categoryId && !cats().some((c) => c.id === f.categoryId)) f.categoryId = null;
    paintCats();
  }
  paintType();

  sheet.querySelector('#t-type').onclick = (e) => {
    const b = e.target.closest('button[data-type]');
    if (!b) return;
    f.type = b.dataset.type;
    paintType();
  };
  $('#t-cats').onclick = (e) => {
    const b = e.target.closest('[data-cat]');
    if (!b) return;
    f.categoryId = b.dataset.cat;
    paintCats();
  };
  $('#t-acc').onchange = paintType;
  $('#t-to').onchange = paintType;
  $('#t-desc').onchange = () => {
    if (f.type === 'transfer' || f.categoryId) return;
    const g = guessCategory($('#t-desc').value, state.data.categories, state.data.transactions, f.type);
    if (g) { f.categoryId = g; paintCats(); }
  };

  sheet.querySelectorAll('[data-recent]').forEach((b) => {
    b.onclick = () => {
      const t = recent[Number(b.dataset.recent)];
      f.type = t.type;
      f.categoryId = t.categoryId || null;
      $('#t-amount').value = minorToInput(t.amount);
      $('#t-desc').value = t.description;
      if (accById()[t.accountId] && !accById()[t.accountId].archived) $('#t-acc').value = t.accountId;
      if (t.toAccountId) $('#t-to').value = t.toAccountId;
      paintType();
      $('#t-amount').focus();
      $('#t-amount').select();
    };
  });

  const quick = $('#t-quick');
  if (quick) {
    const apply = () => {
      const r = parseQuick(quick.value, { categories: state.data.categories, history: state.data.transactions });
      if (!quick.value.trim()) { $('#t-hint').textContent = ''; return; }
      if (r.amount != null && r.amount > 0) $('#t-amount').value = minorToInput(r.amount);
      $('#t-date').value = r.date;
      $('#t-desc').value = r.description;
      if (f.type !== 'transfer') f.type = r.type;
      f.categoryId = r.categoryId;
      paintType();
      const cl = r.categoryId ? catLabel(r.categoryId) : 'kategoria nierozpoznana — wybierz poniżej';
      $('#t-hint').textContent = `${r.type === 'income' ? 'Przychód' : 'Wydatek'} · ${r.amount ? formatMoney(r.amount) : 'brak kwoty'} · ${formatDatePL(r.date)} · ${cl}`;
    };
    quick.oninput = apply;
    quick.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); apply(); $('#t-save').click(); } };
    setTimeout(() => quick.focus(), 50);
  }

  $('#t-save').onclick = async () => {
    const amount = toMinor($('#t-amount').value);
    const tr = f.type === 'transfer';
    const accs = accById();
    const acc = accs[$('#t-acc').value];
    const to = tr ? accs[$('#t-to').value] : null;
    const toAmount = tr && to && acc && to.currency !== acc.currency ? toMinor($('#t-toamt').value) : null;
    const now = new Date().toISOString();
    const t = {
      ...(existing || { id: db.newId('tx'), createdAt: now }),
      type: f.type,
      amount,
      currency: acc?.currency || 'PLN',
      date: $('#t-date').value,
      categoryId: tr ? null : f.categoryId,
      accountId: $('#t-acc').value,
      toAccountId: tr ? $('#t-to').value : null,
      toAmount: Number.isNaN(toAmount) ? -1 : toAmount,
      description: $('#t-desc').value.trim(),
      tags: $('#t-tags').value.split(',').map((s) => s.trim()).filter(Boolean),
      recurring: $('#t-rec').checked,
      refund: f.type === 'expense' && $('#t-refund').checked,
      updatedAt: now,
    };
    const errors = validateTransaction(t, state.data);
    if (!tr && !t.categoryId) errors.push('Wybierz kategorię');
    if (errors.length) { $('#t-err').textContent = errors.join(' · '); return; }
    try {
      await db.put('transactions', t);
      await db.setSetting('lastAccount', t.accountId);
    } catch (err) {
      $('#t-err').textContent = 'Nie udało się zapisać: ' + err.message;
      return;
    }
    closeSheet();
    if (!existing && monthKey(t.date) !== state.month) state.month = monthKey(t.date);
    await reload();
    toast(existing ? 'Zapisano zmiany' : `Dodano: ${formatMoney(t.amount, t.currency)}`);
  };

  if (existing) {
    $('#t-del').onclick = async () => {
      await db.put('transactions', { ...existing, deletedAt: new Date().toISOString() });
      closeSheet();
      await reload();
      toast('Przeniesiono do kosza', {
        label: 'Cofnij',
        run: async () => {
          const { deletedAt, ...restored } = existing;
          await db.put('transactions', restored);
          await reload();
        },
      });
    };
  }
}

// ---------- Arkusz ----------
function openSheet(title, body) {
  const sheet = $('#sheet');
  sheet.innerHTML = `<div class="sheet-inner"><div class="sheet-head"><h2 id="sheet-title">${esc(title)}</h2>
    <button class="icon-btn" data-action="close-sheet" aria-label="Zamknij">✕</button></div>${body}</div>`;
  if (!sheet.open) sheet.showModal();
  if (!history.state?.sheet) history.pushState({ sheet: true }, '');
}
function closeSheet() {
  const sheet = $('#sheet');
  if (sheet.open) sheet.close();
  if (history.state?.sheet) history.back();
}

async function confirmSheet(title, message, { confirmLabel = 'Potwierdź', danger = false, typeToConfirm = null } = {}) {
  return new Promise((resolve) => {
    openSheet(title, `<p>${message}</p>
      ${typeToConfirm ? `<label class="field"><span>Wpisz ${esc(typeToConfirm)}, aby potwierdzić</span><input id="cf-input" autocomplete="off"></label>` : ''}
      <div class="actions two"><button class="btn" id="cf-no">Anuluj</button>
      <button class="btn ${danger ? 'danger' : 'primary'}" id="cf-yes" ${typeToConfirm ? 'disabled' : ''}>${esc(confirmLabel)}</button></div>`);
    if (typeToConfirm) $('#cf-input').oninput = (e) => { $('#cf-yes').disabled = e.target.value.trim().toUpperCase() !== typeToConfirm; };
    $('#cf-no').onclick = () => { closeSheet(); resolve(false); };
    $('#cf-yes').onclick = () => { closeSheet(); resolve(true); };
    $('#sheet').addEventListener('close', () => resolve(false), { once: true });
  });
}

// ---------- Akcje ----------
async function doBackup() {
  const data = await db.exportBackup();
  download(`smart-finance-kopia-${todayISO()}.json`, JSON.stringify(data, null, 1), 'application/json');
  state.lastBackup = new Date().toISOString();
  await db.setSetting('lastBackup', state.lastBackup);
  render();
  toast('Zapisano kopię w Pobranych');
}

async function doRestore(file) {
  let data;
  try {
    data = JSON.parse(await file.text());
  } catch {
    toast('Plik jest uszkodzony lub to nie jest kopia JSON');
    return;
  }
  const v = validateBackup(data);
  if (!v.ok) {
    openSheet('Nie można przywrócić', `<p class="neg">${v.errors.map(esc).join('<br>')}</p>`);
    return;
  }
  const ok = await confirmSheet('Przywrócić kopię?',
    `Kopia zawiera: ${v.counts.transactions} transakcji, ${v.counts.accounts} kont, ${v.counts.categories} kategorii.<br><br>
    <b>Obecne dane zostaną zastąpione.</b> Przed przywróceniem automatycznie pobierzemy kopię obecnych danych.`,
    { confirmLabel: 'Przywróć' });
  if (!ok) return;
  const current = await db.exportBackup();
  download(`smart-finance-przed-przywroceniem-${todayISO()}.json`, JSON.stringify(current), 'application/json');
  await db.restoreBackup(data);
  await reload();
  toast('Przywrócono dane z kopii');
}

async function onAction(e) {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const a = el.dataset.action;
  switch (a) {
    case 'add': openTxSheet(); break;
    case 'edit-tx': openTxSheet(el.dataset.id); break;
    case 'close-sheet': closeSheet(); break;
    case 'month-prev': state.month = addMonths(state.month, -1); render(); break;
    case 'month-next': state.month = addMonths(state.month, 1); render(); break;
    case 'month-today': state.month = monthKey(todayISO()); render(); break;
    case 'tx-filter': state.txFilter = el.dataset.f; render(); break;
    case 'edit-budget': openBudgetSheet(el.dataset.id); break;
    case 'edit-account': openAccountSheet(el.dataset.id); break;
    case 'add-account': openAccountSheet(null); break;
    case 'categories': openCategoriesSheet(el.dataset.kind); break;
    case 'edit-cat': openCategorySheet(el.dataset.id); break;
    case 'new-cat': openCategorySheet(null, el.dataset.kind); break;
    case 'theme':
      try { localStorage.setItem('sf-theme', el.dataset.theme); } catch { /* brak dostępu */ }
      applyTheme();
      render();
      break;
    case 'backup': doBackup(); break;
    case 'restore': $('#file-input').click(); break;
    case 'export-csv':
      download(`smart-finance-transakcje-${todayISO()}.csv`, transactionsToCSV(state.data.transactions, state.data), 'text/csv;charset=utf-8');
      toast('Zapisano plik CSV w Pobranych');
      break;
    case 'trash': openTrashSheet(); break;
    case 'restore-tx': {
      const t = state.data.transactions.find((x) => x.id === el.dataset.id);
      const { deletedAt, ...restored } = t;
      await db.put('transactions', restored);
      await reload();
      openTrashSheet();
      toast('Przywrócono');
      break;
    }
    case 'empty-trash': {
      const n = state.data.transactions.filter((t) => t.deletedAt).length;
      if (await confirmSheet('Opróżnić kosz?', `Trwale usunąć ${n} transakcji? Tego nie da się cofnąć.`, { confirmLabel: 'Usuń trwale', danger: true })) {
        for (const t of state.data.transactions.filter((x) => x.deletedAt)) await db.remove('transactions', t.id);
        await reload();
        toast('Kosz opróżniony');
      }
      break;
    }
    case 'wipe':
      if (await confirmSheet('Usunąć wszystkie dane?', 'Wszystkie transakcje, konta, kategorie i budżety zostaną usunięte z tego telefonu. Zalecamy najpierw zrobić kopię zapasową.', { confirmLabel: 'Usuń wszystko', danger: true, typeToConfirm: 'USUŃ' })) {
        await db.wipeAll();
        await db.ensureDefaults();
        state.lastBackup = null;
        await reload();
        toast('Usunięto wszystkie dane');
      }
      break;
    default: break;
  }
}

function applyTheme() {
  let t = 'system';
  try { t = localStorage.getItem('sf-theme') || 'system'; } catch { /* brak dostępu */ }
  if (t === 'system') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', t);
}

// ---------- Start ----------
async function init() {
  applyTheme();
  document.addEventListener('click', onAction);
  window.addEventListener('hashchange', route);
  window.addEventListener('popstate', () => { const s = $('#sheet'); if (s.open) s.close(); });
  $('#sheet').addEventListener('click', (e) => { if (e.target.id === 'sheet') closeSheet(); }); // klik w tło
  $('#sheet').addEventListener('cancel', (e) => { e.preventDefault(); closeSheet(); });
  $('#file-input').addEventListener('change', (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (file) doRestore(file);
  });
  try {
    await db.ensureDefaults();
    state.lastBackup = await db.getSetting('lastBackup', null);
    state.data = await db.loadAll();
  } catch (err) {
    $('#view').innerHTML = `<div class="note warn">Nie można otworzyć bazy danych: ${esc(err.message)}<br>Sprawdź, czy przeglądarka nie jest w trybie prywatnym.</div>`;
    return;
  }
  state.persisted = await db.requestPersistence();
  route();
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch(() => { /* offline niedostępny — aplikacja działa dalej */ });
  }
}

init();
