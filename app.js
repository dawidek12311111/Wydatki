// Smart Finance — interfejs aplikacji (ekrany, formularze, nawigacja).
import * as db from './db.js';
import {
  balances, netWorth, monthSummary, rollupByParent, averages, effectOnAccount,
  monthlySeries, categoryChanges, isLive, accountMonth, billsSummary, billsToCopy,
} from './calc.js';
import { toMinor, formatMoney, minorToInput } from './money.js';
import { todayISO, monthKey, addMonths, monthNamePL, monthShortPL, dayLabelPL, formatDatePL } from './dates.js';
import { parseQuick, guessCategory } from './parse.js';
import { validateTransaction, validateBackup, validateBill } from './validate.js';
import { transactionsToCSV } from './csv.js';
import { ACCOUNT_TYPES, CURRENCIES, SAVINGS_KINDS, BILL_ICONS, accountGroup } from './defaults.js';

export const APP_VERSION = '0.3.0';

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (m, cur = 'PLN', o) => `<span class="num">${esc(formatMoney(m, cur, o))}</span>`;

const state = {
  data: { accounts: [], categories: [], transactions: [], budgets: [], bills: [] },
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
  budget: { title: 'Do zapłaty', month: true },
  wealth: { title: 'Majątek', month: true },
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
    ? `${accs[t.accountId]?.name || 'tylko zapis'} → ${accs[t.toAccountId]?.name || 'tylko zapis'}`
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

  const bs = billsSummary(state.data.bills, state.month);
  if (bs.count) {
    const unpaid = billsOfMonth().filter((b) => !b.paid);
    parts.push(`<section class="card"><h2>Do zapłaty <a href="#budget">Lista ›</a></h2>
      <div class="stat-row">
        <div class="stat"><small>Zostało</small><b class="${bs.left > 0 ? 'neg' : 'pos'}">${money(bs.left)}</b></div>
        <div class="stat"><small>Zapłacone</small><b>${money(bs.paid)}</b></div>
        <div class="stat"><small>Opłacone</small><b>${bs.paidCount} / ${bs.count}</b></div>
      </div>
      ${unpaid.length ? `<p class="small muted" style="margin:10px 0 0">Niezapłacone: ${unpaid.slice(0, 4).map((b) => esc(b.icon || '') + ' ' + esc(b.name)).join(', ')}${unpaid.length > 4 ? '…' : ''}</p>` : ''}
    </section>`);
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

// ---------- Budżet: lista „Do zapłaty” ----------
function billsOfMonth(ym = state.month) {
  return state.data.bills.filter((b) => b.month === ym)
    .sort((a, b) => (a.order || 0) - (b.order || 0) || (a.createdAt || '').localeCompare(b.createdAt || ''));
}

function billRow(b) {
  return `<div class="item bill ${b.paid ? 'is-paid' : ''}">
    <button class="bill-main" data-action="edit-bill" data-id="${esc(b.id)}">
      <span class="ico" aria-hidden="true">${esc(b.icon || '📄')}</span>
      <span class="mid"><span class="t1">${esc(b.name)}</span><span class="t2 num">${esc(formatMoney(b.amount))}${b.note ? ' · ' + esc(b.note) : ''}</span></span>
    </button>
    <button class="paybtn ${b.paid ? 'paid' : 'unpaid'}" data-action="toggle-bill" data-id="${esc(b.id)}"
      aria-label="${b.paid ? 'Zapłacone — dotknij, aby oznaczyć jako niezapłacone' : 'Niezapłacone — dotknij, aby oznaczyć jako zapłacone'}">${b.paid ? '✓' : '✕'}</button>
  </div>`;
}

function viewBudget() {
  const ym = state.month;
  const list = billsOfMonth(ym);
  const s = billsSummary(state.data.bills, ym);
  const prevYm = addMonths(ym, -1);
  const toCopy = billsToCopy(state.data.bills, prevYm, ym);
  const progress = s.total ? (s.paid / s.total) * 100 : 0;
  return `<section class="card hero">
      <h2>Do zapłaty: ${esc(monthNamePL(ym).toLowerCase())}</h2>
      <div class="big num">${esc(formatMoney(s.left))}</div>
      <div class="split">
        <div><small>Razem</small><b class="num">${esc(formatMoney(s.total))}</b></div>
        <div><small>Zapłacone</small><b class="num">${esc(formatMoney(s.paid))}</b></div>
      </div>
      <div class="track light"><div class="fill" style="width:${progress.toFixed(1)}%"></div></div>
      <div class="foot">${s.count ? `Opłacone ${s.paidCount} z ${s.count}${s.left === 0 ? ' — wszystko zapłacone 🎉' : ''}` : 'Lista jest pusta'}</div>
    </section>
    ${list.length ? `<div class="list">${list.map(billRow).join('')}</div>` : `<div class="empty"><span class="em">🧾</span>Dodaj rachunki i opłaty na ${esc(monthNamePL(ym).toLowerCase())}.</div>`}
    <div class="actions">
      <button class="btn primary block" data-action="add-bill">+ Dodaj do zapłaty</button>
      ${toCopy.length ? `<button class="btn block" data-action="copy-bills">Skopiuj z: ${esc(monthNamePL(prevYm).toLowerCase())} (${toCopy.length})</button>` : ''}
    </div>
    <p class="note">Dotknij ✕ / ✓, żeby zmienić status. Dotknij nazwy, żeby edytować. Strzałkami u góry przejdziesz na kolejny miesiąc i zaplanujesz opłaty z wyprzedzeniem.</p>`;
}

function openBillSheet(id) {
  const b = id ? state.data.bills.find((x) => x.id === id) : null;
  let icon = b?.icon || BILL_ICONS[0];
  openSheet(b ? 'Edytuj pozycję' : `Do zapłaty: ${monthNamePL(state.month).toLowerCase()}`, `
    <label class="field"><span>Co trzeba zapłacić</span><input id="bl-name" maxlength="80" value="${esc(b?.name || '')}" placeholder="np. Czynsz, Prąd, Przedszkole" autocomplete="off"></label>
    <label class="field"><span>Kwota</span><input id="bl-amount" class="amount-input" inputmode="decimal" placeholder="0,00" value="${b ? esc(minorToInput(b.amount)) : ''}" autocomplete="off"></label>
    <div class="field"><span>Ikona</span><div class="icongrid" id="bl-icons">${BILL_ICONS.map((i) => `<button type="button" data-icon="${i}" aria-pressed="${i === icon}">${i}</button>`).join('')}</div>
      <input id="bl-icon-custom" maxlength="4" placeholder="lub wpisz własne emoji" value="${BILL_ICONS.includes(icon) ? '' : esc(icon)}"></div>
    <label class="field"><span>Notatka (opcjonalnie)</span><input id="bl-note" maxlength="80" value="${esc(b?.note || '')}" placeholder="np. termin 10-go, nr konta w mailu"></label>
    <label class="check"><input type="checkbox" id="bl-paid" ${b?.paid ? 'checked' : ''}> Zapłacone</label>
    <div class="err" id="bl-err" role="alert"></div>
    <div class="actions ${b ? 'two' : ''}">
      ${b ? '<button class="btn danger" id="bl-del">Usuń</button>' : ''}
      <button class="btn primary block" id="bl-save">${b ? 'Zapisz' : 'Dodaj'}</button>
    </div>`);
  const grid = $('#bl-icons');
  grid.onclick = (e) => {
    const btn = e.target.closest('[data-icon]');
    if (!btn) return;
    icon = btn.dataset.icon;
    $('#bl-icon-custom').value = '';
    grid.querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', String(x === btn)));
  };
  $('#bl-icon-custom').oninput = (e) => {
    if (e.target.value.trim()) grid.querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', 'false'));
  };
  if (!b) setTimeout(() => $('#bl-name').focus(), 50);
  $('#bl-save').onclick = async () => {
    const paid = $('#bl-paid').checked;
    const item = {
      ...(b || { id: db.newId('bill'), month: state.month, createdAt: new Date().toISOString(), order: Date.now() }),
      name: $('#bl-name').value.trim(),
      amount: toMinor($('#bl-amount').value),
      icon: $('#bl-icon-custom').value.trim() || icon,
      note: $('#bl-note').value.trim(),
      paid,
      paidAt: paid ? (b?.paidAt || new Date().toISOString()) : null,
    };
    const errors = validateBill(item);
    if (errors.length) { $('#bl-err').textContent = errors.join(' · '); return; }
    await db.put('bills', item);
    closeSheet();
    await reload();
    toast(b ? 'Zapisano' : 'Dodano do listy');
  };
  if (b) {
    $('#bl-del').onclick = async () => {
      await db.remove('bills', b.id);
      closeSheet();
      await reload();
      toast('Usunięto z listy', { label: 'Cofnij', run: async () => { await db.put('bills', b); await reload(); } });
    };
  }
}

async function toggleBill(id) {
  const b = state.data.bills.find((x) => x.id === id);
  if (!b) return;
  const paid = !b.paid;
  await db.put('bills', { ...b, paid, paidAt: paid ? new Date().toISOString() : null });
  await reload();
}

async function copyBills() {
  const items = billsToCopy(state.data.bills, addMonths(state.month, -1), state.month);
  const now = Date.now();
  await db.put('bills', ...items.map((b, i) => ({ ...b, id: db.newId('bill'), createdAt: new Date().toISOString(), order: now + i, paidAt: null })));
  await reload();
  toast(`Skopiowano ${items.length} pozycji`);
}

// ---------- Majątek ----------
const monthEnd = (ym) => `${addMonths(ym, 1)}-01`;
const isCurrentMonth = () => state.month === monthKey(todayISO());

function accountIcon(a) {
  if (a.type === 'loan') return '📉';
  if (a.subtype && SAVINGS_KINDS[a.subtype]) return SAVINGS_KINDS[a.subtype].icon;
  return { checking: '🏦', savings: '🐷', cash: '💵', card: '💳', investment: '📈', other: '📁' }[a.type] || '📁';
}
function accountKindLabel(a) {
  if (a.type === 'loan') return 'Kredyt';
  if (a.subtype && SAVINGS_KINDS[a.subtype]) return SAVINGS_KINDS[a.subtype].label;
  return ACCOUNT_TYPES[a.type] || '';
}

function viewWealth() {
  const ym = state.month;
  const txs = liveTx();
  const txsUntil = txs.filter((t) => t.date < monthEnd(ym));
  const bal = balances(state.data.accounts, txsUntil);
  const w = netWorth(state.data.accounts, txsUntil);
  const active = state.data.accounts.filter((a) => !a.archived);
  const current = active.filter((a) => accountGroup(a) === 'current');
  const savings = active.filter((a) => accountGroup(a) === 'savings');
  const loans = active.filter((a) => accountGroup(a) === 'loan');
  const archived = state.data.accounts.filter((a) => a.archived);
  const sumPLN = (list, fn) => list.filter((a) => a.currency === 'PLN').reduce((s, a) => s + fn(a), 0);
  const monthWord = esc(monthNamePL(ym).toLowerCase());

  const savingsCards = savings.map((a) => {
    const m = accountMonth(a, txs, ym);
    return `<section class="acard">
      <button class="acard-head" data-action="account-detail" data-id="${esc(a.id)}">
        <span class="ico">${esc(accountIcon(a))}</span>
        <span class="mid"><span class="t1">${esc(a.name)}</span><span class="t2">${esc(accountKindLabel(a))}${a.description ? ' · ' + esc(a.description) : ''}</span></span>
        <span class="amt num">${esc(formatMoney(m.after, a.currency))}</span>
      </button>
      <div class="acard-month small">${m.inflow || m.outflow ? `W tym miesiącu:${m.inflow ? ` <span class="pos num">wpłaty +${esc(formatMoney(m.inflow, a.currency))}</span>` : ''}${m.inflow && m.outflow ? ' ·' : ''}${m.outflow ? ` <span class="neg num">wypłaty −${esc(formatMoney(m.outflow, a.currency))}</span>` : ''}` : 'Brak wpłat i wypłat w tym miesiącu'}</div>
      <div class="acard-actions">
        <button class="btn" data-action="move" data-mode="in" data-id="${esc(a.id)}">+ Wpłata</button>
        <button class="btn" data-action="move" data-mode="out" data-id="${esc(a.id)}">− Wypłata</button>
      </div>
    </section>`;
  }).join('');

  const loanCards = loans.map((a) => {
    const m = accountMonth(a, txs, ym);
    const orig = a.loanOriginal || 0;
    const repaidPct = orig > 0 ? Math.min(100, Math.max(0, ((orig + m.after) / orig) * 100)) : null;
    return `<section class="acard">
      <button class="acard-head" data-action="account-detail" data-id="${esc(a.id)}">
        <span class="ico">📉</span>
        <span class="mid"><span class="t1">${esc(a.name)}</span><span class="t2">${a.description ? esc(a.description) : 'Kredyt'}${a.installment ? ' · rata ' + esc(formatMoney(a.installment, a.currency)) : ''}</span></span>
      </button>
      <div class="acard-grid">
        <div><small>Przed</small><b class="num">${esc(formatMoney(-m.before, a.currency))}</b></div>
        <div><small>Spłacono</small><b class="num pos">${esc(formatMoney(m.inflow - m.outflow, a.currency))}</b></div>
        <div><small>Po</small><b class="num">${esc(formatMoney(-m.after, a.currency))}</b></div>
      </div>
      ${repaidPct != null ? `<div class="track"><div class="fill" style="width:${repaidPct.toFixed(1)}%"></div></div>
        <div class="small muted" style="margin-top:4px">Spłacono ${Math.round(repaidPct)}% z ${esc(formatMoney(orig, a.currency))}</div>` : ''}
      <div class="acard-actions one"><button class="btn primary" data-action="move" data-mode="pay" data-id="${esc(a.id)}">Dodaj spłatę</button></div>
    </section>`;
  }).join('');

  return `<section class="card hero">
      <h2>Majątek netto — ${isCurrentMonth() ? 'dziś' : 'koniec: ' + monthWord}</h2>
      <div class="big num">${esc(formatMoney(w.net))}</div>
      <div class="split">
        <div><small>Aktywa</small><b class="num">${esc(formatMoney(w.assets))}</b></div>
        <div><small>Zobowiązania</small><b class="num">${esc(formatMoney(w.liabilities))}</b></div>
      </div>
      ${active.some((a) => a.currency !== 'PLN') ? '<div class="foot">Konta w innych walutach nie są wliczane do sum.</div>' : ''}
    </section>

    <div class="sec-head"><h2>Oszczędności i inwestycje</h2><b class="num">${esc(formatMoney(sumPLN(savings, (a) => bal[a.id])))}</b></div>
    ${savingsCards || '<p class="muted small">Dodaj lokatę, IKE, PPK, ETF albo cokolwiek, gdzie odkładasz pieniądze.</p>'}
    <button class="btn block" data-action="add-account" data-group="savings">+ Dodaj oszczędności / inwestycję</button>

    <div class="sec-head"><h2>Kredyty</h2><b class="num">${loans.length ? esc(formatMoney(sumPLN(loans, (a) => -bal[a.id]))) : ''}</b></div>
    ${loanCards ? `<p class="small muted" style="margin:0 4px 8px">Stan w miesiącu: ${monthWord}</p>${loanCards}` : '<p class="muted small">Brak kredytów.</p>'}
    <button class="btn block" data-action="add-account" data-group="loan">+ Dodaj kredyt</button>

    <div class="sec-head"><h2>Konta bieżące</h2><b class="num">${esc(formatMoney(sumPLN(current, (a) => bal[a.id])))}</b></div>
    <div class="list">${current.map((a) => `<button class="item" data-action="account-detail" data-id="${esc(a.id)}">
      <span class="ico">${esc(accountIcon(a))}</span>
      <span class="mid"><span class="t1">${esc(a.name)}</span><span class="t2">${esc(accountKindLabel(a))}</span></span>
      <span class="amt num ${bal[a.id] < 0 ? 'neg' : ''}">${esc(formatMoney(bal[a.id], a.currency))}</span></button>`).join('')}</div>
    <div class="actions"><button class="btn block" data-action="add-account" data-group="current">+ Dodaj konto</button></div>

    ${archived.length ? `<p class="small muted" style="margin-top:16px">Zarchiwizowane: ${archived.map((a) => `<button class="link" data-action="edit-account" data-id="${esc(a.id)}">${esc(a.name)}</button>`).join(', ')}</p>` : ''}
    <p class="note">Wpłaty na oszczędności i spłaty kredytów to przeniesienia pieniędzy — nie są liczone jako wydatki i nie zmieniają majątku netto (chyba że wybierzesz „tylko zapis”).</p>`;
}

function openAccountSheet(id, group) {
  const a = id ? accById()[id] : null;
  group = a ? accountGroup(a) : (group || 'current');
  const used = id && state.data.transactions.some((t) => t.accountId === id || t.toAccountId === id);
  let subtype = a?.subtype || (a?.type === 'savings' ? 'deposit' : a ? 'other' : 'deposit');
  const title = a ? 'Edytuj' : { savings: 'Nowe oszczędności / inwestycja', loan: 'Nowy kredyt', current: 'Nowe konto' }[group];
  const curSelect = `<label class="field"><span>Waluta</span><select id="a-cur" ${used ? 'disabled' : ''}>${CURRENCIES.map((c) => `<option ${(a?.currency || 'PLN') === c ? 'selected' : ''}>${c}</option>`).join('')}</select></label>`;
  let body = '';
  if (group === 'savings') {
    body = `<div class="field"><span>Rodzaj</span><div class="chips wrap" id="a-kind">${Object.entries(SAVINGS_KINDS).map(([k, v]) =>
      `<button type="button" class="chip" data-kind="${k}" aria-pressed="${k === subtype}">${v.icon} ${esc(v.label)}</button>`).join('')}</div></div>
      <label class="field"><span>Nazwa</span><input id="a-name" maxlength="60" value="${esc(a?.name || '')}" placeholder="np. IKE w XTB, Lokata mBank"></label>
      <label class="field"><span>Opis (opcjonalnie)</span><input id="a-desc" maxlength="120" value="${esc(a?.description || '')}" placeholder="np. na emeryturę, ETF na MSCI World"></label>
      <div class="grid2"><label class="field"><span>${a ? 'Kwota początkowa' : 'Ile jest tam teraz'}</span><input id="a-open" inputmode="decimal" value="${a ? esc(minorToInput(a.openingBalance)) : ''}" placeholder="0,00"></label>${curSelect}</div>
      <p class="small muted">Kolejne wpłaty i wypłaty dodajesz przyciskami na karcie.</p>`;
  } else if (group === 'loan') {
    body = `<label class="field"><span>Nazwa kredytu</span><input id="a-name" maxlength="60" value="${esc(a?.name || '')}" placeholder="np. Hipoteka PKO, Kredyt na auto"></label>
      <label class="field"><span>Opis (opcjonalnie)</span><input id="a-desc" maxlength="120" value="${esc(a?.description || '')}" placeholder="np. do 2045, oprocentowanie zmienne"></label>
      <label class="field"><span>${a ? 'Do spłaty na start (zanim zacząłeś zapisywać spłaty)' : 'Ile zostało do spłaty teraz'}</span><input id="a-open" class="amount-input" inputmode="decimal" value="${a ? esc(minorToInput(-a.openingBalance)) : ''}" placeholder="0,00"></label>
      <div class="grid2">
        <label class="field"><span>Rata miesięczna (opcj.)</span><input id="a-inst" inputmode="decimal" value="${a?.installment ? esc(minorToInput(a.installment)) : ''}" placeholder="0,00"></label>
        <label class="field"><span>Kwota kredytu (opcj.)</span><input id="a-orig" inputmode="decimal" value="${a?.loanOriginal ? esc(minorToInput(a.loanOriginal)) : ''}" placeholder="do paska postępu"></label>
      </div>
      ${curSelect}`;
  } else {
    body = `<label class="field"><span>Nazwa</span><input id="a-name" maxlength="60" value="${esc(a?.name || '')}" placeholder="np. mBank, Portfel"></label>
      <label class="field"><span>Rodzaj</span><select id="a-type">${['checking', 'cash', 'card', 'other'].map((k) => `<option value="${k}" ${a?.type === k ? 'selected' : ''}>${esc(ACCOUNT_TYPES[k])}</option>`).join('')}</select></label>
      <div class="grid2"><label class="field"><span>Saldo początkowe</span><input id="a-open" inputmode="decimal" value="${a ? esc(minorToInput(a.openingBalance)) : ''}" placeholder="0,00"></label>${curSelect}</div>
      <p class="small muted">Saldo początkowe = ile było na koncie, zanim zacząłeś zapisywać transakcje.</p>`;
  }
  openSheet(title, `${body}
    ${a ? `<label class="check"><input type="checkbox" id="a-arch" ${a.archived ? 'checked' : ''}> Zarchiwizuj (ukryj, historia zostaje)</label>` : ''}
    <div class="err" id="a-err" role="alert"></div>
    <div class="actions"><button class="btn primary block" id="a-save">Zapisz</button></div>`);
  const kinds = $('#a-kind');
  if (kinds) {
    kinds.onclick = (e) => {
      const b = e.target.closest('[data-kind]');
      if (!b) return;
      subtype = b.dataset.kind;
      kinds.querySelectorAll('[data-kind]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    };
  }
  $('#a-save').onclick = async () => {
    const err = (m) => { $('#a-err').textContent = m; };
    const name = $('#a-name').value.trim();
    if (!name) return err('Podaj nazwę.');
    const opt = (sel) => ($(sel)?.value.trim() ? toMinor($(sel).value) : 0);
    let opening = opt('#a-open');
    if (!Number.isInteger(opening)) return err('Nieprawidłowa kwota.');
    const item = {
      ...(a || { id: db.newId('acc'), createdAt: new Date().toISOString() }),
      name,
      currency: $('#a-cur').value,
      archived: a ? $('#a-arch').checked : false,
    };
    if (group === 'savings') {
      item.type = SAVINGS_KINDS[subtype].type;
      item.subtype = subtype;
      item.description = $('#a-desc').value.trim();
    } else if (group === 'loan') {
      const inst = opt('#a-inst');
      const orig = opt('#a-orig');
      if (opening < 0 || !Number.isInteger(inst) || !Number.isInteger(orig) || inst < 0 || orig < 0) return err('Wpisz kwoty bez minusa.');
      opening = -opening; // dług zapisujemy jako saldo ujemne
      item.type = 'loan';
      item.description = $('#a-desc').value.trim();
      item.installment = inst || null;
      item.loanOriginal = orig || null;
    } else {
      item.type = $('#a-type').value;
    }
    item.openingBalance = opening;
    await db.put('accounts', item);
    closeSheet();
    await reload();
    toast('Zapisano');
  };
}

/** Szczegóły konta: historia operacji. */
function openAccountDetail(id) {
  const a = accById()[id];
  if (!a) return;
  const cats = catById();
  const accs = accById();
  const txs = liveTx().filter((t) => t.accountId === id || t.toAccountId === id).sort(byDateDesc);
  const bal = balances([a], liveTx())[id];
  const isLoan = a.type === 'loan';
  openSheet(a.name, `
    <p class="muted small" style="margin-top:0">${esc(accountKindLabel(a))}${a.description ? ' · ' + esc(a.description) : ''}</p>
    <div class="stat-row" style="grid-template-columns:1fr 1fr">
      <div class="stat"><small>${isLoan ? 'Do spłaty' : 'Saldo'}</small><b class="num">${esc(formatMoney(isLoan ? -bal : bal, a.currency))}</b></div>
      <div class="stat"><small>${isLoan ? 'Na start' : 'Saldo początkowe'}</small><b class="num">${esc(formatMoney(isLoan ? -a.openingBalance : a.openingBalance, a.currency))}</b></div>
    </div>
    <h3 class="small muted" style="margin:16px 4px 6px">Historia</h3>
    ${txs.length ? `<div class="list">${txs.map((t) => {
      const e = effectOnAccount(t, id);
      const other = t.type === 'transfer' ? (t.accountId === id ? accs[t.toAccountId]?.name : accs[t.accountId]?.name) || 'tylko zapis' : catLabel(t.categoryId, cats);
      return `<button class="item" data-action="edit-tx" data-id="${esc(t.id)}">
        <span class="mid"><span class="t1">${esc(t.description || (e >= 0 ? (isLoan ? 'Spłata' : 'Wpłata') : 'Wypłata'))}</span><span class="t2">${esc(formatDatePL(t.date))} · ${esc(other)}</span></span>
        <span class="amt num ${e >= 0 ? 'pos' : 'neg'}">${esc(formatMoney(e, a.currency, { sign: true }))}</span></button>`;
    }).join('')}</div>` : '<p class="muted small">Brak operacji.</p>'}
    <div class="actions"><button class="btn block" data-action="edit-account" data-id="${esc(id)}">Edytuj ${isLoan ? 'kredyt' : 'konto'}</button></div>`);
}

/** Wpłata / wypłata na oszczędności albo spłata kredytu — zapisywane jako transfer. */
async function openMoveSheet(id, mode) {
  const a = accById()[id];
  if (!a) return;
  const sources = state.data.accounts.filter((x) => !x.archived && accountGroup(x) === 'current' && x.currency === a.currency);
  const last = await db.getSetting('lastMoveAccount', undefined);
  // „tylko zapis” nigdy nie jest zapamiętywane — domyślnie zawsze prawdziwe konto
  const def = (sources.find((x) => x.id === last) || sources.find((x) => x.type === 'checking') || sources[0])?.id || '';
  const date = isCurrentMonth() ? todayISO() : `${state.month}-01`;
  const titles = { in: `Wpłata: ${a.name}`, out: `Wypłata: ${a.name}`, pay: `Spłata: ${a.name}` };
  const defDesc = { in: 'Wpłata', out: 'Wypłata', pay: 'Spłata kredytu' }[mode];
  const otherLabel = mode === 'out' ? 'Na które konto trafiają pieniądze' : 'Z którego konta';
  const none = mode === 'out' ? 'Nie dodawaj do żadnego konta (tylko zapis)' : 'Nie odejmuj z żadnego konta (tylko zapis)';
  const prefill = mode === 'pay' && a.installment ? minorToInput(a.installment) : '';
  openSheet(titles[mode], `
    <label class="field"><span>Kwota</span><input id="mv-amount" class="amount-input" inputmode="decimal" placeholder="0,00" value="${esc(prefill)}" autocomplete="off"></label>
    <div class="grid2">
      <label class="field"><span>Data</span><input id="mv-date" type="date" value="${esc(date)}"></label>
      <label class="field"><span>Opis</span><input id="mv-desc" maxlength="200" value="${esc(defDesc)}"></label>
    </div>
    <label class="field"><span>${otherLabel}</span><select id="mv-other">
      ${sources.map((x) => `<option value="${esc(x.id)}" ${x.id === def ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}
      <option value="" ${def === '' ? 'selected' : ''}>${none}</option></select></label>
    <p class="small muted">${mode === 'pay' ? 'Spłata zmniejsza dług. Nie jest liczona jako wydatek, bo pieniądze nie znikają — spłacasz swój dług.' : 'To przeniesienie Twoich pieniędzy — nie jest liczone jako wydatek ani przychód.'}</p>
    <div class="err" id="mv-err" role="alert"></div>
    <div class="actions"><button class="btn primary block" id="mv-save">Zapisz</button></div>`);
  setTimeout(() => $('#mv-amount').focus(), 50);
  $('#mv-save').onclick = async () => {
    const other = $('#mv-other').value || null;
    const now = new Date().toISOString();
    const t = {
      id: db.newId('tx'), createdAt: now, updatedAt: now,
      type: 'transfer',
      amount: toMinor($('#mv-amount').value),
      currency: a.currency,
      date: $('#mv-date').value,
      categoryId: null,
      accountId: mode === 'out' ? a.id : other,
      toAccountId: mode === 'out' ? other : a.id,
      toAmount: null,
      description: $('#mv-desc').value.trim(),
      tags: [], recurring: false, refund: false,
    };
    const errors = validateTransaction(t, state.data);
    if (errors.length) { $('#mv-err').textContent = errors.join(' · '); return; }
    await db.put('transactions', t);
    if (other) await db.setSetting('lastMoveAccount', other);
    closeSheet();
    if (monthKey(t.date) !== state.month) state.month = monthKey(t.date);
    await reload();
    toast(`Zapisano: ${formatMoney(t.amount, t.currency)}`);
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
    accountId: existing ? (existing.accountId || '') : defAcc,
    toAccountId: existing ? (existing.toAccountId || '') : accounts.find((a) => a.id !== defAcc)?.id || '',
    toAmount: existing?.toAmount != null ? minorToInput(existing.toAmount) : '',
    description: existing?.description || '',
    tags: (existing?.tags || []).join(', '),
    recurring: !!existing?.recurring,
    refund: !!existing?.refund,
  };
  // edycja konta zarchiwizowanego: pokaż je na liście
  const accOptions = (sel) => state.data.accounts.filter((a) => !a.archived || a.id === sel)
    .map((a) => `<option value="${esc(a.id)}" ${a.id === sel ? 'selected' : ''}>${esc(a.name)} (${esc(a.currency)})</option>`).join('')
    + `<option value="" ${!sel ? 'selected' : ''}>— tylko zapis (poza kontami) —</option>`;
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
    const fa = ab[$('#t-acc').value];
    const ta = ab[$('#t-to').value];
    $('#t-toamt-wrap').hidden = !(tr && fa && ta && fa.currency !== ta.currency);
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
    const acc = accs[$('#t-acc').value] || null;
    const to = tr ? accs[$('#t-to').value] || null : null;
    const toAmount = tr && to && acc && to.currency !== acc.currency ? toMinor($('#t-toamt').value) : null;
    const now = new Date().toISOString();
    const t = {
      ...(existing || { id: db.newId('tx'), createdAt: now }),
      type: f.type,
      amount,
      currency: (acc || to)?.currency || 'PLN',
      date: $('#t-date').value,
      categoryId: tr ? null : f.categoryId,
      accountId: $('#t-acc').value || null,
      toAccountId: tr ? $('#t-to').value || null : null,
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
      if (t.accountId) await db.setSetting('lastAccount', t.accountId);
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
    case 'add-bill': openBillSheet(null); break;
    case 'edit-bill': openBillSheet(el.dataset.id); break;
    case 'toggle-bill': toggleBill(el.dataset.id); break;
    case 'copy-bills': copyBills(); break;
    case 'edit-account': openAccountSheet(el.dataset.id); break;
    case 'add-account': openAccountSheet(null, el.dataset.group); break;
    case 'account-detail': openAccountDetail(el.dataset.id); break;
    case 'move': openMoveSheet(el.dataset.id, el.dataset.mode); break;
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
