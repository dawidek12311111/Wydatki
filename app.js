// Smart Finance — interfejs aplikacji (ekrany, formularze, nawigacja).
import * as db from './db.js';
import {
  balances, netWorth, monthSummary, rollupByParent, averages, effectOnAccount,
  monthlySeries, categoryChanges, isLive, accountMonth,
} from './calc.js';
import { toMinor, formatMoney, minorToInput } from './money.js';
import { todayISO, monthKey, addMonths, monthNamePL, monthShortPL, dayLabelPL, formatDatePL, dateInMonth, WEEKDAYS_SHORT } from './dates.js';
import { parseQuick, guessCategory } from './parse.js';
import { validateTransaction, validateBackup, validateBill, validatePurchase } from './validate.js';
import { transactionsToCSV } from './csv.js';
import { ACCOUNT_TYPES, CURRENCIES, SAVINGS_KINDS, BILL_ICONS, accountGroup } from './defaults.js';
import { kindOf, planSummary, planToCopy, autoTransaction, calendarGrid, dayMarks, yearTiles } from './plan.js';
import { analyzePurchase, PRIORITIES, STATUSES, PURCHASE_ICONS } from './purchases.js';
import { buildAIContext, askGemini, checkGeminiKey, renderAIText, DEFAULT_MODEL } from './ai.js';
import { DASH_CARDS, ACCENTS, TEXT_SIZES, normalizeLayout, moveCard, setCardVisible, visibleCards } from './layout.js';

export const APP_VERSION = '0.5.0';

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (m, cur = 'PLN', o) => `<span class="num">${esc(formatMoney(m, cur, o))}</span>`;

const state = {
  data: { accounts: [], categories: [], transactions: [], budgets: [], bills: [], purchases: [] },
  plansTab: 'buy',
  buyFilter: 'active',
  view: 'dashboard',
  month: monthKey(todayISO()),
  txFilter: 'all',
  txSearch: '',
  lastBackup: null,
  persisted: false,
  layout: normalizeLayout(null),
  prefs: { defaultAccount: '' },
};

const VIEWS = {
  dashboard: { title: 'Start', month: true },
  transactions: { title: 'Transakcje', month: true },
  budget: { title: 'Plan', month: true },
  wealth: { title: 'Majątek', month: true },
  plans: { title: 'Plany', month: true },
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
/** Ustawia kursor w polu po otwarciu okienka — ale nie, jeśli użytkownik zaczął już pisać gdzie indziej. */
function focusLater(sel) {
  setTimeout(() => {
    const sheet = $('#sheet');
    const active = document.activeElement;
    if (active && active !== sheet && sheet.contains(active) && active.matches('input, textarea, select')) return;
    $(sel)?.focus();
  }, 50);
}
const dec1 = (x) => x.toFixed(1).replace('.', ',');
const pct = (x) => (x == null ? '—' : `${Math.round(x * 100)}%`);

function txRow(t, cats = catById(), accs = accById()) {
  const title = t.description || (t.type === 'transfer' ? 'Transfer' : catLabel(t.categoryId, cats));
  const sub = t.type === 'transfer'
    ? `${accs[t.accountId]?.name || 'tylko zapis'} → ${accs[t.toAccountId]?.name || 'tylko zapis'}`
    : `${catLabel(t.categoryId, cats)} · ${accs[t.accountId]?.name || '?'}`;
  const amt = t.type === 'transfer' ? formatMoney(t.amount, t.currency) : formatMoney(signedAmount(t), t.currency, { sign: true });
  const badges = `${t.refund ? '<span class="badge">zwrot</span>' : ''}${t.recurring ? '<span class="badge">cykl.</span>' : ''}`;
  return `<button class="item" data-action="edit-tx" data-id="${esc(t.id)}" data-lp="tx:${esc(t.id)}">
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
  let v = location.hash.slice(1);
  if (v === 'analytics') { v = 'plans'; state.plansTab = 'analysis'; } // stary adres
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
    wealth: viewWealth, plans: viewPlans, settings: viewSettings,
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
  const parts = [];
  const lp = (id) => `data-lp="card:${id}"`;

  if (!state.data.transactions.length) {
    parts.push(`<div class="note">👋 Witaj! Zacznij od <b>Majątek</b> → wpisz aktualne salda swoich kont, a potem dodawaj wydatki przyciskiem <b>+</b>.<br>Przytrzymaj dowolny kafelek, żeby zobaczyć więcej opcji.</div>`);
  }

  const cards = {
    balance: () => `<section class="card hero" ${lp('balance')}>
      <h2>Bilans: ${esc(monthNamePL(state.month).toLowerCase())}</h2>
      <div class="big num">${esc(formatMoney(s.net, 'PLN', { sign: true }))}</div>
      <div class="split">
        <div><small>Przychody</small><b class="num">${esc(formatMoney(s.income))}</b></div>
        <div><small>Wydatki</small><b class="num">${esc(formatMoney(s.expense))}</b></div>
      </div>
      <div class="foot">Odłożone z dochodu: <b>${pct(s.savingsRate)}</b>${s.transfersOut ? ` · transfery: <span class="num">${esc(formatMoney(s.transfersOut))}</span> (nie liczone jako wydatki)` : ''}</div>
    </section>`,

    quick: () => `<section class="card" ${lp('quick')}><h2>Szybkie dodawanie</h2>
      <div class="qa"><input id="dash-quick" placeholder="np. Biedronka 87,40" autocomplete="off" enterkeyhint="go" aria-label="Szybkie dodawanie">
      <button class="btn primary" data-action="quick-add">Dalej</button></div></section>`,

    networth: () => {
      const w = netWorth(state.data.accounts, txs);
      return `<section class="card" ${lp('networth')}>
        <h2>Majątek netto <a href="#wealth">Konta ›</a></h2>
        <div class="stat-row">
          <div class="stat"><small>Netto</small><b class="${w.net < 0 ? 'neg' : ''}">${money(w.net)}</b></div>
          <div class="stat"><small>Aktywa</small><b>${money(w.assets)}</b></div>
          <div class="stat"><small>Długi</small><b>${money(w.liabilities)}</b></div>
        </div></section>`;
    },

    bills: () => {
      const ps = planSummary(state.data.bills, state.month);
      const open = billsOfMonth().filter((b) => !b.paid);
      const count = ps.income.count + ps.expense.count;
      return `<section class="card" ${lp('bills')}><h2>Plan miesiąca <a href="#budget">Plan ›</a></h2>
        ${count ? `<div class="stat-row">
          <div class="stat"><small>Wpłynęło</small><b class="pos">${money(ps.income.done)}</b><small>z ${esc(formatMoney(ps.income.total))}</small></div>
          <div class="stat"><small>Do zapłaty</small><b class="${ps.expense.left > 0 ? 'neg' : 'pos'}">${money(ps.expense.left)}</b><small>${ps.expense.doneCount}/${ps.expense.count} opłacone</small></div>
          <div class="stat"><small>Zostanie</small><b class="${ps.plannedNet < 0 ? 'neg' : ''}">${money(ps.plannedNet)}</b><small>wg planu</small></div>
        </div>
        ${open.length ? `<p class="small muted" style="margin:10px 0 0">Czeka: ${open.slice(0, 4).map((b) => esc(b.icon || '') + ' ' + esc(b.name)).join(', ')}${open.length > 4 ? '…' : ''}</p>` : ''}`
        : '<p class="muted small">Brak planu na ten miesiąc. <a class="link" href="#budget">Zaplanuj</a></p>'}
      </section>`;
    },

    purchases: () => {
      const prio = { high: 0, mid: 1, low: 2 };
      const list = state.data.purchases.filter((p) => p.status !== 'bought').sort((a, b) => (prio[a.priority] ?? 1) - (prio[b.priority] ?? 1)).slice(0, 3);
      return `<section class="card" ${lp('purchases')}><h2>Do kupienia <a href="#plans" data-action="plans-tab" data-tab2="buy">Plany ›</a></h2>
        ${list.length ? `<ul class="bars">${list.map((p) => {
          const a = analyzePurchase(p, purchaseContext(p));
          return `<li><div class="row"><span>${esc(p.icon || '🛒')} ${esc(p.name)}</span><span class="num">${Math.round(a.progress * 100)}%</span></div>
            <div class="track"><div class="fill" style="width:${(a.progress * 100).toFixed(1)}%"></div></div>
            <div class="small muted">${a.missing === 0 ? 'Masz już całą kwotę' : a.affordYm ? 'Szacunkowo: ' + esc(monthNamePL(a.affordYm).toLowerCase()) : 'brakuje ' + esc(formatMoney(a.missing))}</div></li>`;
        }).join('')}</ul>` : '<p class="muted small">Brak planowanych zakupów.</p>'}</section>`;
    },

    savings: () => {
      const list = state.data.accounts.filter((a) => !a.archived && accountGroup(a) === 'savings' && a.currency === 'PLN');
      let total = 0; let inflow = 0; let outflow = 0;
      for (const a of list) { const m = accountMonth(a, txs, state.month); total += m.after; inflow += m.inflow; outflow += m.outflow; }
      return `<section class="card" ${lp('savings')}><h2>Oszczędności i inwestycje <a href="#wealth">Majątek ›</a></h2>
        <div class="stat-row">
          <div class="stat"><small>Razem</small><b>${money(total)}</b></div>
          <div class="stat"><small>Wpłaty</small><b class="pos">${money(inflow)}</b></div>
          <div class="stat"><small>Wypłaty</small><b class="neg">${money(outflow)}</b></div>
        </div></section>`;
    },

    loans: () => {
      const list = state.data.accounts.filter((a) => !a.archived && a.type === 'loan' && a.currency === 'PLN');
      let before = 0; let paid = 0; let after = 0;
      for (const a of list) { const m = accountMonth(a, txs, state.month); before -= m.before; paid += m.inflow - m.outflow; after -= m.after; }
      return `<section class="card" ${lp('loans')}><h2>Kredyty <a href="#wealth">Majątek ›</a></h2>
        ${list.length ? `<div class="stat-row">
          <div class="stat"><small>Przed</small><b>${money(before)}</b></div>
          <div class="stat"><small>Spłacono</small><b class="pos">${money(paid)}</b></div>
          <div class="stat"><small>Po</small><b>${money(after)}</b></div>
        </div>` : '<p class="muted small">Brak kredytów.</p>'}</section>`;
    },

    categories: () => {
      const byParent = Object.entries(rollupByParent(s.expenseByCategory, state.data.categories))
        .filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
      if (!byParent.length) return `<section class="card" ${lp('categories')}><h2>Na co poszło</h2><p class="muted small">Brak wydatków w tym miesiącu.</p></section>`;
      const max = byParent[0][1];
      return `<section class="card" ${lp('categories')}><h2>Na co poszło <a href="#analytics">Więcej ›</a></h2><ul class="bars">${byParent.slice(0, 6).map(([id, v]) => `
        <li><div class="row"><span>${esc(catIcon(id, cats))} ${esc(catLabel(id, cats))}</span><span class="num">${esc(formatMoney(v))}</span></div>
        <div class="track"><div class="fill" style="width:${Math.max(2, (v / max) * 100).toFixed(1)}%"></div></div></li>`).join('')}</ul></section>`;
    },

    recent: () => {
      const recent = txs.filter((t) => t.date.startsWith(state.month)).sort(byDateDesc).slice(0, 5);
      return `<section class="card" ${lp('recent')}><h2>Ostatnie <a href="#transactions">Wszystkie ›</a></h2>${recent.length
        ? `<div class="list">${recent.map((t) => txRow(t, cats)).join('')}</div>`
        : '<p class="muted small">Brak transakcji w tym miesiącu.</p>'}</section>`;
    },
  };

  const ids = visibleCards(state.layout);
  for (const id of ids) parts.push(cards[id]());
  if (!ids.length) parts.push('<div class="empty"><span class="em">🧩</span>Wszystkie karty są ukryte.<br><br><button class="btn primary" data-action="dash-layout">Ułóż stronę startową</button></div>');

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

// ---------- Plan miesiąca: wpływy i „Do zapłaty” ----------
function billsOfMonth(ym = state.month, kind = null) {
  return state.data.bills
    .filter((b) => b.month === ym && (!kind || kindOf(b) === kind))
    .sort((a, b) => (a.day || 99) - (b.day || 99) || (a.order || 0) - (b.order || 0) || (a.createdAt || '').localeCompare(b.createdAt || ''));
}
const autoTxOn = () => getPref('sf-autotx', '1') === '1';

function defaultAccountId() {
  const active = activeAccounts().filter((a) => accountGroup(a) === 'current');
  return (active.find((a) => a.id === state.prefs.defaultAccount) || active.find((a) => a.type === 'checking') || active[0])?.id || null;
}

function planRow(b) {
  const inc = kindOf(b) === 'income';
  const linked = b.txId && state.data.transactions.some((t) => t.id === b.txId && !t.deletedAt);
  const doneLabel = inc ? 'Wpłynęło' : 'Zapłacone';
  const openLabel = inc ? 'Jeszcze nie wpłynęło' : 'Niezapłacone';
  return `<div class="item bill ${b.paid ? 'is-paid' : ''}" data-lp="bill:${esc(b.id)}">
    <button class="bill-main" data-action="edit-bill" data-id="${esc(b.id)}">
      <span class="ico" aria-hidden="true">${esc(b.icon || (inc ? '💰' : '📄'))}</span>
      <span class="mid"><span class="t1">${esc(b.name)}${linked ? '<span class="badge">w transakcjach</span>' : ''}</span>
      <span class="t2"><span class="num ${inc ? 'pos' : ''}">${inc ? '+' : ''}${esc(formatMoney(b.amount))}</span>${b.day ? ` · ${b.day}. dnia` : ''}${b.note ? ' · ' + esc(b.note) : ''}</span></span>
    </button>
    <button class="paybtn ${b.paid ? 'paid' : 'unpaid'}" data-action="toggle-bill" data-id="${esc(b.id)}"
      aria-label="${b.paid ? doneLabel : openLabel} — dotknij, aby zmienić">${b.paid ? '✓' : '✕'}</button>
  </div>`;
}
const billRow = planRow;

function viewBudget() {
  const ym = state.month;
  const s = planSummary(state.data.bills, ym);
  const incomes = billsOfMonth(ym, 'income');
  const expenses = billsOfMonth(ym, 'expense');
  const prevYm = addMonths(ym, -1);
  const toCopy = planToCopy(state.data.bills, prevYm, ym);
  const monthWord = esc(monthNamePL(ym).toLowerCase());
  const section = (kind, list, title, sumDone, sumTotal) => `
    <div class="sec-head"><h2>${title}</h2><span class="small muted num">${esc(formatMoney(sumDone))} z ${esc(formatMoney(sumTotal))}</span></div>
    ${list.length ? `<div class="list">${list.map(planRow).join('')}</div>` : `<p class="muted small" style="margin:0 4px">${kind === 'income' ? 'Dodaj pensję, świadczenia i inne wpływy.' : 'Dodaj rachunki i opłaty.'}</p>`}
    <button class="btn block" style="margin-top:8px" data-action="add-bill" data-kind="${kind}">+ ${kind === 'income' ? 'Dodaj wpływ' : 'Dodaj do zapłaty'}</button>`;
  return `<section class="card hero">
      <h2>Plan: ${monthWord}</h2>
      <div class="big num">${esc(formatMoney(s.plannedNet, 'PLN', { sign: true }))}</div>
      <div class="split">
        <div><small>Wpływy</small><b class="num">${esc(formatMoney(s.income.total))}</b><small>wpłynęło ${s.income.doneCount}/${s.income.count}</small></div>
        <div><small>Do zapłaty</small><b class="num">${esc(formatMoney(s.expense.total))}</b><small>zostało <span class="num">${esc(formatMoney(s.expense.left))}</span></small></div>
      </div>
      <div class="foot">Tyle zostanie po planowanych opłatach. Na dziś: <b class="num">${esc(formatMoney(s.doneNet, 'PLN', { sign: true }))}</b></div>
    </section>
    ${toCopy.length ? `<button class="btn primary block" data-action="copy-bills">⧉ Skopiuj z: ${esc(monthNamePL(prevYm).toLowerCase())} (${toCopy.length})</button>` : ''}
    ${section('income', incomes, 'Wpływy', s.income.done, s.income.total)}
    ${section('expense', expenses, 'Do zapłaty', s.expense.done, s.expense.total)}
    <p class="note">Dotknij ✕ / ✓, żeby zmienić status${autoTxOn() ? ' — odhaczenie od razu dodaje transakcję (przychód lub wydatek), odznaczenie ją usuwa' : ''}. Nazwa miesiąca u góry otwiera kalendarz, strzałki przenoszą na kolejny miesiąc.</p>`;
}

/** Tworzy, aktualizuje albo usuwa transakcję powiązaną z pozycją planu. Zwraca nowe txId. */
async function syncPlanTx(item) {
  const linked = item.txId ? state.data.transactions.find((t) => t.id === item.txId && !t.deletedAt) : null;
  const kind = kindOf(item);
  const categoryId = item.categoryId
    || guessCategory(item.name, state.data.categories, state.data.transactions, kind)
    || (kind === 'income' ? 'inc-other' : 'exp-other');
  if (item.paid) {
    if (linked) {
      const upd = { ...linked, type: kind, amount: item.amount, description: item.name, categoryId, updatedAt: new Date().toISOString() };
      if (item.accountId) upd.accountId = item.accountId;
      if (!validateTransaction(upd, state.data).length) await db.put('transactions', upd);
      return linked.id;
    }
    if (!autoTxOn()) return null;
    const now = new Date().toISOString();
    const t = {
      id: db.newId('tx'), createdAt: now, updatedAt: now,
      ...autoTransaction({ ...item, categoryId }, { today: todayISO(), accountId: defaultAccountId(), fallbackCategory: categoryId }),
    };
    const errors = validateTransaction(t, state.data);
    if (errors.length) { toast('Nie dodano transakcji: ' + errors.join(', ')); return null; }
    await db.put('transactions', t);
    return t.id;
  }
  if (linked) await db.put('transactions', { ...linked, deletedAt: new Date().toISOString() });
  return null;
}

function openBillSheet(id, kindArg) {
  const b = id ? state.data.bills.find((x) => x.id === id) : null;
  let kind = b ? kindOf(b) : (kindArg === 'income' ? 'income' : 'expense');
  let categoryId = b?.categoryId || null;
  let icon = b?.icon || null;
  let iconCustom = !!b?.icon;
  const accs = activeAccounts().filter((a) => accountGroup(a) === 'current');
  openSheet(b ? 'Edytuj pozycję planu' : `Plan: ${monthNamePL(state.month).toLowerCase()}`, `
    ${b ? '' : `<div class="seg" id="bl-kind"><button type="button" data-kind="income">Wpływ</button><button type="button" data-kind="expense">Do zapłaty</button></div>`}
    <label class="field"><span id="bl-name-label">Opis</span><input id="bl-name" maxlength="80" value="${esc(b?.name || '')}" autocomplete="off"></label>
    <label class="field"><span>Kwota</span><input id="bl-amount" class="amount-input" inputmode="decimal" placeholder="0,00" value="${b ? esc(minorToInput(b.amount)) : ''}" autocomplete="off"></label>
    <div class="field"><span id="bl-cat-label">Rodzaj</span><div class="catgrid" id="bl-cats"></div></div>
    <div class="grid2">
      <label class="field"><span>Dzień miesiąca (opcj.)</span><input id="bl-day" type="number" inputmode="numeric" min="1" max="31" placeholder="np. 10" value="${b?.day || ''}"></label>
      <label class="field"><span>Konto</span><select id="bl-acc"><option value="">Domyślne</option>${accs.map((a) => `<option value="${esc(a.id)}" ${b?.accountId === a.id ? 'selected' : ''}>${esc(a.name)}</option>`).join('')}</select></label>
    </div>
    <details class="more" ${b?.note || (b?.icon && kind === 'expense') ? 'open' : ''}><summary>Ikona i notatka</summary>
      <div class="field"><span>Ikona</span><div class="icongrid" id="bl-icons">${BILL_ICONS.map((i) => `<button type="button" data-icon="${i}">${i}</button>`).join('')}</div>
        <input id="bl-icon-custom" maxlength="4" placeholder="lub wpisz własne emoji" value="${b?.icon && !BILL_ICONS.includes(b.icon) ? esc(b.icon) : ''}"></div>
      <label class="field"><span>Notatka</span><input id="bl-note" maxlength="80" value="${esc(b?.note || '')}" placeholder="np. termin, nr umowy"></label>
    </details>
    <label class="check"><input type="checkbox" id="bl-paid" ${b?.paid ? 'checked' : ''}> <span id="bl-paid-label"></span></label>
    <div class="err" id="bl-err" role="alert"></div>
    <div class="actions ${b ? 'two' : ''}">
      ${b ? '<button class="btn danger" id="bl-del">Usuń</button>' : ''}
      <button class="btn primary block" id="bl-save">${b ? 'Zapisz' : 'Dodaj'}</button>
    </div>`);
  const sheet = $('#sheet');
  const cats = () => state.data.categories.filter((c) => c.kind === kind && (!c.archived || c.id === categoryId));
  const paintIcons = () => sheet.querySelectorAll('#bl-icons [data-icon]').forEach((x) => x.setAttribute('aria-pressed', String(x.dataset.icon === icon)));
  const paint = () => {
    sheet.querySelectorAll('#bl-kind [data-kind]').forEach((x) => x.setAttribute('aria-pressed', String(x.dataset.kind === kind)));
    $('#bl-name-label').textContent = kind === 'income' ? 'Opis wpływu' : 'Co trzeba zapłacić';
    $('#bl-name').placeholder = kind === 'income' ? 'np. Pensja Ani, 800+ Zosia' : 'np. Czynsz, Prąd, Przedszkole';
    $('#bl-cat-label').textContent = kind === 'income' ? 'Rodzaj wpływu' : 'Kategoria (do transakcji)';
    $('#bl-paid-label').textContent = kind === 'income' ? 'Już wpłynęło' : 'Już zapłacone';
    if (categoryId && !cats().some((c) => c.id === categoryId)) categoryId = null;
    $('#bl-cats').innerHTML = cats().map((c) => `<button type="button" class="cat" data-cat="${esc(c.id)}" aria-pressed="${c.id === categoryId}"><b>${esc(c.icon || '•')}</b>${esc(c.name)}</button>`).join('');
    paintIcons();
  };
  paint();
  $('#bl-kind') && ($('#bl-kind').onclick = (e) => {
    const x = e.target.closest('[data-kind]');
    if (!x) return;
    kind = x.dataset.kind;
    if (!iconCustom) icon = null;
    paint();
  });
  $('#bl-cats').onclick = (e) => {
    const x = e.target.closest('[data-cat]');
    if (!x) return;
    categoryId = x.dataset.cat;
    if (!iconCustom) icon = catById()[categoryId]?.icon || null;
    paint();
  };
  $('#bl-icons').onclick = (e) => {
    const x = e.target.closest('[data-icon]');
    if (!x) return;
    icon = x.dataset.icon;
    iconCustom = true;
    $('#bl-icon-custom').value = '';
    paintIcons();
  };
  $('#bl-name').onchange = () => {
    if (categoryId) return;
    const g = guessCategory($('#bl-name').value, state.data.categories, state.data.transactions, kind);
    if (g) { categoryId = g; if (!iconCustom) icon = catById()[g]?.icon || null; paint(); }
  };
  if (!b) focusLater('#bl-name');
  $('#bl-save').onclick = async () => {
    const dayRaw = $('#bl-day').value.trim();
    const custom = $('#bl-icon-custom').value.trim();
    const item = {
      ...(b || { id: db.newId('bill'), month: state.month, createdAt: new Date().toISOString(), order: Date.now(), txId: null }),
      kind,
      name: $('#bl-name').value.trim(),
      amount: toMinor($('#bl-amount').value),
      categoryId,
      icon: custom || icon || catById()[categoryId]?.icon || (kind === 'income' ? '💰' : '📄'),
      day: dayRaw ? Number(dayRaw) : null,
      accountId: $('#bl-acc').value || null,
      note: $('#bl-note').value.trim(),
      paid: $('#bl-paid').checked,
    };
    item.paidAt = item.paid ? (b?.paidAt || new Date().toISOString()) : null;
    const errors = validateBill(item);
    if (errors.length) { $('#bl-err').textContent = errors.join(' · '); return; }
    item.txId = await syncPlanTx(item);
    await db.put('bills', item);
    closeSheet();
    await reload();
    toast(b ? 'Zapisano' : 'Dodano do planu');
  };
  if (b) $('#bl-del').onclick = () => { closeSheet(); deleteBill(b.id); };
}

async function toggleBill(id) {
  const b = state.data.bills.find((x) => x.id === id);
  if (!b) return;
  const item = { ...b, paid: !b.paid, paidAt: !b.paid ? new Date().toISOString() : null };
  const hadTx = b.txId && state.data.transactions.some((t) => t.id === b.txId && !t.deletedAt);
  item.txId = await syncPlanTx(item);
  await db.put('bills', item);
  await reload();
  if (item.paid && item.txId && !hadTx) toast(`Dodano ${kindOf(item) === 'income' ? 'przychód' : 'wydatek'}: ${formatMoney(item.amount)}`);
  else if (!item.paid && hadTx) toast('Usunięto też powiązaną transakcję (jest w koszu)');
}

/** Kopiowanie z poprzedniego miesiąca z podglądem: odznacz zbędne, popraw kwoty. */
function openCopySheet() {
  const fromYm = addMonths(state.month, -1);
  const items = planToCopy(state.data.bills, fromYm, state.month);
  const row = (b, i) => `<div class="copy-row">
    <label><input type="checkbox" data-copy="${i}" checked> <span>${esc(b.icon || '')} ${esc(b.name)}${b.day ? `<small class="muted"> · ${b.day}.</small>` : ''}</span></label>
    <input class="copy-amt" data-amt="${i}" inputmode="decimal" value="${esc(minorToInput(b.amount))}" aria-label="Kwota: ${esc(b.name)}">
  </div>`;
  const group = (kind, title) => {
    const list = items.map((b, i) => [b, i]).filter(([b]) => b.kind === kind);
    return list.length ? `<h3 class="copy-h">${title}</h3>${list.map(([b, i]) => row(b, i)).join('')}` : '';
  };
  openSheet(`Kopiuj z: ${monthNamePL(fromYm).toLowerCase()}`, `
    <p class="small muted" style="margin-top:0">Odznacz, czego w tym miesiącu nie będzie, i popraw kwoty, które się zmieniły. Wszystko trafi jako niezrealizowane.</p>
    ${group('income', 'Wpływy')}${group('expense', 'Do zapłaty')}
    <div class="err" id="cp-err" role="alert"></div>
    <div class="actions"><button class="btn primary block" id="cp-save">Skopiuj zaznaczone</button></div>`);
  const count = () => $('#sheet').querySelectorAll('[data-copy]:checked').length;
  const label = () => { $('#cp-save').textContent = `Skopiuj zaznaczone (${count()})`; $('#cp-save').disabled = !count(); };
  label();
  $('#sheet').querySelectorAll('[data-copy]').forEach((c) => { c.onchange = label; });
  $('#cp-save').onclick = async () => {
    const now = Date.now();
    const out = [];
    for (const c of $('#sheet').querySelectorAll('[data-copy]:checked')) {
      const i = Number(c.dataset.copy);
      const amount = toMinor($(`[data-amt="${i}"]`).value);
      const { sourceId, ...base } = items[i];
      const item = { ...base, amount, id: db.newId('bill'), createdAt: new Date().toISOString(), order: now + i };
      const errors = validateBill(item);
      if (errors.length) { $('#cp-err').textContent = `${items[i].name}: ${errors.join(', ')}`; return; }
      out.push(item);
    }
    await db.put('bills', ...out);
    closeSheet();
    await reload();
    toast(`Skopiowano ${out.length} pozycji`);
  };
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
    return `<section class="acard" data-lp="acc:${esc(a.id)}">
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
    return `<section class="acard" data-lp="acc:${esc(a.id)}">
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
    <div class="list">${current.map((a) => `<button class="item" data-action="account-detail" data-id="${esc(a.id)}" data-lp="acc:${esc(a.id)}">
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
  focusLater('#mv-amount');
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

// ---------- Kalendarz ----------
const cal = { tab: 'month', year: null, day: null };

function openCalendar() {
  cal.tab = 'month';
  cal.year = Number(state.month.slice(0, 4));
  cal.day = null;
  openSheet('Kalendarz', '<div id="cal"></div>');
  paintCalendar();
}

function paintCalendar() {
  const box = $('#cal');
  if (!box) return;
  const today = todayISO();
  const seg = `<div class="seg"><button type="button" data-cal="tab" data-v="month" aria-pressed="${cal.tab === 'month'}">Miesiąc</button>
    <button type="button" data-cal="tab" data-v="year" aria-pressed="${cal.tab === 'year'}">Rok</button></div>`;
  let html = seg;
  if (cal.tab === 'year') {
    const tiles = yearTiles(liveTx(), state.data.bills, cal.year);
    html += `<div class="cal-nav"><button class="icon-btn" data-cal="year" data-v="-1" aria-label="Poprzedni rok">‹</button><b>${cal.year}</b>
      <button class="icon-btn" data-cal="year" data-v="1" aria-label="Następny rok">›</button></div>
      <div class="year-grid">${tiles.map((t) => {
        const v = t.source === 'actual' ? t.actual : t.plan;
        return `<button type="button" class="ytile ${t.ym === state.month ? 'sel' : ''} ${t.ym === monthKey(today) ? 'now' : ''}" data-cal="pick" data-v="${t.ym}">
          <span class="ym">${esc(monthShortPL(t.ym))}</span>
          <b class="num ${v == null ? 'muted' : v >= 0 ? 'pos' : 'neg'}">${v == null ? '—' : esc(formatMoney(v, 'PLN', { sign: true }).replace(/,\d\d/, ''))}</b>
          <small>${t.source === 'plan' ? 'plan' : t.source === 'actual' ? 'bilans' : ''}</small></button>`;
      }).join('')}</div>
      <p class="small muted">Bilans = z transakcji. „plan” = wpływy minus opłaty z planu (miesiąc bez transakcji). Dotknij miesiąca, żeby go otworzyć.</p>`;
  } else {
    const ym = state.month;
    const marks = dayMarks(liveTx(), state.data.bills, ym);
    const s = monthSummary(liveTx(), ym);
    const p = planSummary(state.data.bills, ym);
    html += `<div class="cal-nav"><button class="icon-btn" data-cal="month" data-v="-1" aria-label="Poprzedni miesiąc">‹</button><b>${esc(monthNamePL(ym))}</b>
      <button class="icon-btn" data-cal="month" data-v="1" aria-label="Następny miesiąc">›</button></div>
      <div class="cal-grid">${WEEKDAYS_SHORT.map((d) => `<span class="wd">${d}</span>`).join('')}
      ${calendarGrid(ym).flat().map((iso) => {
        if (!iso) return '<span></span>';
        const m = marks[iso];
        const dots = m ? `<i class="dots">${m.income || m.planIncome ? '<i class="d inc"></i>' : ''}${m.expense || m.planExpense ? '<i class="d exp"></i>' : ''}${m.planOpen ? '<i class="d open"></i>' : ''}</i>` : '';
        return `<button type="button" class="day-cell ${iso === today ? 'today' : ''} ${iso === cal.day ? 'sel' : ''}" data-cal="day" data-v="${iso}">${Number(iso.slice(8))}${dots}</button>`;
      }).join('')}</div>
      <div class="legend small"><span><i class="d inc"></i>wpływ</span><span><i class="d exp"></i>wydatek</span><span><i class="d open"></i>do zrobienia</span></div>
      <div class="stat-row" style="grid-template-columns:1fr 1fr;margin-top:10px">
        <div class="stat"><small>Bilans (transakcje)</small><b class="${s.net < 0 ? 'neg' : 'pos'}">${money(s.net, 'PLN', { sign: true })}</b></div>
        <div class="stat"><small>Plan (wpływy − opłaty)</small><b class="${p.plannedNet < 0 ? 'neg' : ''}">${money(p.plannedNet, 'PLN', { sign: true })}</b></div>
      </div>
      <div id="cal-day">${cal.day ? dayDetails(cal.day) : '<p class="small muted">Dotknij dnia, żeby zobaczyć szczegóły.</p>'}</div>
      <div class="actions two"><button class="btn" data-cal="today">Dziś</button><button class="btn primary" data-cal="plan">Zaplanuj miesiąc ›</button></div>`;
  }
  box.innerHTML = html;
  box.onclick = (e) => {
    const b = e.target.closest('[data-cal]');
    if (!b) return;
    const v = b.dataset.v;
    switch (b.dataset.cal) {
      case 'tab': cal.tab = v; break;
      case 'year': cal.year += Number(v); break;
      case 'pick': state.month = v; cal.tab = 'month'; cal.day = null; render(); break;
      case 'month': state.month = addMonths(state.month, Number(v)); cal.day = null; cal.year = Number(state.month.slice(0, 4)); render(); break;
      case 'day': cal.day = cal.day === v ? null : v; break;
      case 'today': state.month = monthKey(today); cal.day = today; cal.year = Number(today.slice(0, 4)); render(); break;
      case 'plan': closeSheet(); location.hash = '#budget'; return;
      default: return;
    }
    paintCalendar();
  };
}

function dayDetails(iso) {
  const cats = catById();
  const txs = liveTx().filter((t) => t.date === iso).sort(byDateDesc);
  const plan = state.data.bills.filter((b) => b.month === iso.slice(0, 7) && b.day && dateInMonth(b.month, b.day) === iso);
  return `<h3 class="copy-h">${esc(dayLabelPL(iso))}</h3>
    ${plan.length ? `<div class="list">${plan.map(planRow).join('')}</div>` : ''}
    ${txs.length ? `<div class="list" style="margin-top:8px">${txs.map((t) => txRow(t, cats)).join('')}</div>` : ''}
    ${!plan.length && !txs.length ? '<p class="small muted">Nic tego dnia.</p>' : ''}`;
}

// ---------- Plany: Do kupienia · Analiza · Asystent AI ----------
const ai = { history: [], busy: false, error: '' };

function viewPlans() {
  const tab = state.plansTab || 'buy';
  const t = (id, label) => `<button type="button" data-action="plans-tab" data-tab2="${id}" aria-pressed="${tab === id}">${label}</button>`;
  const body = tab === 'analysis' ? viewAnalytics() : tab === 'ai' ? viewAI() : viewPurchases();
  return `<div class="seg plans-seg">${t('buy', '🛒 Do kupienia')}${t('analysis', '📊 Analiza')}${t('ai', '✨ AI')}</div>${body}`;
}

function purchaseContext(p) {
  const txs = liveTx();
  const bal = balances(state.data.accounts, txs);
  const savings = state.data.accounts.filter((a) => !a.archived && accountGroup(a) === 'savings' && a.currency === 'PLN');
  const avg = averages(txs, addMonths(monthKey(todayISO()), -1), 3);
  const linked = p.accountId ? state.data.accounts.find((a) => a.id === p.accountId) : null;
  return {
    saved: linked ? bal[linked.id] : (p.savedManual || 0),
    savedSource: linked ? linked.name : 'wpisane ręcznie',
    avgNet: avg.net, avgExpense: avg.expense, avgIncome: avg.income, avgMonths: avg.months,
    savingsTotal: savings.reduce((s, a) => s + bal[a.id], 0),
    currentYm: monthKey(todayISO()),
  };
}

function viewPurchases() {
  const showBought = state.buyFilter === 'bought';
  const prio = { high: 0, mid: 1, low: 2 };
  const list = state.data.purchases
    .filter((p) => (showBought ? p.status === 'bought' : p.status !== 'bought'))
    .sort((a, b) => (prio[a.priority] ?? 1) - (prio[b.priority] ?? 1) || (a.targetYm || '9999').localeCompare(b.targetYm || '9999'));
  const active = state.data.purchases.filter((p) => p.status !== 'bought');
  let totalPrice = 0; let totalSaved = 0;
  for (const p of active) { const a = analyzePurchase(p, purchaseContext(p)); totalPrice += a.price; totalSaved += a.saved; }
  const chip = (id, label) => `<button class="chip" data-action="buy-filter" data-f="${id}" aria-pressed="${(state.buyFilter || 'active') === id}">${label}</button>`;
  return `${active.length ? `<section class="card"><h2>Plany zakupów</h2><div class="stat-row">
      <div class="stat"><small>Razem</small><b>${money(totalPrice)}</b></div>
      <div class="stat"><small>Zgromadzone</small><b class="pos">${money(totalSaved)}</b></div>
      <div class="stat"><small>Brakuje</small><b>${money(totalPrice - totalSaved)}</b></div></div></section>` : ''}
    <div class="chips">${chip('active', 'Planowane')}${chip('bought', 'Kupione')}</div>
    ${list.length ? list.map(purchaseCard).join('') : `<div class="empty"><span class="em">🛒</span>${showBought ? 'Nic jeszcze nie kupiono.' : 'Dodaj większy zakup: auto, fotowoltaikę, remont…'}</div>`}
    <button class="btn primary block" data-action="add-purchase">+ Dodaj do kupienia</button>`;
}

function purchaseCard(p) {
  const a = analyzePurchase(p, purchaseContext(p));
  let when = '';
  if (p.status === 'bought') when = `Kupione${p.boughtAt ? ' ' + esc(formatDatePL(p.boughtAt.slice(0, 10))) : ''}`;
  else if (a.missing === 0) when = '<span class="pos">Masz już całą kwotę</span>';
  else if (p.targetYm) when = `Cel: ${esc(monthNamePL(p.targetYm).toLowerCase())} · potrzeba <span class="num">${esc(formatMoney(a.requiredMonthly || 0))}</span>/mies. ${a.onTrack ? '<span class="pos">✓ realne</span>' : '<span class="neg">⚠ za mało</span>'}`;
  else if (a.affordYm) when = `Szacunkowo: ${esc(monthNamePL(a.affordYm).toLowerCase())}`;
  else when = '<span class="muted">Brak nadwyżki do oszacowania terminu</span>';
  return `<section class="acard" data-lp="buy:${esc(p.id)}">
    <button class="acard-head" data-action="purchase-detail" data-id="${esc(p.id)}">
      <span class="ico">${esc(p.icon || '🛒')}</span>
      <span class="mid"><span class="t1">${esc(p.name)} <span class="badge prio-${esc(p.priority || 'mid')}">${esc(PRIORITIES[p.priority] || 'Średni')}</span></span>
      <span class="t2">${esc(STATUSES[p.status] || 'Pomysł')}${p.notes ? ' · ' + esc(p.notes) : ''}</span></span>
      <span class="amt num">${esc(formatMoney(a.price))}</span>
    </button>
    <div class="track"><div class="fill" style="width:${(a.progress * 100).toFixed(1)}%"></div></div>
    <div class="small muted" style="margin-top:6px"><span class="num">${esc(formatMoney(a.saved))}</span> z <span class="num">${esc(formatMoney(a.price))}</span> (${Math.round(a.progress * 100)}%) · ${when}</div>
  </section>`;
}

function openPurchaseDetail(id) {
  const p = state.data.purchases.find((x) => x.id === id);
  if (!p) return;
  const c = purchaseContext(p);
  const a = analyzePurchase(p, c);
  const m = (v) => `<b class="num">${esc(formatMoney(v))}</b>`;
  const months = (n) => (n == null ? '—' : n === 0 ? 'teraz' : `${n} mies.`);
  const facts = [
    ['Cena', m(a.price)],
    [`Zgromadzone (${esc(c.savedSource)})`, m(a.saved)],
    ['Brakuje', m(a.missing)],
    [`Średnia nadwyżka (${c.avgMonths || 0} ost. mies.)`, c.avgMonths ? m(c.avgNet) : 'brak danych'],
    ['Średnie wydatki miesięczne', c.avgMonths ? m(c.avgExpense) : 'brak danych'],
    ['Wszystkie oszczędności', m(c.savingsTotal)],
  ];
  const est = [];
  if (a.missing > 0) {
    est.push(['Kiedy Cię stać', a.affordYm ? `<b>${esc(monthNamePL(a.affordYm))}</b> (${months(a.monthsToAfford)})` : 'nie da się oszacować — brak nadwyżki']);
  }
  if (p.targetYm) {
    est.push([`Do terminu (${esc(monthNamePL(p.targetYm).toLowerCase())})`, a.monthsToTarget > 0 ? `${a.monthsToTarget} mies.` : 'termin minął']);
    if (a.missing > 0) est.push(['Potrzebna wpłata miesięcznie', a.requiredMonthly ? `${m(a.requiredMonthly)} ${a.onTrack ? '<span class="pos">✓ realne przy obecnym tempie</span>' : '<span class="neg">⚠ więcej niż obecne tempo</span>'}` : '—']);
  }
  if (a.cushionBefore != null) {
    est.push(['Poduszka bezpieczeństwa', `${dec1(a.cushionBefore)} → <b class="${a.cushionAfter < 3 ? 'neg' : ''}">${dec1(a.cushionAfter)}</b> mies. wydatków po zakupie za gotówkę`]);
  }
  if (a.loan) {
    est.push(['Kredyt: rata', m(a.loan.installment) + (a.loan.incomeShare != null ? ` (${Math.round(a.loan.incomeShare * 100)}% średniego dochodu)` : '')]);
    est.push(['Kredyt: odsetki łącznie', m(a.loan.interest)]);
    est.push(['Kredyt: całkowity koszt', m(a.loan.total + (p.loanOwn || 0))]);
  }
  if (a.payback) est.push(['Zwrot inwestycji', `ok. <b>${dec1(a.payback.years)} lat</b> (${a.payback.months} mies.)`]);
  const assumptions = [
    a.paceSource === 'plan' ? `Tempo odkładania: Twoja planowana wpłata ${formatMoney(p.monthlySaving)}/mies.` : a.paceSource === 'average' ? `Tempo odkładania: średnia nadwyżka z ostatnich ${c.avgMonths} mies. (${formatMoney(a.pace)}/mies.), zakładając, że się utrzyma.` : 'Brak dodatniej nadwyżki — terminu nie da się oszacować.',
    a.loan ? `Kredyt: rata równa, ${String(p.loanRate).replace('.', ',')}% rocznie, ${p.loanMonths} mies., wkład własny ${formatMoney(p.loanOwn || 0)}; bez prowizji i ubezpieczeń.` : '',
    a.payback ? `Zwrot: stała korzyść ${formatMoney(p.monthlyBenefit)}/mies., bez inflacji, zmian cen i kosztów serwisu.` : '',
    'Ceny i stopy procentowe mogą się zmienić — to szacunek, nie gwarancja.',
  ].filter(Boolean);
  const rows = (list) => `<ul class="menu kv">${list.map(([k, v]) => `<li><div><span>${k}</span><span>${v}</span></div></li>`).join('')}</ul>`;
  openSheet(`${p.icon || '🛒'} ${p.name}`, `
    <div class="track" style="margin:4px 0 6px"><div class="fill" style="width:${(a.progress * 100).toFixed(1)}%"></div></div>
    <p class="small muted" style="margin:0 0 8px">${Math.round(a.progress * 100)}% · ${esc(STATUSES[p.status] || '')} · priorytet ${esc((PRIORITIES[p.priority] || '').toLowerCase())}</p>
    <h3 class="copy-h">📌 Dane rzeczywiste</h3>${rows(facts)}
    ${est.length ? `<h3 class="copy-h">📈 Szacunki</h3>${rows(est)}` : ''}
    <h3 class="copy-h">⚙️ Założenia</h3><ul class="small muted assump">${assumptions.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>
    ${p.notes ? `<p class="note">${esc(p.notes)}</p>` : ''}
    <div class="actions">
      <button class="btn primary block" data-action="ai-purchase" data-id="${esc(p.id)}">✨ Zapytaj AI o ten zakup</button>
      <div class="grid2"><button class="btn" data-action="edit-purchase" data-id="${esc(p.id)}">Edytuj</button>
      <button class="btn" data-action="buy-done" data-id="${esc(p.id)}" data-close="1">${p.status === 'bought' ? 'Przywróć do planów' : 'Kupione ✓'}</button></div>
    </div>`);
}

function openPurchaseSheet(id) {
  const p = id ? state.data.purchases.find((x) => x.id === id) : null;
  let icon = p?.icon || PURCHASE_ICONS[0];
  let priority = p?.priority || 'mid';
  let status = p?.status || 'idea';
  const savingsAccs = state.data.accounts.filter((a) => !a.archived && accountGroup(a) === 'savings');
  const mi = (v) => (v ? esc(minorToInput(v)) : '');
  const seg = (name, items, cur) => `<div class="seg" data-seg="${name}">${Object.entries(items).map(([k, v]) => `<button type="button" data-v="${k}" aria-pressed="${k === cur}">${esc(v)}</button>`).join('')}</div>`;
  openSheet(p ? 'Edytuj zakup' : 'Do kupienia', `
    <label class="field"><span>Co chcesz kupić</span><input id="pu-name" maxlength="60" value="${esc(p?.name || '')}" placeholder="np. Auto, Fotowoltaika, Kuchnia"></label>
    <div class="field"><span>Ikona</span><div class="icongrid" id="pu-icons">${PURCHASE_ICONS.map((i) => `<button type="button" data-icon="${i}" aria-pressed="${i === icon}">${i}</button>`).join('')}</div></div>
    <label class="field"><span>Cena</span><input id="pu-price" class="amount-input" inputmode="decimal" placeholder="0,00" value="${mi(p?.price)}"></label>
    <div class="field"><span>Priorytet</span>${seg('prio', PRIORITIES, priority)}</div>
    <div class="field"><span>Status</span>${seg('status', STATUSES, status)}</div>
    <div class="grid2">
      <label class="field"><span>Planowany termin</span><input id="pu-target" type="month" value="${esc(p?.targetYm || '')}"></label>
      <label class="field"><span>Odkładam miesięcznie</span><input id="pu-monthly" inputmode="decimal" placeholder="opcjonalnie" value="${mi(p?.monthlySaving)}"></label>
    </div>
    <label class="field"><span>Skąd liczyć zgromadzone pieniądze</span><select id="pu-acc">
      <option value="">Wpiszę ręcznie</option>
      ${savingsAccs.map((a) => `<option value="${esc(a.id)}" ${p?.accountId === a.id ? 'selected' : ''}>Konto: ${esc(a.name)}</option>`).join('')}</select></label>
    <label class="field" id="pu-saved-wrap"><span>Zgromadzone</span><input id="pu-saved" inputmode="decimal" placeholder="0,00" value="${mi(p?.savedManual)}"></label>
    <details class="more" ${p?.loanMonths ? 'open' : ''}><summary>Porównanie z kredytem / leasingiem</summary>
      <div class="grid2">
        <label class="field"><span>Oprocentowanie % rocznie</span><input id="pu-rate" inputmode="decimal" placeholder="np. 9,5" value="${p?.loanRate != null ? esc(String(p.loanRate).replace('.', ',')) : ''}"></label>
        <label class="field"><span>Okres (miesiące)</span><input id="pu-months" type="number" inputmode="numeric" placeholder="np. 60" value="${p?.loanMonths || ''}"></label>
      </div>
      <label class="field"><span>Wkład własny</span><input id="pu-own" inputmode="decimal" placeholder="0,00" value="${mi(p?.loanOwn)}"></label>
    </details>
    <details class="more" ${p?.monthlyBenefit ? 'open' : ''}><summary>Inwestycja, która się zwraca (np. fotowoltaika)</summary>
      <label class="field"><span>Miesięczna oszczędność / zysk</span><input id="pu-benefit" inputmode="decimal" placeholder="np. 350" value="${mi(p?.monthlyBenefit)}"></label>
    </details>
    <label class="field"><span>Notatki</span><input id="pu-notes" maxlength="200" value="${esc(p?.notes || '')}" placeholder="np. oferty, model, link"></label>
    <div class="err" id="pu-err" role="alert"></div>
    <div class="actions ${p ? 'two' : ''}">${p ? '<button class="btn danger" id="pu-del">Usuń</button>' : ''}<button class="btn primary block" id="pu-save">Zapisz</button></div>`);
  const sheet = $('#sheet');
  const paintSaved = () => { $('#pu-saved-wrap').hidden = !!$('#pu-acc').value; };
  paintSaved();
  $('#pu-acc').onchange = paintSaved;
  $('#pu-icons').onclick = (e) => {
    const x = e.target.closest('[data-icon]');
    if (!x) return;
    icon = x.dataset.icon;
    sheet.querySelectorAll('#pu-icons [data-icon]').forEach((y) => y.setAttribute('aria-pressed', String(y === x)));
  };
  sheet.querySelectorAll('[data-seg]').forEach((sg) => {
    sg.onclick = (e) => {
      const x = e.target.closest('[data-v]');
      if (!x) return;
      if (sg.dataset.seg === 'prio') priority = x.dataset.v; else status = x.dataset.v;
      sg.querySelectorAll('[data-v]').forEach((y) => y.setAttribute('aria-pressed', String(y === x)));
    };
  });
  const optMoney = (sel) => ($(sel).value.trim() ? toMinor($(sel).value) : null);
  $('#pu-save').onclick = async () => {
    const rateRaw = $('#pu-rate').value.trim().replace(',', '.');
    const monthsRaw = $('#pu-months').value.trim();
    const item = {
      ...(p || { id: db.newId('buy'), createdAt: new Date().toISOString() }),
      name: $('#pu-name').value.trim(), icon, priority, status,
      price: toMinor($('#pu-price').value),
      targetYm: $('#pu-target').value || null,
      monthlySaving: optMoney('#pu-monthly'),
      accountId: $('#pu-acc').value || null,
      savedManual: $('#pu-acc').value ? null : optMoney('#pu-saved'),
      loanRate: rateRaw ? Number(rateRaw) : null,
      loanMonths: monthsRaw ? Number(monthsRaw) : null,
      loanOwn: optMoney('#pu-own'),
      monthlyBenefit: optMoney('#pu-benefit'),
      notes: $('#pu-notes').value.trim(),
      updatedAt: new Date().toISOString(),
    };
    if (status === 'bought' && !item.boughtAt) item.boughtAt = new Date().toISOString();
    if (status !== 'bought') item.boughtAt = null;
    const errors = validatePurchase(item);
    if (item.loanRate != null && !item.loanMonths) errors.push('Podaj okres kredytu w miesiącach');
    if (errors.length) { $('#pu-err').textContent = errors.join(' · '); return; }
    await db.put('purchases', item);
    closeSheet();
    await reload();
    toast('Zapisano');
  };
  if (p) $('#pu-del').onclick = () => { closeSheet(); deletePurchase(p.id); };
}

async function deletePurchase(id) {
  const p = state.data.purchases.find((x) => x.id === id);
  if (!p) return;
  await db.remove('purchases', id);
  await reload();
  toast(`Usunięto: ${p.name}`, { label: 'Cofnij', run: async () => { await db.put('purchases', p); await reload(); } });
}

async function togglePurchaseBought(id) {
  const p = state.data.purchases.find((x) => x.id === id);
  if (!p) return;
  const bought = p.status !== 'bought';
  await db.put('purchases', { ...p, status: bought ? 'bought' : 'saving', boughtAt: bought ? new Date().toISOString() : null });
  await reload();
  toast(bought ? `Kupione: ${p.name} 🎉 — dodaj wydatek przyciskiem +, jeśli chcesz go mieć w transakcjach` : 'Przywrócono do planów');
}

// ---------- Asystent AI ----------
const AI_EXAMPLES = [
  'Dlaczego wydaliśmy więcej niż w poprzednim miesiącu?',
  'Ile średnio kosztuje nas utrzymanie domu?',
  'Jak zmieniły się nasze wydatki w ciągu pół roku?',
  'Ile możemy odkładać miesięcznie przy obecnych dochodach?',
  'Jakie wydatki najbardziej wzrosły?',
  'Zasymuluj nasz majątek za 15 lat, jeśli będziemy odkładać obecną nadwyżkę przy 5% rocznie i 3% inflacji.',
];

const aiKey = () => getPref('sf-gemini-key', '');
const aiModel = () => getPref('sf-gemini-model', '') || DEFAULT_MODEL;

function currentAIContext() {
  const analysis = {};
  for (const p of state.data.purchases) analysis[p.id] = analyzePurchase(p, purchaseContext(p));
  return buildAIContext(state.data, state.month, { purchases: state.data.purchases, purchaseAnalysis: analysis });
}

function viewAI() {
  if (!aiKey()) {
    return `<section class="card"><h2>Asystent AI (Gemini)</h2>
      <p class="small">Zadawaj pytania o swoje finanse. Aplikacja sama liczy sumy i średnie, a do Gemini wysyła tylko te zagregowane liczby — bez opisów transakcji i nazw kont.</p>
      <p class="small">Potrzebny jest Twój klucz API z Google AI Studio. Zostanie zapisany tylko w tym telefonie (nie ma go na GitHubie ani w kopii zapasowej).</p>
      <a class="btn primary block" href="#settings" style="display:grid;place-items:center;text-decoration:none">Wpisz klucz w Ustawieniach</a></section>`;
  }
  const msgs = ai.history.map((m) => (m.role === 'user'
    ? `<div class="msg user">${esc(m.text)}</div>`
    : `<div class="msg ai">${renderAIText(m.text)}</div>`)).join('');
  return `<p class="small muted" style="margin:10px 4px">Miesiąc analizy: <b>${esc(monthNamePL(state.month))}</b>. Liczby liczy aplikacja, AI je interpretuje.</p>
    ${!ai.history.length ? `<div class="chips wrap">${AI_EXAMPLES.map((q, i) => `<button class="chip" data-action="ai-example" data-i="${i}">${esc(q)}</button>`).join('')}</div>` : ''}
    <div class="chat">${msgs}${ai.busy ? '<div class="msg ai typing">Analizuję…</div>' : ''}</div>
    ${ai.error ? `<div class="note warn">${esc(ai.error)}</div>` : ''}
    <div class="ask"><textarea id="ai-q" rows="2" maxlength="600" placeholder="Zapytaj o swoje finanse…" ${ai.busy ? 'disabled' : ''}></textarea>
      <button class="btn primary" data-action="ai-send" ${ai.busy ? 'disabled' : ''}>Wyślij</button></div>
    <div class="actions two">
      <button class="btn" data-action="ai-clear" ${ai.history.length ? '' : 'disabled'}>Wyczyść rozmowę</button>
      <button class="btn" data-action="ai-data">Co wysyłam do AI?</button>
    </div>`;
}

async function askAI(question) {
  question = (question || '').trim();
  if (!question || ai.busy) return;
  ai.error = '';
  ai.busy = true;
  const history = ai.history.slice();
  ai.history.push({ role: 'user', text: question });
  if (state.view === 'plans') render();
  try {
    const text = await askGemini({ key: aiKey(), model: aiModel(), question, context: currentAIContext(), history });
    ai.history.push({ role: 'ai', text });
  } catch (err) {
    ai.error = err.message;
  } finally {
    ai.busy = false;
    if (state.view === 'plans' && state.plansTab === 'ai') { render(); window.scrollTo(0, document.body.scrollHeight); }
  }
}

function showAIData() {
  openSheet('Co wysyłam do AI', `<p class="small muted" style="margin-top:0">Dokładnie te dane (kwoty w złotych) dołączane są do każdego pytania. Bez opisów transakcji, nazw kont i numerów.</p>
    <pre class="json">${esc(JSON.stringify(currentAIContext(), null, 2))}</pre>`);
}

// ---------- Ustawienia ----------
function getPref(key, fallback) {
  try { return localStorage.getItem(key) || fallback; } catch { return fallback; }
}
function setPref(key, value) {
  try { localStorage.setItem(key, value); } catch { /* brak dostępu */ }
}
const sw = (id, on, action, extra = '') => `<label class="switch"><input type="checkbox" id="${id}" data-action="${action}" ${on ? 'checked' : ''} ${extra}><span></span></label>`;

function viewSettings() {
  const theme = getPref('sf-theme', 'system');
  const accent = getPref('sf-accent', 'teal');
  const size = getPref('sf-size', 'normal');
  const priv = getPref('sf-private', '') === '1';
  const deleted = state.data.transactions.filter((t) => t.deletedAt).length;
  const seg = (action, key, cur, items) => `<div class="seg">${Object.entries(items).map(([id, label]) =>
    `<button type="button" data-action="${action}" data-${key}="${id}" aria-pressed="${cur === id}">${esc(label)}</button>`).join('')}</div>`;
  const shown = visibleCards(state.layout).length;
  const accOpts = activeAccounts().filter((a) => accountGroup(a) === 'current');
  return `<section class="card"><h2>Wygląd</h2>
      <div class="field" style="margin-top:0"><span>Motyw</span>${seg('theme', 'theme', theme, { system: 'Systemowy', light: 'Jasny', dark: 'Ciemny' })}</div>
      <div class="field"><span>Kolor aplikacji</span><div class="swatches">${Object.entries(ACCENTS).map(([id, a]) =>
        `<button type="button" class="swatch" data-action="accent" data-accent="${id}" aria-pressed="${accent === id}"><i style="background:${a.light[0]}"></i>${esc(a.label)}</button>`).join('')}</div></div>
      <div class="field"><span>Rozmiar tekstu</span>${seg('text-size', 'size', size, TEXT_SIZES)}</div>
    </section>
    <section class="card"><h2>Strona startowa</h2><ul class="menu">
      <li><button data-action="dash-layout"><span>Ułóż stronę startową<span class="sub">Widoczne karty: ${shown} z ${state.layout.length} · kolejność i widoczność</span></span>🧩</button></li>
    </ul></section>
    <section class="card"><h2>Codzienne używanie</h2>
      <div class="row-set"><span>Ukrywaj kwoty<span class="sub">Tryb prywatny — rozmywa kwoty. Szybki przełącznik: oko u góry ekranu</span></span>${sw('set-private', priv, 'private-toggle')}</div>
      <div class="row-set"><span>Konto dla nowych transakcji</span>
        <select id="set-defacc" data-action="noop">
          <option value="">Ostatnio używane</option>
          ${accOpts.map((a) => `<option value="${esc(a.id)}" ${state.prefs.defaultAccount === a.id ? 'selected' : ''}>${esc(a.name)}</option>`).join('')}
        </select></div>
      <div class="row-set"><span>Wibracja przy przytrzymaniu</span>${sw('set-vibrate', getPref('sf-vibrate', '1') === '1', 'vibrate-toggle')}</div>
      <div class="row-set"><span>Odhaczenie ✓ w planie dodaje transakcję<span class="sub">Wpływ → przychód, opłata → wydatek. Odznaczenie usuwa ją do kosza</span></span>${sw('set-autotx', getPref('sf-autotx', '1') === '1', 'autotx-toggle')}</div>
      <p class="small muted" style="margin:8px 0 0">💡 Przytrzymaj kafelek (transakcję, rachunek, konto, kartę na stronie startowej), żeby zobaczyć więcej opcji.</p>
    </section>
    <section class="card"><h2>Asystent AI (Gemini)</h2>
      ${aiKey() ? `<p class="small">Klucz zapisany w tym telefonie: <b>••••${esc(aiKey().slice(-4))}</b></p>` : '<p class="small muted">Klucz utworzysz w Google AI Studio (aistudio.google.com → Get API key). Najlepiej osobny klucz tylko do tej aplikacji.</p>'}
      <label class="field"><span>${aiKey() ? 'Zmień klucz' : 'Klucz API'}</span><input id="set-ai-key" type="password" autocomplete="off" spellcheck="false" placeholder="${aiKey() ? 'zostaw puste, żeby nie zmieniać' : 'wklej klucz'}"></label>
      <label class="field"><span>Model</span><input id="set-ai-model" autocomplete="off" spellcheck="false" value="${esc(aiModel())}"></label>
      <div class="actions two" style="grid-template-columns:1fr 1fr"><button class="btn" data-action="ai-key-check">Sprawdź</button><button class="btn primary" data-action="ai-key-save">Zapisz</button></div>
      <p id="ai-key-status" class="small muted"></p>
      ${aiKey() ? '<button class="btn danger block" data-action="ai-key-delete">Usuń klucz z telefonu</button>' : ''}
      <p class="small muted">Klucz jest tylko w tym telefonie — nie ma go na GitHubie ani w kopii zapasowej. Do Gemini trafiają wyłącznie zagregowane sumy (podgląd: Plany → AI → „Co wysyłam do AI?”).</p>
    </section>
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
      <button class="btn block" data-action="force-update">Pobierz najnowszą wersję aplikacji</button>
      <p class="small muted">Czyści pamięć podręczną plików aplikacji. Twoje dane (transakcje, konta) zostają.</p>
    </section>`;
}

// ---------- Układ strony startowej ----------
async function saveLayout(layout) {
  state.layout = layout;
  await db.setSetting('dashLayout', layout);
}

function openLayoutSheet() {
  const paint = () => {
    const l = state.layout;
    $('#layout-list').innerHTML = l.map((c, i) => `<div class="layout-row ${c.visible ? '' : 'off'}">
      <label><input type="checkbox" data-lay="vis" data-id="${c.id}" ${c.visible ? 'checked' : ''}> ${DASH_CARDS[c.id].icon} ${esc(DASH_CARDS[c.id].label)}</label>
      <button class="icon-btn" data-lay="up" data-id="${c.id}" aria-label="Wyżej" ${i === 0 ? 'disabled' : ''}>↑</button>
      <button class="icon-btn" data-lay="down" data-id="${c.id}" aria-label="Niżej" ${i === l.length - 1 ? 'disabled' : ''}>↓</button>
    </div>`).join('');
  };
  openSheet('Strona startowa', `<p class="small muted" style="margin-top:0">Zaznacz karty do pokazania i ułóż je strzałkami. Zmiany zapisują się od razu.</p>
    <div id="layout-list"></div>
    <div class="actions two"><button class="btn" id="lay-reset">Domyślny</button><button class="btn primary" data-action="close-sheet">Gotowe</button></div>`);
  paint();
  $('#layout-list').onclick = async (e) => {
    const b = e.target.closest('[data-lay]');
    if (!b || b.dataset.lay === 'vis') return;
    await saveLayout(moveCard(state.layout, b.dataset.id, b.dataset.lay === 'up' ? -1 : 1));
    paint();
    render();
  };
  $('#layout-list').onchange = async (e) => {
    const b = e.target.closest('[data-lay="vis"]');
    if (!b) return;
    await saveLayout(setCardVisible(state.layout, b.dataset.id, b.checked));
    paint();
    render();
  };
  $('#lay-reset').onclick = async () => {
    await saveLayout(normalizeLayout(null));
    paint();
    render();
  };
}

// ---------- Menu po przytrzymaniu ----------
let lpFiredAt = 0;
let suppressClick = false; // pomija tylko kliknięcie kończące przytrzymanie

function setupLongPress() {
  let timer = null; let target = null; let sx = 0; let sy = 0;
  const cancel = () => { clearTimeout(timer); timer = null; target?.classList.remove('lp-active'); target = null; };
  const fire = (el) => {
    lpFiredAt = Date.now();
    suppressClick = true;
    if (getPref('sf-vibrate', '1') === '1') { try { navigator.vibrate?.(15); } catch { /* brak wibracji */ } }
    openContextMenu(el.dataset.lp);
  };
  document.addEventListener('pointerdown', (e) => {
    suppressClick = false; // nowe dotknięcie = nowy gest
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const el = e.target.closest('[data-lp]');
    if (!el || e.target.closest('.paybtn, .acard-actions, input, select, textarea, a')) return;
    target = el; sx = e.clientX; sy = e.clientY;
    el.classList.add('lp-active');
    timer = setTimeout(() => { const t = target; cancel(); if (t) fire(t); }, 480);
  });
  document.addEventListener('pointermove', (e) => { if (timer && Math.hypot(e.clientX - sx, e.clientY - sy) > 10) cancel(); });
  for (const ev of ['pointerup', 'pointercancel']) document.addEventListener(ev, cancel);
  window.addEventListener('scroll', cancel, { passive: true });
  // Android/komputer: natywne „przytrzymanie” / prawy przycisk
  document.addEventListener('contextmenu', (e) => {
    const el = e.target.closest('[data-lp]');
    if (!el) return;
    e.preventDefault();
    if (Date.now() - lpFiredAt < 1000) return;
    cancel();
    fire(el);
  });
  // po przytrzymaniu nie wykonuj zwykłego kliknięcia
  document.addEventListener('click', (e) => {
    if (suppressClick) { suppressClick = false; e.stopPropagation(); e.preventDefault(); }
  }, true);
}

function openContextMenu(spec) {
  const i = spec.indexOf(':');
  const kind = spec.slice(0, i);
  const id = spec.slice(i + 1);
  const item = (action, icon, label, { close = true, danger = false, extra = '' } = {}) =>
    `<li><button data-action="${action}" data-id="${esc(id)}" ${close ? 'data-close="1"' : ''} ${extra} class="${danger ? 'ctx-danger' : ''}"><span>${icon}&nbsp;&nbsp;${esc(label)}</span></button></li>`;
  let title = ''; let head = ''; let items = [];

  if (kind === 'tx') {
    const t = state.data.transactions.find((x) => x.id === id);
    if (!t) return;
    title = t.description || (t.type === 'transfer' ? 'Transfer' : catLabel(t.categoryId));
    head = `${esc(formatDatePL(t.date))} · <span class="num">${esc(formatMoney(t.amount, t.currency))}</span>`;
    items = [
      item('edit-tx', '✏️', 'Edytuj', { close: false }),
      item('dup-tx', '📄', 'Duplikuj z dzisiejszą datą'),
      item('del-tx', '🗑️', 'Usuń', { danger: true }),
    ];
  } else if (kind === 'bill') {
    const b = state.data.bills.find((x) => x.id === id);
    if (!b) return;
    title = `${b.icon || ''} ${b.name}`;
    const inc = kindOf(b) === 'income';
    head = `${inc ? 'Wpływ' : 'Do zapłaty'} · <span class="num">${esc(formatMoney(b.amount))}</span> · ${b.paid ? (inc ? 'wpłynęło' : 'zapłacone') : (inc ? 'jeszcze nie wpłynęło' : 'niezapłacone')}`;
    items = [
      item('toggle-bill', b.paid ? '✕' : '✓', b.paid ? (inc ? 'Oznacz: jeszcze nie wpłynęło' : 'Oznacz jako niezapłacone') : (inc ? 'Oznacz: wpłynęło' : 'Oznacz jako zapłacone')),
      item('edit-bill', '✏️', 'Edytuj', { close: false }),
      item('bill-next', '➡️', `Skopiuj na ${monthNamePL(addMonths(b.month, 1)).toLowerCase()}`),
      item('dup-bill', '📄', 'Duplikuj w tym miesiącu'),
      item('del-bill', '🗑️', 'Usuń', { danger: true }),
    ];
  } else if (kind === 'buy') {
    const p = state.data.purchases.find((x) => x.id === id);
    if (!p) return;
    title = `${p.icon || '🛒'} ${p.name}`;
    head = `<span class="num">${esc(formatMoney(p.price))}</span> · ${esc(STATUSES[p.status] || '')}`;
    items = [
      item('purchase-detail', '📈', 'Analiza', { close: false }),
      item('edit-purchase', '✏️', 'Edytuj', { close: false }),
      item('ai-purchase', '✨', 'Zapytaj AI o ten zakup'),
      item('buy-done', p.status === 'bought' ? '↩️' : '✓', p.status === 'bought' ? 'Przywróć do planów' : 'Oznacz jako kupione'),
      item('del-purchase', '🗑️', 'Usuń', { danger: true }),
    ];
  } else if (kind === 'acc') {
    const a = accById()[id];
    if (!a) return;
    const g = accountGroup(a);
    title = a.name;
    head = esc(accountKindLabel(a));
    if (g === 'savings') items.push(item('move', '➕', 'Wpłata', { close: false, extra: 'data-mode="in"' }), item('move', '➖', 'Wypłata', { close: false, extra: 'data-mode="out"' }));
    if (g === 'loan') items.push(item('move', '💸', 'Dodaj spłatę', { close: false, extra: 'data-mode="pay"' }));
    items.push(
      item('account-detail', '📜', 'Historia', { close: false }),
      item('edit-account', '✏️', 'Edytuj', { close: false }),
      item('archive-acc', '📦', 'Zarchiwizuj (ukryj)', { danger: true }),
    );
  } else if (kind === 'card') {
    const pos = visibleCards(state.layout).indexOf(id);
    const n = visibleCards(state.layout).length;
    title = DASH_CARDS[id]?.label || 'Karta';
    head = 'Karta na stronie startowej';
    items = [
      pos > 0 ? item('card-up', '⬆️', 'Przesuń wyżej') : '',
      pos < n - 1 ? item('card-down', '⬇️', 'Przesuń niżej') : '',
      item('card-hide', '🙈', 'Ukryj tę kartę'),
      item('dash-layout', '🧩', 'Ułóż stronę startową…', { close: false }),
    ];
  } else return;

  openSheet(title, `<div class="ctx-head">${head}</div><ul class="menu ctx">${items.join('')}</ul>`);
}

async function duplicateTx(id) {
  const t = state.data.transactions.find((x) => x.id === id);
  if (!t) return;
  const now = new Date().toISOString();
  const copy = { ...t, id: db.newId('tx'), date: todayISO(), createdAt: now, updatedAt: now };
  delete copy.deletedAt;
  await db.put('transactions', copy);
  state.month = monthKey(copy.date);
  await reload();
  toast('Zduplikowano', { label: 'Edytuj', run: () => openTxSheet(copy.id) });
}

async function deleteTx(id) {
  const t = state.data.transactions.find((x) => x.id === id);
  if (!t) return;
  await db.put('transactions', { ...t, deletedAt: new Date().toISOString() });
  await reload();
  toast('Przeniesiono do kosza', { label: 'Cofnij', run: async () => { await db.put('transactions', t); await reload(); } });
}

async function copyBillTo(id, month) {
  const b = state.data.bills.find((x) => x.id === id);
  if (!b) return;
  const exists = state.data.bills.some((x) => x.month === month && kindOf(x) === kindOf(b) && x.name.trim().toLowerCase() === b.name.trim().toLowerCase());
  if (exists && month !== b.month) { toast(`„${b.name}” już jest na liście: ${monthNamePL(month).toLowerCase()}`); return; }
  await db.put('bills', { ...b, id: db.newId('bill'), month, paid: false, paidAt: null, txId: null, createdAt: new Date().toISOString(), order: Date.now() });
  await reload();
  toast(month === b.month ? 'Zduplikowano' : `Skopiowano na ${monthNamePL(month).toLowerCase()}`);
}

async function deleteBill(id) {
  const b = state.data.bills.find((x) => x.id === id);
  if (!b) return;
  await db.remove('bills', id);
  await reload();
  toast('Usunięto z listy', { label: 'Cofnij', run: async () => { await db.put('bills', b); await reload(); } });
}

async function archiveAccount(id) {
  const a = accById()[id];
  if (!a) return;
  await db.put('accounts', { ...a, archived: true });
  await reload();
  toast(`Zarchiwizowano: ${a.name}`, { label: 'Cofnij', run: async () => { await db.put('accounts', a); await reload(); } });
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

async function openTxSheet(id, opts = {}) {
  const existing = id ? state.data.transactions.find((t) => t.id === id) : null;
  const lastAccount = await db.getSetting('lastAccount', null);
  const accounts = activeAccounts();
  if (!accounts.length) { toast('Najpierw dodaj konto w zakładce Majątek'); return; }
  const defAcc = (accounts.find((a) => a.id === state.prefs.defaultAccount)
    || accounts.find((a) => a.id === lastAccount)
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
    if (opts.quick) { quick.value = opts.quick; apply(); }
    quick.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); apply(); $('#t-save').click(); } };
    focusLater('#t-quick');
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
// Przycisk „wstecz” Androida zamyka okienko. history.back() jest asynchroniczne,
// więc pilnujemy, żeby „wstecz” od zamknięcia nie zamknęło okienka otwartego chwilę później.
let backPending = false;
let pushAfterBack = false;

function openSheet(title, body) {
  const sheet = $('#sheet');
  sheet.innerHTML = `<div class="sheet-inner"><div class="sheet-head"><h2 id="sheet-title">${esc(title)}</h2>
    <button class="icon-btn" data-action="close-sheet" aria-label="Zamknij">✕</button></div>${body}</div>`;
  if (!sheet.open) sheet.showModal();
  if (backPending) pushAfterBack = true;
  else if (!history.state?.sheet) history.pushState({ sheet: true }, '');
}
function closeSheet() {
  const sheet = $('#sheet');
  if (sheet.open) sheet.close();
  if (history.state?.sheet && !backPending) {
    backPending = true;
    pushAfterBack = false;
    history.back();
  }
}
function onPopState() {
  if (backPending) {
    backPending = false;
    if (pushAfterBack && $('#sheet').open) history.pushState({ sheet: true }, '');
    pushAfterBack = false;
    return;
  }
  const s = $('#sheet');
  if (s.open) s.close();
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
  if (el.dataset.close) closeSheet();
  switch (a) {
    case 'add': openTxSheet(); break;
    case 'edit-tx': openTxSheet(el.dataset.id); break;
    case 'close-sheet': closeSheet(); break;
    case 'month-prev': state.month = addMonths(state.month, -1); render(); break;
    case 'month-next': state.month = addMonths(state.month, 1); render(); break;
    case 'month-today': openCalendar(); break;
    case 'tx-filter': state.txFilter = el.dataset.f; render(); break;
    case 'add-bill': openBillSheet(null, el.dataset.kind); break;
    case 'edit-bill': openBillSheet(el.dataset.id); break;
    case 'toggle-bill': toggleBill(el.dataset.id); break;
    case 'copy-bills': openCopySheet(); break;
    case 'plans-tab':
      state.plansTab = el.dataset.tab2;
      if (state.view !== 'plans') location.hash = '#plans'; else render();
      break;
    case 'buy-filter': state.buyFilter = el.dataset.f; render(); break;
    case 'add-purchase': openPurchaseSheet(null); break;
    case 'edit-purchase': openPurchaseSheet(el.dataset.id); break;
    case 'purchase-detail': openPurchaseDetail(el.dataset.id); break;
    case 'buy-done': togglePurchaseBought(el.dataset.id); break;
    case 'del-purchase': deletePurchase(el.dataset.id); break;
    case 'ai-purchase': {
      const p = state.data.purchases.find((x) => x.id === el.dataset.id);
      if (!p) break;
      if ($('#sheet').open) closeSheet();
      state.plansTab = 'ai';
      if (state.view !== 'plans') location.hash = '#plans'; else render();
      if (aiKey()) askAI(`Oceń mój plan zakupu: ${p.name} za ${formatMoney(p.price)}. Kiedy realnie mnie na to stać, jak wpłynie na poduszkę bezpieczeństwa i czy lepiej gotówka czy kredyt (jeśli podałem warunki)?`);
      break;
    }
    case 'ai-example': askAI(AI_EXAMPLES[Number(el.dataset.i)]); break;
    case 'ai-send': { const q = $('#ai-q'); if (q && q.value.trim()) askAI(q.value); break; }
    case 'ai-clear': ai.history = []; ai.error = ''; render(); break;
    case 'ai-data': showAIData(); break;
    case 'autotx-toggle': setPref('sf-autotx', el.checked ? '1' : '0'); break;
    case 'ai-key-save': {
      const k = $('#set-ai-key').value.trim();
      const m = $('#set-ai-model').value.trim();
      if (k) setPref('sf-gemini-key', k);
      setPref('sf-gemini-model', m && m !== DEFAULT_MODEL ? m : '');
      render();
      toast(k ? 'Zapisano klucz w tym telefonie' : 'Zapisano model');
      break;
    }
    case 'ai-key-check': {
      const k = $('#set-ai-key').value.trim() || aiKey();
      const m = $('#set-ai-model').value.trim() || DEFAULT_MODEL;
      const out = $('#ai-key-status');
      out.textContent = 'Sprawdzam…';
      out.className = 'small muted';
      try {
        const name = await checkGeminiKey(k, m);
        out.textContent = `✓ Działa: ${name}`;
        out.className = 'small pos';
      } catch (err) {
        out.textContent = '✕ ' + err.message;
        out.className = 'small neg';
      }
      break;
    }
    case 'ai-key-delete':
      setPref('sf-gemini-key', '');
      ai.history = [];
      render();
      toast('Usunięto klucz z telefonu');
      break;
    case 'edit-account': openAccountSheet(el.dataset.id); break;
    case 'add-account': openAccountSheet(null, el.dataset.group); break;
    case 'account-detail': openAccountDetail(el.dataset.id); break;
    case 'move': openMoveSheet(el.dataset.id, el.dataset.mode); break;
    case 'categories': openCategoriesSheet(el.dataset.kind); break;
    case 'edit-cat': openCategorySheet(el.dataset.id); break;
    case 'new-cat': openCategorySheet(null, el.dataset.kind); break;
    case 'theme': setPref('sf-theme', el.dataset.theme); applyTheme(); render(); break;
    case 'accent': setPref('sf-accent', el.dataset.accent); applyTheme(); render(); break;
    case 'text-size': setPref('sf-size', el.dataset.size); applyTheme(); render(); break;
    case 'privacy':
    case 'private-toggle':
      setPref('sf-private', getPref('sf-private', '') === '1' ? '0' : '1');
      applyTheme();
      if (state.view === 'settings') render();
      break;
    case 'vibrate-toggle': setPref('sf-vibrate', el.checked ? '1' : '0'); break;
    case 'quick-add': {
      const v = $('#dash-quick')?.value.trim();
      openTxSheet(null, { quick: v });
      break;
    }
    case 'dash-layout': openLayoutSheet(); break;
    case 'card-up':
    case 'card-down':
      await saveLayout(moveCard(state.layout, el.dataset.id, a === 'card-up' ? -1 : 1, { visibleOnly: true }));
      render();
      break;
    case 'card-hide':
      await saveLayout(setCardVisible(state.layout, el.dataset.id, false));
      render();
      toast(`Ukryto: ${DASH_CARDS[el.dataset.id].label}`, { label: 'Cofnij', run: async () => { await saveLayout(setCardVisible(state.layout, el.dataset.id, true)); render(); } });
      break;
    case 'dup-tx': duplicateTx(el.dataset.id); break;
    case 'del-tx': deleteTx(el.dataset.id); break;
    case 'dup-bill': { const b = state.data.bills.find((x) => x.id === el.dataset.id); if (b) copyBillTo(b.id, b.month); break; }
    case 'bill-next': { const b = state.data.bills.find((x) => x.id === el.dataset.id); if (b) copyBillTo(b.id, addMonths(b.month, 1)); break; }
    case 'del-bill': deleteBill(el.dataset.id); break;
    case 'archive-acc': archiveAccount(el.dataset.id); break;
    case 'backup': doBackup(); break;
    case 'restore': $('#file-input').click(); break;
    case 'export-csv':
      download(`smart-finance-transakcje-${todayISO()}.csv`, transactionsToCSV(state.data.transactions, state.data), 'text/csv;charset=utf-8');
      toast('Zapisano plik CSV w Pobranych');
      break;
    case 'trash': openTrashSheet(); break;
    case 'force-update': {
      try {
        const regs = (await navigator.serviceWorker?.getRegistrations()) || [];
        await Promise.all(regs.map((r) => r.unregister()));
        const keys = (await caches?.keys()) || [];
        await Promise.all(keys.map((k) => caches.delete(k)));
      } catch { /* przeładowanie i tak pobierze pliki */ }
      location.reload();
      break;
    }
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
  const root = document.documentElement;
  const theme = getPref('sf-theme', 'system');
  const accent = getPref('sf-accent', 'teal');
  const size = getPref('sf-size', 'normal');
  if (theme === 'system') root.removeAttribute('data-theme'); else root.setAttribute('data-theme', theme);
  if (accent === 'teal' || !ACCENTS[accent]) root.removeAttribute('data-accent'); else root.setAttribute('data-accent', accent);
  if (size === 'normal' || !TEXT_SIZES[size]) root.removeAttribute('data-size'); else root.setAttribute('data-size', size);
  root.toggleAttribute('data-private', getPref('sf-private', '') === '1');
  // kolor paska systemowego Androida
  const dark = theme === 'dark' || (theme === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  const color = dark ? '#0b1412' : (ACCENTS[accent] || ACCENTS.teal).light[0];
  document.querySelectorAll('meta[name="theme-color"]').forEach((m) => { m.setAttribute('content', color); m.removeAttribute('media'); });
}

// ---------- Start ----------
function showError(err) {
  const msg = (err && (err.message || err.name)) || String(err);
  const box = document.querySelector('#sheet[open] .err');
  if (box) box.textContent = 'Błąd zapisu: ' + msg;
  toast('Błąd: ' + msg);
  console.error(err);
}

async function init() {
  applyTheme();
  window.addEventListener('unhandledrejection', (e) => showError(e.reason));
  window.addEventListener('error', (e) => showError(e.error || e.message));
  document.addEventListener('click', onAction);
  setupLongPress();
  document.addEventListener('change', async (e) => {
    if (e.target.id === 'set-defacc') {
      state.prefs.defaultAccount = e.target.value;
      await db.setSetting('defaultAccount', e.target.value);
      toast('Zapisano');
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.id === 'dash-quick') { e.preventDefault(); $('[data-action="quick-add"]')?.click(); }
  });
  matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', applyTheme);
  window.addEventListener('hashchange', route);
  window.addEventListener('popstate', onPopState);
  $('#sheet').addEventListener('click', (e) => { if (e.target.id === 'sheet') closeSheet(); }); // klik w tło
  $('#sheet').addEventListener('cancel', (e) => { e.preventDefault(); closeSheet(); });
  // zamknięte okienko czyścimy, żeby jego stara treść nie dublowała przycisków i pól
  $('#sheet').addEventListener('close', () => { setTimeout(() => { const sh = $('#sheet'); if (!sh.open) sh.innerHTML = ''; }, 0); });
  $('#file-input').addEventListener('change', (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (file) doRestore(file);
  });
  try {
    await db.ensureDefaults();
    await db.migrate();
    state.lastBackup = await db.getSetting('lastBackup', null);
    state.layout = normalizeLayout(await db.getSetting('dashLayout', null));
    state.prefs.defaultAccount = await db.getSetting('defaultAccount', '') || '';
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
