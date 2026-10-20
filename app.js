// Smart Finance — interfejs aplikacji (ekrany, formularze, nawigacja).
import * as db from './db.js';
import {
  balances, netWorth, monthSummary, rollupByParent, averages, effectOnAccount,
  monthlySeries, categoryChanges, isLive, accountMonth,
} from './calc.js';
import { toMinor, formatMoney, minorToInput } from './money.js';
import { addDays, todayISO, monthKey, addMonths, monthNamePL, monthShortPL, dayLabelPL, formatDatePL, dateInMonth, WEEKDAYS_SHORT } from './dates.js';
import { parseQuick, guessCategory } from './parse.js';
import { validateTransaction, validateBackup, validateBill, validatePurchase } from './validate.js';
import { transactionsToCSV } from './csv.js';
import { ACCOUNT_TYPES, CURRENCIES, SAVINGS_KINDS, PROPERTY_KINDS, BILL_ICONS, accountGroup } from './defaults.js';
import { sanitizeImage, isLocalImage, imageFromFile, imageFromUrl, imageViaCanvas, searchImages, CorsBlockedError } from './images.js';
import { badgeFor, brandOf, initials } from './avatar.js';
import { hashPin, verifyPin, lockoutSeconds, PIN_RE, biometricAvailable, registerBiometric, verifyBiometric } from './lock.js';
import { speechSupported, listen } from './voice.js';
import { kindOf, paidWithoutTx, planSummary, planToCopy, autoTransaction, calendarGrid, dayMarks, yearTiles } from './plan.js';
import { analyzePurchase, PRIORITIES, STATUSES, PURCHASE_ICONS, loanInstallment } from './purchases.js';
import { isCrypto, hasPositions, positionsOf, positionsSummary, applyTrade, metalOf, accountValue, bookBalance, investmentResult, valuedNetWorth, applyChange, sortedValuations, metalValue, TROY_OUNCE_G } from './valuation.js';
import { refreshPrices, fetchCryptoPrices, searchCoins } from './prices.js';
import { parseBatch } from './batch.js';
import { termDeposit, savingsEstimate, isTermDeposit, depositsDue, addMonthsDate } from './deposit.js';
import { netWorthHistory, historyStats, breakdown } from './history.js';
import { playFilm } from './film.js';
import { DEFAULT_SIM, simulate, investLoanAnalysis, bucketOf } from './sim.js';
import { buildAIContext, askGemini, checkGeminiKey, renderAIText, DEFAULT_MODEL } from './ai.js';
import { DASH_CARDS, ACCENTS, TEXT_SIZES, normalizeLayout, moveCard, setCardVisible, visibleCards } from './layout.js';

export const APP_VERSION = '1.0.1';

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (m, cur = 'PLN', o) => `<span class="num">${esc(formatMoney(m, cur, o))}</span>`;

const state = {
  data: { accounts: [], categories: [], transactions: [], budgets: [], bills: [], purchases: [] },
  plansTab: 'buy',
  prices: null,
  snapshots: {},
  nwRange: '12',
  nwLayers: false,
  openPos: {},
  profile: null,
  deletedAccounts: [],
  bioAvailable: false,
  priceProblems: [],
  simSettings: null,
  metalChart: 'gold',
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
/** Ikona: obrazek (jeśli jest i jest bezpieczny) albo emoji. mini = mały, w linii tekstu. */
function ico(emoji, image, { mini = false } = {}) {
  const img = sanitizeImage(image);
  if (img) return `<img class="${mini ? 'ico-mini' : 'ico-img'}" src="${esc(img)}" alt="" loading="lazy" referrerpolicy="no-referrer">`;
  return esc(emoji || '•');
}
function catIco(id, cats = catById(), opts) {
  return ico(catIcon(id, cats), cats[id]?.image, opts);
}
function txIco(t, cats = catById()) {
  return t.type === 'transfer' ? '⇄' : catIco(t.categoryId, cats);
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
    <span class="ico" aria-hidden="true">${txIco(t, cats)}</span>
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

async function loadData() {
  const data = await db.loadAll();
  state.deletedAccounts = data.accounts.filter((a) => a.deletedAt);
  data.accounts = data.accounts.filter((a) => !a.deletedAt);
  state.data = data;
}

async function reload() {
  await loadData();
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
  if (state.view === 'plans' && state.plansTab === 'sim') bindSimForm();
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
  parts.push(depositReminders());
  if (state.profile?.name) parts.push(`<button class="hello link" data-action="profile" style="color:inherit"><span class="av">${profileAvatar()}</span>Cześć, ${esc(state.profile.name)} 👋</button>`);

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
      ${speechSupported() ? '<button class="mic" data-action="dash-mic" aria-label="Dyktuj">🎤</button>' : ''}
      <button class="btn primary" data-action="quick-add">Dalej</button></div>
      <button class="btn block" data-action="batch" style="margin-top:8px">⚡ Szybka aktualizacja — kilka rzeczy naraz</button></section>`,

    networth: () => {
      const w = valuedNetWorth(state.data.accounts, txs, valOpts());
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
      return `<section class="card" ${lp('bills')}><h2>Plan miesiąca <span><button class="link" data-action="batch">⚡ Szybko</button> · <a href="#budget">Plan ›</a></span></h2>
        ${count ? `<div class="stat-row">
          <div class="stat"><small>Wpłynęło</small><b class="pos">${money(ps.income.done)}</b><small>z ${esc(formatMoney(ps.income.total))}</small></div>
          <div class="stat"><small>Do zapłaty</small><b class="${ps.expense.left > 0 ? 'neg' : 'pos'}">${money(ps.expense.left)}</b><small>${ps.expense.doneCount}/${ps.expense.count} opłacone</small></div>
          <div class="stat"><small>Zostanie</small><b class="${ps.plannedNet < 0 ? 'neg' : ''}">${money(ps.plannedNet)}</b><small>wg planu</small></div>
        </div>
        ${open.length ? `<p class="small muted" style="margin:10px 0 0">Czeka: ${open.slice(0, 4).map((b) => billIco(b, '•', { mini: true }) + ' ' + esc(b.name)).join(', ')}${open.length > 4 ? '…' : ''}</p>` : ''}
        ${missingTxNotice(state.month, { short: true })}`
        : '<p class="muted small">Brak planu na ten miesiąc. <a class="link" href="#budget">Zaplanuj</a></p>'}
      </section>`;
    },

    metals: () => metalPricesCard(true),
    nwchart: () => nwChartCard({ lpAttr: lp('nwchart') }),

    purchases: () => {
      const prio = { high: 0, mid: 1, low: 2 };
      const list = state.data.purchases.filter((p) => p.status !== 'bought').sort((a, b) => (prio[a.priority] ?? 1) - (prio[b.priority] ?? 1)).slice(0, 3);
      return `<section class="card" ${lp('purchases')}><h2>Do kupienia <a href="#plans" data-action="plans-tab" data-tab2="buy">Plany ›</a></h2>
        ${list.length ? `<ul class="bars">${list.map((p) => {
          const a = analyzePurchase(p, purchaseContext(p));
          return `<li><div class="row"><span>${ico(p.icon || '🛒', p.image, { mini: true })} ${esc(p.name)}</span><span class="num">${Math.round(a.progress * 100)}%</span></div>
            <div class="track"><div class="fill" style="width:${(a.progress * 100).toFixed(1)}%"></div></div>
            <div class="small muted">${a.missing === 0 ? 'Masz już całą kwotę' : a.affordYm ? 'Szacunkowo: ' + esc(monthNamePL(a.affordYm).toLowerCase()) : 'brakuje ' + esc(formatMoney(a.missing))}</div></li>`;
        }).join('')}</ul>` : '<p class="muted small">Brak planowanych zakupów.</p>'}</section>`;
    },

    savings: () => {
      const list = state.data.accounts.filter((a) => !a.archived && accountGroup(a) === 'savings' && a.currency === 'PLN');
      let total = 0; let inflow = 0; let outflow = 0;
      for (const a of list) { const m = accountMonth(a, txs, state.month); total += accountValue(a, txs, valOpts(lastDay(state.month))); inflow += m.inflow; outflow += m.outflow; }
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
        <li><div class="row"><span>${catIco(id, cats, { mini: true })} ${esc(catLabel(id, cats))}</span><span class="num">${esc(formatMoney(v))}</span></div>
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
      <span class="ico" aria-hidden="true">${billIco(b, inc ? '💰' : '📄')}</span>
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
    ${missingTxNotice(ym)}
    <button class="btn block" data-action="batch">⚡ Szybka aktualizacja — „wpłynęła wypłata 9k, ppk 300…”</button>
    ${toCopy.length ? `<button class="btn primary block" data-action="copy-bills" style="margin-top:8px">⧉ Skopiuj z: ${esc(monthNamePL(prevYm).toLowerCase())} (${toCopy.length})</button>` : ''}
    ${section('income', incomes, 'Wpływy', s.income.done, s.income.total)}
    ${section('expense', expenses, 'Do zapłaty', s.expense.done, s.expense.total)}
    <p class="note">Dotknij ✕ / ✓, żeby zmienić status${autoTxOn() ? ' — odhaczenie od razu dodaje transakcję (przychód lub wydatek), odznaczenie ją usuwa' : ''}. Nazwa miesiąca u góry otwiera kalendarz, strzałki przenoszą na kolejny miesiąc.</p>`;
}

/** Ostrzeżenie: odhaczone pozycje, które nie mają transakcji (np. odhaczone w starszej wersji aplikacji). */
function missingTxNotice(ym, { short = false } = {}) {
  if (!autoTxOn()) return '';
  const list = paidWithoutTx(state.data.bills, state.data.transactions, ym);
  if (!list.length) return '';
  const inc = list.filter((b) => kindOf(b) === 'income').reduce((s, b) => s + b.amount, 0);
  const exp = list.filter((b) => kindOf(b) === 'expense').reduce((s, b) => s + b.amount, 0);
  if (short) return `<p class="small neg" style="margin:10px 0 0">⚠ ${list.length} odhaczonych pozycji nie liczy się jeszcze do bilansu. <a class="link" href="#budget">Napraw ›</a></p>`;
  return `<div class="note warn">⚠ <b>${list.length} odhaczonych pozycji nie ma transakcji</b> (np. odhaczone w starszej wersji), więc nie zmniejszają bilansu ani salda konta${exp ? ` — wydatki: <span class="num">${esc(formatMoney(exp))}</span>` : ''}${inc ? `, wpływy: <span class="num">${esc(formatMoney(inc))}</span>` : ''}.
    <div class="actions"><button class="btn primary block" data-action="plan-fix-tx">Dodaj brakujące transakcje</button></div>
    <span class="small">Jeśli te wydatki wpisałeś już ręcznie w Transakcjach, nie dodawaj — policzyłyby się podwójnie.</span></div>`;
}

async function fixMissingPlanTx() {
  const list = paidWithoutTx(state.data.bills, state.data.transactions, state.month);
  let n = 0;
  for (const b of list) {
    const item = { ...b, txId: null };
    item.txId = await syncPlanTx(item);
    if (item.txId) n++;
    await db.put('bills', item);
    await loadData(); // świeże dane dla kolejnej pozycji
  }
  await reload();
  toast(`Dodano ${n} transakcji — bilans i saldo konta są już aktualne`);
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
      ...autoTransaction({ ...item, categoryId }, {
        today: todayISO(),
        paidDate: item.paidAt ? todayISO(new Date(item.paidAt)) : null,
        accountId: defaultAccountId(),
        fallbackCategory: categoryId,
      }),
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
    <details class="more" ${b?.note || b?.image || (b?.icon && kind === 'expense') ? 'open' : ''}><summary>Ikona, obrazek i notatka</summary>
      <div class="field"><span>Ikona</span><div class="icongrid" id="bl-icons">${BILL_ICONS.map((i) => `<button type="button" data-icon="${i}">${i}</button>`).join('')}</div>
        <input id="bl-icon-custom" maxlength="4" placeholder="lub wpisz własne emoji" value="${b?.icon && !BILL_ICONS.includes(b.icon) ? esc(b.icon) : ''}"></div>
      ${imagePickerHtml()}
      <label class="field"><span>Notatka</span><input id="bl-note" maxlength="80" value="${esc(b?.note || '')}" placeholder="np. termin, nr umowy"></label>
    </details>
    <label class="check"><input type="checkbox" id="bl-paid" ${b?.paid ? 'checked' : ''}> <span id="bl-paid-label"></span></label>
    <div class="err" id="bl-err" role="alert"></div>
    <div class="actions ${b ? 'two' : ''}">
      ${b ? '<button class="btn danger" id="bl-del">Usuń</button>' : ''}
      <button class="btn primary block" id="bl-save">${b ? 'Zapisz' : 'Dodaj'}</button>
    </div>`);
  const sheet = $('#sheet');
  const pick = mountImagePicker(b?.image);
  const cats = () => state.data.categories.filter((c) => c.kind === kind && (!c.archived || c.id === categoryId));
  const paintIcons = () => sheet.querySelectorAll('#bl-icons [data-icon]').forEach((x) => x.setAttribute('aria-pressed', String(x.dataset.icon === icon)));
  const paint = () => {
    sheet.querySelectorAll('#bl-kind [data-kind]').forEach((x) => x.setAttribute('aria-pressed', String(x.dataset.kind === kind)));
    $('#bl-name-label').textContent = kind === 'income' ? 'Opis wpływu' : 'Co trzeba zapłacić';
    $('#bl-name').placeholder = kind === 'income' ? 'np. Pensja Ani, 800+ Zosia' : 'np. Czynsz, Prąd, Przedszkole';
    $('#bl-cat-label').textContent = kind === 'income' ? 'Rodzaj wpływu' : 'Kategoria (do transakcji)';
    $('#bl-paid-label').textContent = kind === 'income' ? 'Już wpłynęło' : 'Już zapłacone';
    if (categoryId && !cats().some((c) => c.id === categoryId)) categoryId = null;
    $('#bl-cats').innerHTML = cats().map((c) => `<button type="button" class="cat" data-cat="${esc(c.id)}" aria-pressed="${c.id === categoryId}"><b>${ico(c.icon || '•', c.image)}</b>${esc(c.name)}</button>`).join('');
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
      image: pick.get() || null,
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
    <label><input type="checkbox" data-copy="${i}" checked> <span>${billIco(b, '•', { mini: true })} ${esc(b.name)}${b.day ? `<small class="muted"> · ${b.day}.</small>` : ''}</span></label>
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
  if (a.type === 'property') return PROPERTY_KINDS[a.subtype]?.icon || '📦';
  if (a.subtype && SAVINGS_KINDS[a.subtype]) return SAVINGS_KINDS[a.subtype].icon;
  return { checking: '🏦', savings: '🐷', cash: '💵', card: '💳', investment: '📈', other: '📁' }[a.type] || '📁';
}
function accountKindLabel(a) {
  if (a.type === 'loan') return 'Kredyt';
  if (a.type === 'property') return PROPERTY_KINDS[a.subtype]?.label || 'Inne aktywo';
  if (a.subtype && SAVINGS_KINDS[a.subtype]) return SAVINGS_KINDS[a.subtype].label;
  return ACCOUNT_TYPES[a.type] || '';
}

function viewWealth() {
  const ym = state.month;
  const txs = liveTx();
  const txsUntil = txs.filter((t) => t.date < monthEnd(ym));
  const w = valuedNetWorth(state.data.accounts, txs, valOpts(lastDay(ym)));
  const bookBal = balances(state.data.accounts, txsUntil);
  const bal = new Proxy({}, { get: (_, id) => w.values[id] ?? bookBal[id] });
  const active = state.data.accounts.filter((a) => !a.archived);
  const current = active.filter((a) => accountGroup(a) === 'current');
  const savings = active.filter((a) => accountGroup(a) === 'savings');
  const loans = active.filter((a) => accountGroup(a) === 'loan');
  const props = active.filter((a) => accountGroup(a) === 'property');
  const archived = state.data.accounts.filter((a) => a.archived);
  const sumPLN = (list, fn) => list.filter((a) => a.currency === 'PLN').reduce((s, a) => s + fn(a), 0);
  const monthWord = esc(monthNamePL(ym).toLowerCase());

  const savingsCards = savings.map((a) => {
    const m = accountMonth(a, txs, ym);
    const metal = metalOf(a);
    const r = posResult(a, investmentResult(a, txs, valOpts(lastDay(ym))));
    const crypto = isCrypto(a);
    const posMode = metal || (crypto && positionsOf(a).length);
    const showGain = metal || posMode || (a.valuations || []).length > 0;
    return `<section class="acard" data-lp="acc:${esc(a.id)}">
      <button class="acard-head" data-action="account-detail" data-id="${esc(a.id)}">
        <span class="ico">${accIco(a)}</span>
        <span class="mid"><span class="t1">${esc(a.name)}</span><span class="t2">${esc(accountKindLabel(a))}${a.description ? ' · ' + esc(a.description) : ''}</span></span>
        <span class="amt num">${esc(formatMoney(r.value, a.currency))}</span>
      </button>
      ${metal ? `<div class="acard-month small">${positionsOf(a).length > 1 ? metalPriceOnly(a) : metalLine(a)}</div>` : ''}
      ${crypto && positionsOf(a).length ? `<div class="acard-month small">${cryptoLine(a)}</div>` : ''}
      ${a.rate ? depositLine(a, bookBal[a.id]) : ''}
      ${looksLikeProperty(a) ? `<div class="note small" style="margin:6px 0">🏠 To wygląda na nieruchomość — w symulacji liczy się teraz jak inwestycja. <button class="link" data-action="to-property" data-id="${esc(a.id)}">Przenieś do Nieruchomości</button></div>` : ''}
      ${showGain ? `<div class="acard-month small">Wpłacono <span class="num">${esc(formatMoney(r.paidIn, a.currency))}</span> · ${r.gain >= 0 ? 'zysk' : 'strata'} <b class="num ${r.gain >= 0 ? 'pos' : 'neg'}">${esc(formatMoney(r.gain, a.currency, { sign: true }))}${r.gainPct != null ? ` (${esc(fmtPct(r.gainPct * 100))})` : ''}</b></div>` : ''}
      <div class="acard-month small">${m.inflow || m.outflow ? `W tym miesiącu:${m.inflow ? ` <span class="pos num">wpłaty +${esc(formatMoney(m.inflow, a.currency))}</span>` : ''}${m.inflow && m.outflow ? ' ·' : ''}${m.outflow ? ` <span class="neg num">wypłaty −${esc(formatMoney(m.outflow, a.currency))}</span>` : ''}` : 'Brak wpłat i wypłat w tym miesiącu'}</div>
      ${metal || crypto ? positionsHtml(a) : ''}
      <div class="acard-actions ${posMode ? '' : 'three'}">
        <button class="btn" data-action="move" data-mode="in" data-id="${esc(a.id)}">${posMode ? '+ Kupno' : '+ Wpłata'}</button>
        <button class="btn" data-action="move" data-mode="out" data-id="${esc(a.id)}">${posMode ? '− Sprzedaż' : '− Wypłata'}</button>
        ${posMode ? '' : `<button class="btn" data-action="valuate" data-id="${esc(a.id)}">📈 Wartość</button>`}
      </div>
    </section>`;
  }).join('');

  const propCards = props.map((a) => {
    const value = bal[a.id];
    const loan = a.loanId ? state.data.accounts.find((x) => x.id === a.loanId) : null;
    const debt = loan ? Math.max(0, -bal[loan.id]) : 0;
    const own = value - debt;
    const vs = a.purchasePrice ? value - a.purchasePrice : null;
    return `<section class="acard" data-lp="acc:${esc(a.id)}">
      <button class="acard-head" data-action="account-detail" data-id="${esc(a.id)}">
        <span class="ico">${accIco(a)}</span>
        <span class="mid"><span class="t1">${esc(a.name)}</span><span class="t2">${esc(accountKindLabel(a))}${a.description ? ' · ' + esc(a.description) : ''}</span></span>
        <span class="amt num">${esc(formatMoney(value, a.currency))}</span>
      </button>
      ${vs != null ? `<div class="acard-month small">Kupione za <span class="num">${esc(formatMoney(a.purchasePrice, a.currency))}</span>${a.purchaseYear ? ` (${a.purchaseYear})` : ''} · <b class="num ${vs >= 0 ? 'pos' : 'neg'}">${esc(formatMoney(vs, a.currency, { sign: true }))}</b></div>` : ''}
      ${loan ? `<div class="acard-month small">Kredyt „${esc(loan.name)}”: <span class="num neg">−${esc(formatMoney(debt, a.currency))}</span> · Twoje: <b class="num">${esc(formatMoney(own, a.currency))}</b>${value > 0 ? ` (${Math.round((own / value) * 100)}%)` : ''}</div>
        <div class="track"><div class="fill" style="width:${value > 0 ? Math.max(0, Math.min(100, (own / value) * 100)).toFixed(1) : 0}%"></div></div>` : ''}
      <div class="acard-actions one"><button class="btn" data-action="valuate" data-id="${esc(a.id)}">📈 Aktualizuj wartość</button></div>
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

    ${depositReminders()}
    ${nwChartCard()}
    <button class="btn primary block" data-action="film" style="margin-bottom:6px">🎬 Film o majątku (30 s)</button>

    <div class="sec-head"><h2>Oszczędności i inwestycje</h2><b class="num">${esc(formatMoney(sumPLN(savings, (a) => bal[a.id])))}</b></div>
    ${savingsCards || '<p class="muted small">Dodaj lokatę, IKE, PPK, ETF albo cokolwiek, gdzie odkładasz pieniądze.</p>'}
    <button class="btn block" data-action="add-account" data-group="savings">+ Dodaj oszczędności / inwestycję</button>
    ${hasMetals() ? metalPricesCard() : ''}

    <div class="sec-head"><h2>Nieruchomości i inne aktywa</h2><b class="num">${props.length ? esc(formatMoney(sumPLN(props, (a) => bal[a.id]))) : ''}</b></div>
    ${propCards || '<p class="muted small">Mieszkanie, dom, działka, samochód… — wpisz wartość, a w symulacji zobaczysz ją za X lat.</p>'}
    <button class="btn block" data-action="add-account" data-group="property">+ Dodaj nieruchomość / aktywo</button>

    <div class="sec-head"><h2>Kredyty</h2><b class="num">${loans.length ? esc(formatMoney(sumPLN(loans, (a) => -bal[a.id]))) : ''}</b></div>
    ${loanCards ? `<p class="small muted" style="margin:0 4px 8px">Stan w miesiącu: ${monthWord}</p>${loanCards}` : '<p class="muted small">Brak kredytów.</p>'}
    <button class="btn block" data-action="add-account" data-group="loan">+ Dodaj kredyt</button>

    <div class="sec-head"><h2>Konta bieżące</h2><b class="num">${esc(formatMoney(sumPLN(current, (a) => bal[a.id])))}</b></div>
    <div class="list">${current.map((a) => `<button class="item" data-action="account-detail" data-id="${esc(a.id)}" data-lp="acc:${esc(a.id)}">
      <span class="ico">${accIco(a)}</span>
      <span class="mid"><span class="t1">${esc(a.name)}</span><span class="t2">${esc(accountKindLabel(a))}</span></span>
      <span class="amt num ${bal[a.id] < 0 ? 'neg' : ''}">${esc(formatMoney(bal[a.id], a.currency))}</span></button>`).join('')}</div>
    ${current.filter(looksLikeProperty).map((a) => `<div class="note small">🏠 „${esc(a.name)}” wygląda na nieruchomość. <button class="link" data-action="to-property" data-id="${esc(a.id)}">Przenieś do Nieruchomości</button></div>`).join('')}
    <div class="actions"><button class="btn block" data-action="add-account" data-group="current">+ Dodaj konto</button></div>

    ${archived.length ? `<p class="small muted" style="margin-top:16px">Zarchiwizowane: ${archived.map((a) => `<button class="link" data-action="edit-account" data-id="${esc(a.id)}">${esc(a.name)}</button>`).join(', ')}</p>` : ''}
    <p class="note">Wpłaty na oszczędności i spłaty kredytów to przeniesienia pieniędzy — nie są liczone jako wydatki i nie zmieniają majątku netto (chyba że wybierzesz „tylko zapis”).</p>`;
}

function openAccountSheet(id, group) {
  const a = id ? accById()[id] : null;
  group = a ? accountGroup(a) : (group || 'current');
  const used = id && state.data.transactions.some((t) => t.accountId === id || t.toAccountId === id);
  let subtype = a?.subtype || (a?.type === 'savings' ? 'deposit' : a ? 'other' : 'deposit');
  const title = a ? 'Edytuj' : { savings: 'Nowe oszczędności / inwestycja', loan: 'Nowy kredyt', current: 'Nowe konto', property: 'Nieruchomość / aktywo' }[group];
  if (group === 'property' && !a) subtype = 'flat';
  const curSelect = `<label class="field"><span>Waluta</span><select id="a-cur" ${used ? 'disabled' : ''}>${CURRENCIES.map((c) => `<option ${(a?.currency || 'PLN') === c ? 'selected' : ''}>${c}</option>`).join('')}</select></label>`;
  let body = '';
  if (group === 'savings') {
    body = `<div class="field"><span>Rodzaj</span><div class="chips wrap" id="a-kind">${Object.entries(SAVINGS_KINDS).map(([k, v]) =>
      `<button type="button" class="chip" data-kind="${k}" aria-pressed="${k === subtype}">${v.icon} ${esc(v.label)}</button>`).join('')}</div></div>
      <label class="field"><span>Nazwa</span><input id="a-name" maxlength="60" value="${esc(a?.name || '')}" placeholder="np. IKE w XTB, Lokata mBank"></label>
      <label class="field"><span>Opis (opcjonalnie)</span><input id="a-desc" maxlength="120" value="${esc(a?.description || '')}" placeholder="np. na emeryturę, ETF na MSCI World"></label>
      <div id="a-metal" ${metalOf({ subtype }) ? '' : 'hidden'}>
        <div class="grid2"><label class="field"><span>Ilość</span><input id="a-grams" inputmode="decimal" placeholder="np. 31,1" value="${a?.grams != null ? esc(String(Math.round(a.grams * 1000) / 1000).replace('.', ',')) : ''}"></label>
          <label class="field"><span>Jednostka</span><select id="a-unit"><option value="g">gramy</option><option value="oz">uncje (31,1 g)</option></select></label></div>
        <div class="grid2"><label class="field"><span>Próba</span><select id="a-purity">${PURITIES.map(([v, l]) => `<option value="${v}" ${(a?.purity || 0.9999) === v ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></label>
          <label class="field"><span>Cena skupu − % (opcj.)</span><input id="a-spread" inputmode="decimal" placeholder="np. 3" value="${a?.spread ? esc(String(a.spread).replace('.', ',')) : ''}"></label></div>
        <p class="small muted">Wartość liczy się sama: złoto wg ceny NBP, srebro wg gold-api.com (przeliczone kursem USD z NBP).</p>
      </div>
      <div class="grid2"><label class="field"><span id="a-open-label">${a ? 'Kwota początkowa' : 'Ile jest tam teraz'}</span><input id="a-open" inputmode="decimal" value="${a ? esc(minorToInput(a.openingBalance)) : ''}" placeholder="0,00"></label>${curSelect}</div>
      ${depositFieldsHtml(a, subtype)}
      <p class="small muted">Kolejne wpłaty i wypłaty dodajesz przyciskami na karcie.</p>`;
  } else if (group === 'property') {
    const loansList = state.data.accounts.filter((x) => x.type === 'loan' && !x.archived);
    body = `<div class="field"><span>Rodzaj</span><div class="chips wrap" id="a-kind">${Object.entries(PROPERTY_KINDS).map(([k, v]) =>
      `<button type="button" class="chip" data-kind="${k}" aria-pressed="${k === subtype}">${v.icon} ${esc(v.label)}</button>`).join('')}</div></div>
      <label class="field"><span>Nazwa</span><input id="a-name" maxlength="60" value="${esc(a?.name || '')}" placeholder="np. Mieszkanie Kraków, Toyota"></label>
      <label class="field"><span>Opis (opcjonalnie)</span><input id="a-desc" maxlength="120" value="${esc(a?.description || '')}" placeholder="np. 54 m², 3 pokoje"></label>
      <label class="field"><span>${a ? 'Wartość początkowa' : 'Ile jest warte teraz'}</span><input id="a-open" class="amount-input" inputmode="decimal" value="${a ? esc(minorToInput(a.openingBalance)) : ''}" placeholder="0,00"></label>
      ${a ? '<p class="small muted">Aktualną wartość zmieniasz przyciskiem „Aktualizuj wartość” na karcie — wtedy zostaje historia wycen.</p>' : ''}
      <div class="grid2">
        <label class="field"><span>Cena zakupu (opcj.)</span><input id="a-pprice" inputmode="decimal" value="${a?.purchasePrice ? esc(minorToInput(a.purchasePrice)) : ''}" placeholder="0,00"></label>
        <label class="field"><span>Rok zakupu (opcj.)</span><input id="a-pyear" type="number" inputmode="numeric" min="1950" max="2100" value="${a?.purchaseYear || ''}"></label>
      </div>
      <label class="field"><span>Zmiana wartości w symulacji, % rocznie</span><input id="a-growth" inputmode="decimal" value="${esc(String(a?.growth ?? PROPERTY_KINDS[subtype]?.growth ?? 0).replace('.', ','))}"></label>
      <p class="small muted">Np. mieszkanie +3%, samochód −10% (traci na wartości).</p>
      <label class="field"><span>Powiązany kredyt (opcj.)</span><select id="a-loan"><option value="">— brak —</option>
        ${loansList.map((l) => `<option value="${esc(l.id)}" ${a?.loanId === l.id ? 'selected' : ''}>${esc(l.name)}</option>`).join('')}</select></label>
      ${curSelect}`;
  } else if (group === 'loan') {
    body = `<label class="field"><span>Nazwa kredytu</span><input id="a-name" maxlength="60" value="${esc(a?.name || '')}" placeholder="np. Hipoteka PKO, Kredyt na auto"></label>
      <label class="field"><span>Opis (opcjonalnie)</span><input id="a-desc" maxlength="120" value="${esc(a?.description || '')}" placeholder="np. do 2045, oprocentowanie zmienne"></label>
      <label class="field"><span>${a ? 'Do spłaty na start (zanim zacząłeś zapisywać spłaty)' : 'Ile zostało do spłaty teraz'}</span><input id="a-open" class="amount-input" inputmode="decimal" value="${a ? esc(minorToInput(-a.openingBalance)) : ''}" placeholder="0,00"></label>
      <label class="field"><span>Oprocentowanie % rocznie (opcj. — do symulacji)</span><input id="a-rate" inputmode="decimal" placeholder="np. 7,5" value="${a?.loanRate != null ? esc(String(a.loanRate).replace('.', ',')) : ''}"></label>
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
    ${imagePickerHtml()}
    ${a && (group === 'savings' || group === 'current') ? `<button type="button" class="btn block" data-action="to-property" data-id="${esc(a.id)}" data-close="1" style="margin-top:12px">🏠 Przenieś do „Nieruchomości i inne aktywa”</button>` : ''}
    ${a ? `<label class="check"><input type="checkbox" id="a-arch" ${a.archived ? 'checked' : ''}> Zarchiwizuj (ukryj, historia zostaje)</label>` : ''}
    <div class="err" id="a-err" role="alert"></div>
    <div class="actions ${a ? 'two' : ''}">${a ? `<button class="btn danger" data-action="del-account" data-id="${esc(a.id)}">Usuń</button>` : ''}<button class="btn primary block" id="a-save">Zapisz</button></div>`);
  const pick = mountImagePicker(a?.image, { preview: () => badgeHtml(badgeFor($('#a-name')?.value || a?.name || '?', accountKindKey({ ...(a || {}), type: group === 'property' ? 'property' : group === 'loan' ? 'loan' : (a?.type || 'checking'), subtype }))) });
  $('#a-name')?.addEventListener('input', () => { if (!pick.get()) $('#img-prev').innerHTML = badgeHtml(badgeFor($('#a-name').value || '?', accountKindKey({ type: group === 'property' ? 'property' : group === 'loan' ? 'loan' : (a?.type || 'checking'), subtype }))); });
  const dep = mountDepositFields(() => subtype);
  const paintMetal = () => {
    dep.paint();
    const box = $('#a-metal');
    if (!box) return;
    const metal = !!metalOf({ subtype });
    box.hidden = !metal;
    $('#a-open-label').textContent = metal ? 'Ile za to zapłaciłeś (wpłacony kapitał)' : (a ? 'Kwota początkowa' : 'Ile jest tam teraz');
  };
  const kinds = $('#a-kind');
  if (kinds) {
    kinds.onclick = (e) => {
      const b = e.target.closest('[data-kind]');
      if (!b) return;
      const prevDefault = PROPERTY_KINDS[subtype]?.growth;
      subtype = b.dataset.kind;
      kinds.querySelectorAll('[data-kind]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
      paintMetal();
      const g = $('#a-growth');
      if (g && PROPERTY_KINDS[subtype] && (g.value === '' || Number(g.value.replace(',', '.')) === prevDefault)) g.value = String(PROPERTY_KINDS[subtype].growth).replace('.', ',');
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
      const d = dep.read();
      if (d.error) return err(d.error);
      Object.assign(item, d.data);
      if (metalOf(item)) {
        const g = Number(($('#a-grams').value || '0').replace(/\s/g, '').replace(',', '.'));
        const spread = Number(($('#a-spread').value || '0').replace(',', '.'));
        if (!Number.isFinite(g) || g < 0) return err('Nieprawidłowa ilość.');
        if (!Number.isFinite(spread) || spread < 0 || spread > 50) return err('Cena skupu: od 0 do 50%.');
        item.grams = Math.round(($('#a-unit').value === 'oz' ? g * TROY_OUNCE_G : g) * 10000) / 10000;
        item.purity = Number($('#a-purity').value);
        item.spread = spread;
      }
    } else if (group === 'property') {
      const pprice = opt('#a-pprice');
      const year = $('#a-pyear').value.trim();
      const growth = Number(($('#a-growth').value || '0').replace(',', '.'));
      if (!Number.isInteger(pprice) || pprice < 0) return err('Nieprawidłowa cena zakupu.');
      if (year && !(Number(year) >= 1900 && Number(year) <= 2100)) return err('Nieprawidłowy rok zakupu.');
      if (!Number.isFinite(growth) || growth < -50 || growth > 50) return err('Zmiana wartości: od −50 do 50% rocznie.');
      if (opening < 0) return err('Wartość nie może być ujemna.');
      item.type = 'property';
      item.subtype = subtype;
      item.description = $('#a-desc').value.trim();
      item.purchasePrice = pprice || null;
      item.purchaseYear = year ? Number(year) : null;
      item.growth = growth;
      item.loanId = $('#a-loan').value || null;
    } else if (group === 'loan') {
      const inst = opt('#a-inst');
      const orig = opt('#a-orig');
      if (opening < 0 || !Number.isInteger(inst) || !Number.isInteger(orig) || inst < 0 || orig < 0) return err('Wpisz kwoty bez minusa.');
      opening = -opening; // dług zapisujemy jako saldo ujemne
      item.type = 'loan';
      item.description = $('#a-desc').value.trim();
      const rateRaw = $('#a-rate').value.trim().replace(',', '.');
      if (rateRaw && !(Number(rateRaw) >= 0 && Number(rateRaw) <= 50)) return err('Oprocentowanie od 0 do 50%.');
      item.loanRate = rateRaw ? Number(rateRaw) : null;
      item.installment = inst || null;
      item.loanOriginal = orig || null;
    } else {
      item.type = $('#a-type').value;
    }
    item.openingBalance = opening;
    item.image = pick.get() || null;
    await db.put('accounts', item);
    closeSheet();
    await reload();
    toast('Zapisano');
    if (metalOf(item)) refreshMetalPrices({ force: !state.prices?.[metalOf(item)] });
    if (!a && (metalOf(item) || isCrypto(item)) && !positionsOf(item).length) { state.openPos = { ...state.openPos, [item.id]: true }; openPositionSheet(item.id); }
  };
}

/** Szczegóły konta: historia operacji. */
function openAccountDetail(id) {
  const a = accById()[id];
  if (!a) return;
  const cats = catById();
  const accs = accById();
  const txs = liveTx().filter((t) => t.accountId === id || t.toAccountId === id).sort(byDateDesc);
  const bookNow = balances([a], liveTx())[id];
  const isLoan = a.type === 'loan';
  const isProp = accountGroup(a) === 'property';
  const inv = accountGroup(a) === 'savings' || isProp ? posResult(a, investmentResult(a, liveTx(), valOpts())) : null;
  const bal = inv ? inv.value : bookNow;
  openSheet(a.name, `
    <p class="muted small" style="margin-top:0">${esc(accountKindLabel(a))}${a.description ? ' · ' + esc(a.description) : ''}</p>
    <div class="stat-row" style="grid-template-columns:1fr 1fr">
      <div class="stat"><small>${isLoan ? 'Do spłaty' : inv ? 'Wartość' : 'Saldo'}</small><b class="num">${esc(formatMoney(isLoan ? -bal : bal, a.currency))}</b></div>
      <div class="stat"><small>${isLoan ? 'Na start' : isProp ? 'Wartość początkowa' : inv ? 'Wpłacono na start' : 'Saldo początkowe'}</small><b class="num">${esc(formatMoney(isLoan ? -a.openingBalance : a.openingBalance, a.currency))}</b></div>
    </div>
    ${isProp && a.purchasePrice ? `<p class="small" style="margin:10px 4px 0">Kupione za <span class="num">${esc(formatMoney(a.purchasePrice, a.currency))}</span>${a.purchaseYear ? ` (${a.purchaseYear})` : ''} · zmiana <b class="num ${inv.value - a.purchasePrice >= 0 ? 'pos' : 'neg'}">${esc(formatMoney(inv.value - a.purchasePrice, a.currency, { sign: true }))}</b></p>` : ''}
    ${inv && !isProp && (metalOf(a) || (a.valuations || []).length) ? `<p class="small" style="margin:10px 4px 0">Wpłacono <span class="num">${esc(formatMoney(inv.paidIn, a.currency))}</span> · ${inv.gain >= 0 ? 'zysk' : 'strata'} <b class="num ${inv.gain >= 0 ? 'pos' : 'neg'}">${esc(formatMoney(inv.gain, a.currency, { sign: true }))}${inv.gainPct != null ? ` (${esc(fmtPct(inv.gainPct * 100))})` : ''}</b></p>` : ''}
    ${metalOf(a) && positionsOf(a).length <= 1 ? `<p class="small muted" style="margin:6px 4px 0">${metalLine(a)}</p>` : ''}
    ${metalOf(a) || isCrypto(a) ? `<div style="margin-top:10px">${positionsHtml(a).replace('<details class="pos"', '<details class="pos" open')}</div>` : ''}
    ${inv ? valuationHistoryHtml(a) : ''}
    ${inv && !metalOf(a) ? `<div class="actions"><button class="btn primary block" data-action="valuate" data-id="${esc(id)}">📈 Aktualizuj wartość</button></div>` : ''}
    <h3 class="small muted" style="margin:16px 4px 6px">Wpłaty i wypłaty</h3>
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
  const metal = metalOf(a);
  const crypto = isCrypto(a) && positionsOf(a).length > 0;
  const posList = metal || crypto ? positionsOf(a) : [];
  const posSel = posList.length ? `<label class="field"><span>Pozycja</span><select id="mv-pos">${posList.map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('')}${mode === 'in' ? '<option value="__new">+ Nowa pozycja…</option>' : ''}</select></label>
      <label class="field" id="mv-newname-wrap" hidden><span>Nazwa nowej pozycji</span><input id="mv-newname" maxlength="40" placeholder="np. Monety"></label>` : '';
  const titles = metal || crypto ? { in: `Kupno: ${a.name}`, out: `Sprzedaż: ${a.name}` } : { in: `Wpłata: ${a.name}`, out: `Wypłata: ${a.name}`, pay: `Spłata: ${a.name}` };
  const defDesc = metal || crypto ? { in: 'Kupno', out: 'Sprzedaż' }[mode] : { in: 'Wpłata', out: 'Wypłata', pay: 'Spłata kredytu' }[mode];
  const otherLabel = mode === 'out' ? 'Na które konto trafiają pieniądze' : 'Z którego konta';
  const none = mode === 'out' ? 'Nie dodawaj do żadnego konta (tylko zapis)' : 'Nie odejmuj z żadnego konta (tylko zapis)';
  const prefill = mode === 'pay' && a.installment ? minorToInput(a.installment) : '';
  openSheet(titles[mode], `
    ${posSel}
    <label class="field"><span>${metal || crypto ? (mode === 'in' ? 'Ile zapłaciłeś' : 'Ile dostałeś') : 'Kwota'}</span><input id="mv-amount" class="amount-input" inputmode="decimal" placeholder="0,00" value="${esc(prefill)}" autocomplete="off"></label>
    ${metal ? `<div class="grid2"><label class="field"><span>${mode === 'in' ? 'Ile kupiłeś' : 'Ile sprzedałeś'}</span><input id="mv-grams" inputmode="decimal" placeholder="np. 31,1"></label>
      <label class="field"><span>Jednostka</span><select id="mv-unit"><option value="g">gramy</option><option value="oz">uncje</option></select></label></div>` : ''}
    ${crypto ? `<label class="field"><span>${mode === 'in' ? 'Ile kupiłeś' : 'Ile sprzedałeś'} (sztuk)</span><input id="mv-qty" inputmode="decimal" placeholder="np. 0,01"></label>` : ''}
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
  $('#mv-pos')?.addEventListener('change', (e) => { $('#mv-newname-wrap').hidden = e.target.value !== '__new'; });
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
    let grams = 0;
    if (metal) {
      grams = Number(($('#mv-grams').value || '0').replace(/\s/g, '').replace(',', '.'));
      if (!Number.isFinite(grams) || grams < 0) { $('#mv-err').textContent = 'Nieprawidłowa ilość.'; return; }
      if ($('#mv-unit').value === 'oz') grams *= TROY_OUNCE_G;
    }
    let qty = 0;
    if (crypto) {
      qty = Number(($('#mv-qty').value || '0').replace(/\s/g, '').replace(',', '.'));
      if (!Number.isFinite(qty) || qty < 0) { $('#mv-err').textContent = 'Nieprawidłowa ilość.'; return; }
    }
    let pid = $('#mv-pos')?.value || null;
    if (pid === '__new' && !$('#mv-newname').value.trim()) { $('#mv-err').textContent = 'Wpisz nazwę nowej pozycji.'; return; }
    await db.put('transactions', t);
    if (posList.length && (grams || qty)) {
      let list = positionsOf(a);
      if (pid === '__new') {
        const np = { id: db.newId('pos'), name: $('#mv-newname').value.trim(), paid: 0, ...(metal ? { grams: 0, purity: 0.9999, spread: 0 } : { amount: 0, coin: null, symbol: '' }) };
        list = [...list, np];
        pid = np.id;
      }
      list = list.map((p) => (p.id === pid ? applyTrade(p, { qty: metal ? grams : qty, amount: t.amount, sell: mode === 'out', field: metal ? 'grams' : 'amount' }) : p));
      await savePositions(a, list);
    } else if (metal && grams) {
      const g = Math.max(0, Math.round(((Number(a.grams) || 0) + (mode === 'out' ? -grams : grams)) * 10000) / 10000);
      await db.put('accounts', { ...a, grams: g });
    }
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
  const diffLine = (c) => `<li><div class="row"><span>${catIco(c.categoryId, cats, { mini: true })} ${esc(catLabel(c.categoryId, cats))}</span>
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
  const body = tab === 'analysis' ? viewAnalytics() : tab === 'ai' ? viewAI() : tab === 'sim' ? viewSim() : viewPurchases();
  return `<div class="seg plans-seg">${t('buy', '🛒 Zakupy')}${t('sim', '🔮 Symulacja')}${t('analysis', '📊 Analiza')}${t('ai', '✨ AI')}</div>${body}`;
}

function purchaseContext(p) {
  const txs = liveTx();
  const vals = valuedNetWorth(state.data.accounts, txs, valOpts()).values;
  const bookB = balances(state.data.accounts, txs);
  const bal = new Proxy({}, { get: (_, id) => vals[id] ?? bookB[id] });
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
      <span class="ico">${ico(p.icon || '🛒', p.image)}</span>
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
    ${imagePickerHtml()}
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
  const pick = mountImagePicker(p?.image);
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
      image: pick.get() || null,
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
  const w = valuedNetWorth(state.data.accounts, liveTx(), valOpts());
  return buildAIContext(state.data, state.month, { purchases: state.data.purchases, purchaseAnalysis: analysis, values: w.values, netWorth: w });
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

// ---------- Wybór obrazka (konta, plan, zakupy, kategorie, profil) ----------
function imagePickerHtml({ label = 'Obrazek (opcjonalnie — zastępuje ikonę)' } = {}) {
  return `<div class="field imgpick"><span>${label}</span>
    <div class="imgpick-row"><div class="img-prev" id="img-prev"></div>
      <div class="img-btns">
        <button type="button" class="btn" data-img="search">🔎 Szukaj obrazka</button>
        <button type="button" class="btn" data-img="file">📷 Z telefonu</button>
        <button type="button" class="btn" data-img="clear">✨ Generowana</button>
      </div></div>
    <div id="img-extra"></div>
    <p class="small muted" id="img-status"></p>
    <input type="file" id="img-file" accept="image/*" hidden>
  </div>`;
}

/** preview: (current) => HTML podglądu, gdy brak obrazka (np. generowana plakietka). */
function mountImagePicker(initial, { preview = () => '<span class="muted small">brak</span>' } = {}) {
  let current = sanitizeImage(initial);
  const box = $('#sheet .imgpick');
  const status = (html, cls = 'muted') => { const el = $('#img-status'); el.className = 'small ' + cls; el.innerHTML = html; };
  const paint = () => {
    $('#img-prev').innerHTML = current ? `<img src="${esc(current)}" alt="" referrerpolicy="no-referrer">` : preview();
    box.querySelector('[data-img="clear"]').hidden = !current;
  };
  paint();
  const fetchInto = async (url) => {
    status('Zapisuję…');
    try {
      current = await imageViaCanvas(url).catch(() => imageFromUrl(url, 'cover'));
      status('✓ Zapisano małą kopię w telefonie — obrazek nie będzie już pobierany z sieci.', 'pos');
    } catch {
      // serwer nie pozwala zrobić kopii — wyświetlamy obrazek bezpośrednio z darmowego serwera
      current = url;
      status(`✓ Wybrano. Obrazek będzie wyświetlany z ${esc(new URL(url).hostname)} (serwer nie dostaje żadnych Twoich danych).`, 'pos');
    }
    paint();
    $('#img-extra').innerHTML = '';
  };
  const doSearch = async () => {
    const q = $('#img-q').value.trim();
    const res = $('#img-res');
    status('Szukam…');
    res.innerHTML = '';
    try {
      const { results: list, problems } = await searchImages(q);
      res.innerHTML = list.map((x, i) => `<button type="button" data-pick="${i}" title="${esc(x.title)}${x.creator ? ' — ' + esc(x.creator) : ''} (${esc(x.license)})"><img src="${esc(x.thumb)}" alt="${esc(x.title)}" loading="lazy" referrerpolicy="no-referrer"></button>`).join('');
      status(`Znaleziono ${list.length}. Dotknij obrazka, żeby go wybrać. Źródła: Wikimedia Commons i Openverse (wolne licencje).${problems.length ? ` <span class="muted">(${esc(problems.join('; '))})</span>` : ''}`);
      res.onclick = (e) => { const b = e.target.closest('[data-pick]'); if (b) fetchInto(list[Number(b.dataset.pick)].thumb); };
    } catch (err) {
      status(esc(err.message), 'neg');
    }
  };
  box.onclick = (e) => {
    const b = e.target.closest('[data-img]');
    if (!b) return;
    const kind = b.dataset.img;
    if (kind === 'file') { $('#img-file').click(); return; }
    if (kind === 'clear') { current = null; $('#img-extra').innerHTML = ''; paint(); status('Ikona będzie generowana automatycznie.'); return; }
    if (kind === 'search') {
      $('#img-extra').innerHTML = `<div class="qa"><input id="img-q" placeholder="np. dom, auto, wakacje, house" autocomplete="off" enterkeyhint="search"><button type="button" class="btn primary" id="img-go">Szukaj</button></div>
        <div class="img-results" id="img-res"></div>
        <p class="small muted">Wysyłane jest tylko wpisane słowo. Po angielsku zwykle jest więcej wyników.</p>`;
      $('#img-go').onclick = doSearch;
      $('#img-q').onkeydown = (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); doSearch(); } };
      $('#img-q').focus();
    }
  };
  $('#img-file').onchange = async (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    status('Przetwarzam…');
    try {
      current = await imageFromFile(f);
      paint();
      status('✓ Zapisano w telefonie (nic nie zostało wysłane do sieci).', 'pos');
    } catch (err) {
      status(esc(err.message), 'neg');
    }
  };
  return { get: () => current };
}

// ---------- Ikony generowane ----------
const genIconsOn = () => getPref('sf-genicons', '1') === '1';

function badgeHtml(b, { mini = false } = {}) {
  if (b.emoji) {
    return mini ? `<span class="gen-mini" style="background:${b.bg}">${b.emoji}</span>`
      : `<span class="gen gen-emoji" style="background:${b.bg}">${b.emoji}</span>`;
  }
  const text = esc(b.text);
  const len = [...b.text].length;
  return mini ? `<span class="gen-mini" style="background:${b.bg};color:${b.fg}">${text}</span>`
    : `<span class="gen ${len >= 4 ? 'len4' : len === 3 ? 'len3' : ''}" style="background:${b.bg};color:${b.fg}">${text}</span>`;
}

function accountKindKey(a) {
  if (a.type === 'property') return a.subtype || 'property_other';
  if (a.type === 'loan') return 'loan';
  if (a.subtype && a.subtype !== 'other') return a.subtype;
  if (a.type === 'cash') return 'cash';
  return null;
}

/** Ikona konta: własny obrazek → plakietka generowana (marka/rodzaj/inicjały) → emoji. */
function accIco(a, opts = {}) {
  if (sanitizeImage(a.image)) return ico('', a.image, opts);
  if (genIconsOn()) return badgeHtml(badgeFor(a.name, accountKindKey(a)), opts);
  return ico(accountIcon(a), null, opts);
}

/** Ikona pozycji planu: własny obrazek → plakietka marki (np. Orlen, PGE, Netflix) → emoji. */
function billIco(b, fallback, opts = {}) {
  if (sanitizeImage(b.image)) return ico('', b.image, opts);
  const brand = genIconsOn() ? brandOf(b.name) : null;
  if (brand) return badgeHtml({ text: brand.short || initials(b.name), bg: brand.bg, fg: brand.fg }, opts);
  return ico(b.icon || fallback, null, opts);
}

// ---------- Profil ----------
function profileAvatar(opts = {}) {
  const p = state.profile || {};
  if (sanitizeImage(p.avatar)) return `<img src="${esc(p.avatar)}" alt="">`;
  if (p.name) return badgeHtml(badgeFor(p.name), opts);
  return '<span>👤</span>';
}

function openProfileSheet() {
  const p = state.profile || {};
  openSheet('Profil', `
    <label class="field"><span>Imię</span><input id="pr-name" maxlength="30" value="${esc(p.name || '')}" placeholder="np. Dawid" autocomplete="given-name"></label>
    ${imagePickerHtml({ label: 'Avatar' })}
    <p class="small muted">Imię i avatar są tylko w tym telefonie. Pojawiają się na ekranie Start, w animacji startowej i na ekranie blokady.</p>
    <div class="actions"><button class="btn primary block" id="pr-save">Zapisz</button></div>`);
  const pick = mountImagePicker(p.avatar, { preview: () => (($('#pr-name')?.value || p.name) ? badgeHtml(badgeFor($('#pr-name')?.value || p.name)) : '<span>👤</span>') });
  $('#pr-name').oninput = () => { if (!pick.get()) $('#img-prev').innerHTML = $('#pr-name').value ? badgeHtml(badgeFor($('#pr-name').value)) : '<span>👤</span>'; };
  $('#pr-save').onclick = async () => {
    state.profile = { name: $('#pr-name').value.trim(), avatar: pick.get() || null };
    await db.setSetting('profile', state.profile);
    setPref('sf-name', state.profile.name);
    closeSheet();
    render();
    toast('Zapisano profil');
  };
}

// ---------- Animacja startowa ----------
function runSplash() {
  const el = $('#splash');
  if (!el) return;
  const off = getPref('sf-splash', '1') !== '1' || matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (off) { el.remove(); return; }
  const name = getPref('sf-name', '');
  $('#splash-hello').textContent = name ? `Cześć, ${name}!` : '';
  const hide = () => { el.classList.add('hide'); setTimeout(() => el.remove(), 400); };
  const left = Math.max(0, 2000 - performance.now());
  const t = setTimeout(hide, left);
  el.addEventListener('pointerdown', () => { clearTimeout(t); hide(); }, { once: true });
}

// ---------- Blokada (PIN / odcisk palca) ----------
const lockCfg = () => { try { return JSON.parse(localStorage.getItem('sf-lock') || 'null'); } catch { return null; } };
const saveLockCfg = (c) => { try { if (c) localStorage.setItem('sf-lock', JSON.stringify(c)); else localStorage.removeItem('sf-lock'); } catch { /* brak dostępu */ } };
let lockState = { input: '', resolve: null, hiddenAt: null };

function lockEnabled() { return !!lockCfg()?.pin; }

function showLock() {
  if (!lockEnabled()) return Promise.resolve();
  if (lockState.resolve) return lockState.promise;
  const cfg = lockCfg();
  const el = $('#lock');
  el.hidden = false;
  $('#sheet').open && $('#sheet').close();
  $('#lock-avatar').innerHTML = profileAvatar();
  $('#lock-hello').textContent = state.profile?.name ? `Cześć, ${state.profile.name}` : 'Wpisz PIN';
  $('#lock-bio').hidden = !cfg.bio;
  lockState.input = '';
  paintDots();
  lockState.promise = new Promise((res) => { lockState.resolve = res; });
  if (cfg.bio) setTimeout(tryBio, 300);
  return lockState.promise;
}

function unlock() {
  $('#lock').hidden = true;
  const cfg = lockCfg();
  if (cfg) saveLockCfg({ ...cfg, failed: 0, until: 0 });
  const r = lockState.resolve;
  lockState.resolve = null;
  r && r();
}

function paintDots() {
  const n = Math.max(4, lockState.input.length);
  $('#lock-dots').innerHTML = Array.from({ length: n }, (_, i) => `<i class="${i < lockState.input.length ? 'on' : ''}"></i>`).join('');
}

async function tryBio() {
  const cfg = lockCfg();
  if (!cfg?.bio) return;
  try {
    if (await verifyBiometric(cfg.bio)) unlock();
  } catch { $('#lock-msg').textContent = 'Użyj PIN-u albo dotknij ☝️, żeby spróbować ponownie.'; }
}

async function pinKey(k) {
  const cfg = lockCfg();
  const wait = Math.ceil(((cfg.until || 0) - Date.now()) / 1000);
  if (wait > 0) { $('#lock-msg').textContent = `Za dużo prób. Spróbuj za ${wait} s.`; return; }
  if (k === 'bio') { tryBio(); return; }
  if (k === 'del') lockState.input = lockState.input.slice(0, -1);
  else if (lockState.input.length < 8) lockState.input += k;
  $('#lock-msg').textContent = '';
  paintDots();
  if (lockState.input.length >= (cfg.pinLength || 4)) {
    const ok = await verifyPin(lockState.input, cfg.pin);
    if (ok) { unlock(); return; }
    if (lockState.input.length >= (cfg.pinLength || 4)) {
      const failed = (cfg.failed || 0) + 1;
      const secs = lockoutSeconds(failed);
      saveLockCfg({ ...cfg, failed, until: secs ? Date.now() + secs * 1000 : 0 });
      lockState.input = '';
      paintDots();
      $('#lock-msg').textContent = secs ? `Błędny PIN. Następna próba za ${secs} s.` : 'Błędny PIN';
      if (navigator.vibrate) try { navigator.vibrate([60, 40, 60]); } catch { /* brak */ }
    }
  }
}

function setupLock() {
  $('#lock-pad').addEventListener('click', (e) => { const b = e.target.closest('[data-k]'); if (b) pinKey(b.dataset.k); });
  document.addEventListener('keydown', (e) => {
    if ($('#lock').hidden) return;
    if (/^\d$/.test(e.key)) pinKey(e.key); else if (e.key === 'Backspace') pinKey('del');
  });
  $('#lock-forgot').onclick = async () => {
    $('#lock').hidden = true;
    const ok = await confirmSheet('Nie pamiętasz PIN-u?',
      'PIN-u nie da się odzyskać — jest zapisany tylko jako zaszyfrowany skrót. Możesz usunąć wszystkie dane z tego telefonu (i potem przywrócić je z kopii zapasowej).',
      { confirmLabel: 'Usuń dane i blokadę', danger: true, typeToConfirm: 'USUŃ' });
    if (ok) {
      await db.wipeAll();
      await db.ensureDefaults();
      saveLockCfg(null);
      unlock();
      await reload();
      toast('Usunięto dane i blokadę. Możesz przywrócić kopię w Ustawieniach.');
    } else {
      $('#lock').hidden = false;
    }
  };
  document.addEventListener('visibilitychange', () => {
    if (!lockEnabled()) return;
    const cfg = lockCfg();
    if (document.hidden) {
      lockState.hiddenAt = Date.now();
      if (!cfg.timeout) showLock(); // natychmiast: zasłoń też podgląd w ostatnich aplikacjach
    } else if (lockState.hiddenAt && Date.now() - lockState.hiddenAt >= (cfg.timeout || 0) * 60000) {
      showLock();
    }
  });
}

async function openPinSetup({ change = false } = {}) {
  const cfg = lockCfg();
  openSheet(change ? 'Zmień PIN' : 'Ustaw PIN', `
    ${change ? '<label class="field"><span>Obecny PIN</span><input id="pin-old" type="password" inputmode="numeric" maxlength="8" autocomplete="off"></label>' : ''}
    <label class="field"><span>Nowy PIN (4–8 cyfr)</span><input id="pin-1" type="password" inputmode="numeric" maxlength="8" autocomplete="off"></label>
    <label class="field"><span>Powtórz PIN</span><input id="pin-2" type="password" inputmode="numeric" maxlength="8" autocomplete="off"></label>
    <div class="err" id="pin-err" role="alert"></div>
    <p class="small muted">PIN jest zapisany tylko jako zaszyfrowany skrót w tym telefonie. Nie da się go odzyskać — w razie zapomnienia trzeba usunąć dane i przywrócić kopię zapasową.</p>
    <div class="actions"><button class="btn primary block" id="pin-save">Zapisz PIN</button></div>`);
  focusLater(change ? '#pin-old' : '#pin-1');
  $('#pin-save').onclick = async () => {
    const err = (m) => { $('#pin-err').textContent = m; };
    if (change && !(await verifyPin($('#pin-old').value, cfg?.pin))) return err('Obecny PIN jest błędny.');
    const a = $('#pin-1').value; const b = $('#pin-2').value;
    if (!PIN_RE.test(a)) return err('PIN musi mieć od 4 do 8 cyfr.');
    if (a !== b) return err('PIN-y się różnią.');
    const pin = await hashPin(a);
    saveLockCfg({ ...(cfg || { timeout: 1 }), pin, pinLength: a.length, failed: 0, until: 0 });
    closeSheet();
    render();
    toast(change ? 'Zmieniono PIN' : 'Blokada włączona');
  };
}

async function disableLock() {
  const cfg = lockCfg();
  openSheet('Wyłącz blokadę', `<label class="field"><span>Wpisz PIN</span><input id="pin-off" type="password" inputmode="numeric" maxlength="8" autocomplete="off"></label>
    <div class="err" id="pin-err" role="alert"></div>
    <div class="actions"><button class="btn danger block" id="pin-off-go">Wyłącz blokadę</button></div>`);
  focusLater('#pin-off');
  $('#pin-off-go').onclick = async () => {
    if (!(await verifyPin($('#pin-off').value, cfg?.pin))) { $('#pin-err').textContent = 'Błędny PIN.'; return; }
    saveLockCfg(null);
    closeSheet();
    render();
    toast('Blokada wyłączona');
  };
}

async function toggleBio(on) {
  const cfg = lockCfg();
  if (!cfg) return;
  if (!on) { saveLockCfg({ ...cfg, bio: null }); render(); return; }
  try {
    const id = await registerBiometric(state.profile?.name || 'Smart Finance');
    saveLockCfg({ ...cfg, bio: id });
    toast('Dodano odblokowanie odciskiem palca');
  } catch (e) {
    toast('Nie udało się: ' + (e?.message || 'anulowano'));
  }
  render();
}

// ---------- Dyktowanie ----------
async function dictateInto(input) {
  if (!speechSupported()) { toast('Ta przeglądarka nie obsługuje dyktowania (użyj Chrome lub Edge)'); return; }
  if (getPref('sf-voice-ok', '') !== '1') {
    // eslint-disable-next-line no-alert
    const ok = window.confirm('Dyktowanie głosem: rozpoznawanie mowy wykonuje przeglądarka — w Chrome i Edge nagranie jest przetwarzane przez serwery Google lub Microsoft. Do aplikacji trafia tylko rozpoznany tekst. Włączyć?');
    if (!ok) return;
    setPref('sf-voice-ok', '1');
  }
  const btn = document.querySelector('.mic');
  btn?.classList.add('on');
  input.placeholder = 'Słucham… powiedz np. „paliwo 250 złotych”';
  try {
    const text = await listen({ onPartial: (t) => { input.value = t; } });
    input.value = text;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  } catch (e) {
    toast(e.message);
  } finally {
    btn?.classList.remove('on');
    input.placeholder = 'Szybko: „Paliwo 250 zł dzisiaj”';
  }
}

// ---------- Usuwanie konta ----------
async function deleteAccountFlow(id) {
  const a = accById()[id];
  if (!a) return;
  const txs = state.data.transactions.filter((t) => !t.deletedAt && (t.accountId === id || t.toAccountId === id));
  const value = accountValue(a, liveTx(), valOpts());
  const ok = await confirmSheet(`Usunąć „${a.name}”?`,
    `Konto${txs.length ? ` i jego <b>${txs.length}</b> transakcji` : ''} trafi do Kosza (Ustawienia → Kosz) — możesz je stamtąd przywrócić.<br><br>
    Majątek netto zmieni się o <b class="num">${esc(formatMoney(-value, a.currency, { sign: true }))}</b>.${txs.some((t) => t.type === 'transfer') ? '<br><br>Przelewy z innymi kontami też trafią do Kosza, więc salda tamtych kont się zmienią.' : ''}`,
    { confirmLabel: 'Usuń konto', danger: true });
  if (!ok) return;
  const now = new Date().toISOString();
  const txIds = new Set(txs.map((t) => t.id));
  await db.put('accounts', { ...a, deletedAt: now });
  if (txs.length) await db.put('transactions', ...txs.map((t) => ({ ...t, deletedAt: now, deletedWithAccount: id })));
  const bills = state.data.bills.filter((b) => b.accountId === id || (b.txId && txIds.has(b.txId)));
  if (bills.length) await db.put('bills', ...bills.map((b) => ({ ...b, accountId: b.accountId === id ? null : b.accountId, ...(b.txId && txIds.has(b.txId) ? { txId: null, txSkipped: true } : {}) })));
  const buys = state.data.purchases.filter((p) => p.accountId === id);
  if (buys.length) await db.put('purchases', ...buys.map((p) => ({ ...p, accountId: null, savedManual: Math.max(0, value) })));
  const linked = state.data.accounts.filter((x) => x.loanId === id);
  if (linked.length) await db.put('accounts', ...linked.map((x) => ({ ...x, loanId: null })));
  if (state.prefs.defaultAccount === id) { state.prefs.defaultAccount = ''; await db.setSetting('defaultAccount', ''); }
  await reload();
  toast(`Usunięto: ${a.name}`, { label: 'Cofnij', run: () => restoreAccount(id) });
}

async function restoreAccount(id) {
  const all = await db.getAll('accounts');
  const a = all.find((x) => x.id === id);
  if (!a) return;
  const { deletedAt, ...live } = a;
  await db.put('accounts', live);
  const txs = state.data.transactions.filter((t) => t.deletedWithAccount === id);
  if (txs.length) await db.put('transactions', ...txs.map(({ deletedAt: d, deletedWithAccount, ...t }) => t));
  await reload();
  toast(`Przywrócono: ${a.name}`);
}

// ---------- Wyceny, metale, wykresy ----------
const valOpts = (asOf) => ({ prices: state.prices, today: todayISO(), ...(asOf ? { asOf } : {}) });
const lastDay = (ym) => dateInMonth(ym, 31);
const fmtGrams = (g) => `${(Math.round((Number(g) || 0) * 100) / 100).toLocaleString('pl-PL')} g`;
const fmtPct = (p) => `${p >= 0 ? '+' : ''}${p.toFixed(2).replace('.', ',')}%`;
const PURITIES = [
  [0.9999, '999,9 (sztabki, monety bulionowe)'], [0.999, '999'], [0.9167, '916,7 (22 karaty, np. Krugerrand)'],
  [0.925, '925 (srebro próby 925)'], [0.9, '900 (stare monety)'], [0.8, '800'], [0.75, '750 (18 karatów)'], [0.585, '585 (14 karatów)'],
];

function metalPriceOnly(a) {
  const p = state.prices?.[metalOf(a)];
  return p?.pln ? `Cena: <span class="num">${esc(formatMoney(Math.round(p.pln * 100)))}</span>/g <span class="muted">(${esc(p.source)}, ${esc(formatDatePL(p.date))})</span>` : '<span class="neg">brak ceny — odśwież ceny</span>';
}

function metalLine(a) {
  const metal = metalOf(a);
  const p = state.prices?.[metal];
  const head = `${fmtGrams(a.grams)} · próba ${String(Math.round((a.purity || 1) * 10000) / 10).replace('.', ',')}${a.spread ? ` · skup −${String(a.spread).replace('.', ',')}%` : ''}`;
  return p?.pln ? `${head} · <span class="num">${esc(formatMoney(Math.round(p.pln * 100)))}</span>/g <span class="muted">(${esc(p.source)}, ${esc(formatDatePL(p.date))})</span>`
    : `${head} · <span class="neg">brak ceny — odśwież ceny</span>`;
}

/** Prosty wykres liniowy (SVG). series: [{ values, color, dash, label }], labels: podpisy osi X. */
function lineChart(series, labels, { height = 170, fromZero = true, fmt = (v) => formatMoney(v).replace(/,00/, '') } = {}) {
  const W = 340; const H = height; const padL = 4; const padB = 20; const top = 18;
  const all = series.flatMap((s) => s.values).filter((v) => Number.isFinite(v));
  if (!all.length) return '<p class="small muted">Brak danych do wykresu.</p>';
  let min = fromZero ? Math.min(0, ...all) : Math.min(...all);
  let max = Math.max(...all);
  if (!fromZero) { const pad = (max - min) * 0.08 || Math.abs(max) * 0.02 || 1; min -= pad; max += pad; }
  if (max === min) max = min + 1;
  const n = Math.max(...series.map((s) => s.values.length));
  const x = (i) => padL + ((W - padL * 2) * i) / Math.max(1, n - 1);
  const y = (v) => top + (H - padB - top) * (1 - (v - min) / (max - min));
  const paths = series.map((s) => {
    const d = s.values.map((v, i) => (Number.isFinite(v) ? `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}` : '')).join('');
    return `<path d="${d}" fill="none" stroke="${s.color}" stroke-width="2.2" ${s.dash ? 'stroke-dasharray="5 4"' : ''} stroke-linejoin="round" stroke-linecap="round"/>`;
  }).join('');
  const step = Math.ceil(n / 6);
  const xl = labels.map((l, i) => (i % step === 0 || i === n - 1 ? `<text x="${x(i)}" y="${H - 5}" text-anchor="${i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle'}">${esc(l)}</text>` : '')).join('');
  const zero = fromZero && min < 0 ? `<line x1="0" x2="${W}" y1="${y(0)}" y2="${y(0)}" stroke="var(--line)"/>` : '';
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Wykres">
    <line x1="0" x2="${W}" y1="${H - padB}" y2="${H - padB}" stroke="var(--line)"/>${zero}
    <text x="2" y="${top - 5}">${esc(fmt(max))}</text>${min < 0 || !fromZero ? `<text x="2" y="${H - padB - 4}">${esc(fmt(min))}</text>` : ''}
    ${paths}${xl}</svg>`;
}

function metalPricesCard(compact = false) {
  const p = state.prices || {};
  const row = (k, label) => `<div class="stat"><small>${label} · zł/g</small><b>${p[k]?.pln ? `<span class="num">${esc(formatMoney(Math.round(p[k].pln * 100)))}</span>` : '—'}</b>
    <small>${p[k]?.date ? esc(formatDatePL(p[k].date)) + ' · ' + esc(p[k].source) : 'brak danych'}</small></div>`;
  const metal = state.metalChart || 'gold';
  const hist = (p.history?.[metal] || []).slice(-365);
  const chart = hist.length > 1
    ? lineChart([{ values: hist.map((h) => Math.round(h.pln * 100)), color: metal === 'gold' ? '#c9a227' : '#8f9aa6' }], hist.map((h) => formatDatePL(h.date).slice(0, 5)), { height: 140, fromZero: false })
    : `<p class="small muted">${metal === 'silver' ? 'Historia srebra zbiera się od dziś — aplikacja zapisuje cenę raz dziennie.' : 'Brak historii — odśwież ceny.'}</p>`;
  return `<section class="card chart" ${compact ? 'data-lp="card:metals"' : ''}><h2>Ceny złota i srebra <button class="link" data-action="refresh-prices">Odśwież</button></h2>
    <div class="stat-row" style="grid-template-columns:1fr 1fr">${row('gold', 'Złoto')}${row('silver', 'Srebro')}</div>
    <div class="chips" style="margin-top:10px"><button class="chip" data-action="metal-chart" data-m="gold" aria-pressed="${metal === 'gold'}">Złoto</button><button class="chip" data-action="metal-chart" data-m="silver" aria-pressed="${metal === 'silver'}">Srebro</button></div>
    ${chart}
    ${state.priceProblems?.length ? `<p class="small neg">Nie udało się pobrać: ${esc(state.priceProblems.join('; '))}. Pokazuję ostatnie znane ceny.</p>` : ''}
    <p class="small muted">Złoto: NBP (1 g próby 1000). Srebro: gold-api.com przeliczone kursem USD z NBP. Aplikacja tylko pobiera ceny — nic nie wysyła.</p>
  </section>`;
}

const hasMetals = () => state.data.accounts.some((a) => !a.archived && metalOf(a));

async function refreshMetalPrices({ force = false, silent = true } = {}) {
  if (state.pricesBusy) return;
  const age = state.prices?.updatedAt ? Date.now() - new Date(state.prices.updatedAt).getTime() : Infinity;
  if (!force && age < 3 * 3600e3) return;
  if (!navigator.onLine) { if (!silent) toast('Brak internetu — pokazuję ostatnie znane ceny'); return; }
  state.pricesBusy = true;
  try {
    let prices = state.prices || {};
    let problems = [];
    if (hasMetals()) ({ prices, problems } = await refreshPrices(prices, { withHistory: prices?.goldHistoryAt !== todayISO() }));
    const coins = state.data.accounts.filter((a) => !a.archived && isCrypto(a)).flatMap((a) => positionsOf(a).map((p) => p.coin)).filter(Boolean);
    if (coins.length) {
      try { prices = { ...prices, crypto: { ...(prices.crypto || {}), ...(await fetchCryptoPrices(coins, cgKey())) }, updatedAt: new Date().toISOString() }; } catch (e) { problems = [...problems, `krypto: ${e.message}`]; }
    }
    state.prices = prices;
    state.priceProblems = problems;
    await db.setSetting('metalPrices', prices);
    render(); // widok pod okienkiem — otwarte okienko zostaje nietknięte
    if (!silent) toast(problems.length ? 'Część cen nie została pobrana' : 'Zaktualizowano ceny metali');
  } finally {
    state.pricesBusy = false;
  }
}

function openValuationSheet(id) {
  const a = accById()[id];
  if (!a) return;
  const txs = liveTx();
  const today = todayISO();
  let mode = 'amount';
  openSheet(`Wartość: ${a.name}`, `
    <p class="small" id="va-base"></p>
    <div class="seg" id="va-mode"><button type="button" data-m="amount" aria-pressed="true">Nowa kwota</button><button type="button" data-m="percent" aria-pressed="false">Zmiana o %</button></div>
    <label class="field"><span id="va-label">Aktualna wartość (zł)</span><input id="va-input" class="amount-input" inputmode="decimal" autocomplete="off" placeholder="0,00"></label>
    <label class="field"><span>Data wyceny</span><input id="va-date" type="date" value="${today}" max="${today}"></label>
    <div class="note" id="va-preview">Wpisz nową wartość albo zmianę w %.</div>
    <div class="err" id="va-err" role="alert"></div>
    <div class="actions"><button class="btn primary block" id="va-save">Zapisz wycenę</button></div>
    <p class="small muted">Wycena zmienia wartość majątku, ale nie jest przychodem i nie wpływa na bilans miesiąca. Dopłaty i wypłaty dodawaj przyciskami Wpłata / Wypłata — wtedy nie pomylą się z zyskiem.</p>`);
  const base = () => accountValue(a, txs, valOpts($('#va-date').value || today));
  const parse = () => {
    const raw = $('#va-input').value.trim();
    if (!raw) return null;
    if (mode === 'percent') {
      const v = Number(raw.replace(/\s/g, '').replace('%', '').replace(',', '.'));
      return applyChange(base(), 'percent', v);
    }
    return applyChange(base(), 'amount', toMinor(raw));
  };
  const paint = () => {
    const b = base();
    $('#va-base').innerHTML = `Wartość na ${esc(formatDatePL($('#va-date').value || today))}: <b class="num">${esc(formatMoney(b, a.currency))}</b>${a.type === 'property' ? '' : ` · wpłacono <span class="num">${esc(formatMoney(bookBalance(a, txs, $('#va-date').value || today), a.currency))}</span>`}`;
    const r = parse();
    $('#va-preview').innerHTML = r ? `<b class="num">${esc(formatMoney(b, a.currency))}</b> → <b class="num">${esc(formatMoney(r.value, a.currency))}</b><br>
      <span class="${r.diff >= 0 ? 'pos' : 'neg'} num">${esc(formatMoney(r.diff, a.currency, { sign: true }))}${r.pct != null ? ` (${esc(fmtPct(r.pct))})` : ''}</span>`
      : 'Wpisz nową wartość albo zmianę w %.';
  };
  paint();
  $('#va-mode').onclick = (e) => {
    const x = e.target.closest('[data-m]');
    if (!x) return;
    mode = x.dataset.m;
    $('#va-mode').querySelectorAll('[data-m]').forEach((y) => y.setAttribute('aria-pressed', String(y === x)));
    $('#va-label').textContent = mode === 'percent' ? 'Zmiana wartości w % (np. 7 albo -3,5)' : 'Aktualna wartość (zł)';
    $('#va-input').value = '';
    paint();
    $('#va-input').focus();
  };
  $('#va-input').oninput = paint;
  $('#va-date').onchange = paint;
  focusLater('#va-input');
  $('#va-save').onclick = async () => {
    const r = parse();
    const date = $('#va-date').value;
    if (!r || !Number.isInteger(r.value) || r.value < 0) { $('#va-err').textContent = 'Wpisz poprawną kwotę albo procent (wartość nie może być ujemna).'; return; }
    if (!date || date > today) { $('#va-err').textContent = 'Wybierz datę nie późniejszą niż dziś.'; return; }
    const valuations = sortedValuations(a).filter((v) => v.date !== date);
    valuations.push({ date, value: r.value, book: bookBalance(a, txs, date), at: new Date().toISOString() });
    await db.put('accounts', { ...a, valuations });
    closeSheet();
    await reload();
    toast(`Zapisano wycenę: ${formatMoney(r.value, a.currency)}`);
  };
}

/** Wykres i lista wycen w szczegółach konta. */
function valuationHistoryHtml(a) {
  const txs = liveTx();
  const metal = metalOf(a);
  if (metal) {
    const hist = (state.prices?.history?.[metal] || []).slice(-365);
    if (hist.length < 2) return '';
    const vals = hist.map((h) => metalValue(a, h.pln));
    return `<h3 class="copy-h">Wartość Twojego ${metal === 'gold' ? 'złota' : 'srebra'} (wg obecnej ilości)</h3>
      <div class="chart">${lineChart([{ values: vals, color: 'var(--accent)' }], hist.map((h) => formatDatePL(h.date).slice(0, 5)), { height: 140, fromZero: false })}</div>`;
  }
  const list = sortedValuations(a);
  if (!list.length) return '';
  const pts = list.map((v) => ({ label: formatDatePL(v.date).slice(0, 5), value: v.value, paid: bookBalance(a, txs, v.date) }));
  const now = investmentResult(a, txs, valOpts());
  pts.push({ label: 'dziś', value: now.value, paid: now.paidIn });
  return `<h3 class="copy-h">Historia wycen</h3>
    <div class="chart">${lineChart([{ values: pts.map((p) => p.value), color: 'var(--accent)' }, { values: pts.map((p) => p.paid), color: 'var(--muted)', dash: true }], pts.map((p) => p.label), { height: 140 })}
    <div class="legend"><span><i style="background:var(--accent)"></i>Wartość</span><span><i style="background:var(--muted)"></i>Wpłacono</span></div></div>
    <ul class="menu kv">${list.slice().reverse().map((v) => `<li><div><span>${esc(formatDatePL(v.date))}</span><span><b class="num">${esc(formatMoney(v.value, a.currency))}</b>
      <button class="link neg" data-action="del-valuation" data-id="${esc(a.id)}" data-date="${esc(v.date)}" aria-label="Usuń wycenę">✕</button></span></div></li>`).join('')}</ul>`;
}

// ---------- Symulacja ----------
function simSettings() {
  const s = { ...DEFAULT_SIM, ...(state.simSettings || {}) };
  s.il = { ...DEFAULT_SIM.il, ...(state.simSettings?.il || {}) };
  return s;
}

function simStart() {
  const txs = liveTx();
  const w = valuedNetWorth(state.data.accounts, txs, valOpts());
  const start = { cash: 0, safe: 0, market: 0, retire: 0, metal: 0 };
  const loans = [];
  const properties = [];
  const s = simSettings();
  let estimated = false;
  for (const a of state.data.accounts) {
    if (a.archived || a.currency !== 'PLN') continue;
    const v = w.values[a.id] ?? 0;
    const b = bucketOf(a);
    if (b === 'debt') {
      if (v < 0) {
        const rate = a.loanRate != null ? a.loanRate : s.loanRateDefault;
        let installment = a.installment || 0;
        if (!installment) { installment = loanInstallment(-v, rate, 120); estimated = true; }
        loans.push({ name: a.name, balance: -v, rate, installment, rateAssumed: a.loanRate == null });
      }
    } else if (b === 'property') {
      properties.push({ name: a.name, value: v, growth: a.growth ?? PROPERTY_KINDS[a.subtype]?.growth ?? 0 });
    } else start[b] += v;
  }
  const avg = averages(txs, addMonths(monthKey(todayISO()), -1), 3);
  return { start, loans, properties, avg, net: w.net, estimated };
}

function runSim(s, st, delta = 0) {
  const monthly = s.monthly != null ? Math.round(s.monthly * 100) : Math.max(0, st.avg.net);
  const rates = { safe: s.rSafe + delta, market: s.rMarket + delta, retire: s.rRetire + delta, metal: s.rMetal + delta };
  return simulate({
    start: st.start, loans: st.loans, properties: st.properties, monthly, years: s.years, rates, inflation: s.inflation, belka: s.belka,
    overpay: Math.round((s.overpay || 0) * 100), alloc: { safe: s.allocSafe, market: s.allocMarket, retire: s.allocRetire },
    investLoan: s.il.on ? { amount: Math.round(s.il.amount * 100), rate: s.il.rate, months: s.il.months, target: s.il.target } : null,
  });
}

function viewSim() {
  const s = simSettings();
  const st = simStart();
  const num = (id, label, v, step = '0.1', extra = '') => `<label class="field"><span>${label}</span><input data-sim="${id}" type="number" inputmode="decimal" step="${step}" value="${v ?? ''}" ${extra}></label>`;
  const z = (g) => esc(formatMoney(g));
  return `<section class="card"><h2>📌 Punkt startowy — dane rzeczywiste</h2>
      <ul class="menu kv">
        <li><div><span>Majątek netto dziś</span><span><b class="num">${z(st.net)}</b></span></div></li>
        <li><div><span>Konta bieżące</span><span class="num">${z(st.start.cash)}</span></div></li>
        <li><div><span>Lokaty, obligacje, oszczędności</span><span class="num">${z(st.start.safe)}</span></div></li>
        <li><div><span>ETF, fundusze, akcje, krypto</span><span class="num">${z(st.start.market)}</span></div></li>
        <li><div><span>IKE, IKZE, PPK</span><span class="num">${z(st.start.retire)}</span></div></li>
        <li><div><span>Złoto i srebro</span><span class="num">${z(st.start.metal)}</span></div></li>
        ${st.properties.map((p) => `<li><div><span>${esc(p.name)} <small class="muted">(${p.growth >= 0 ? '+' : ''}${String(p.growth).replace('.', ',')}%/rok)</small></span><span class="num">${z(p.value)}</span></div></li>`).join('')}
        ${st.loans.map((l) => `<li><div><span>Kredyt: ${esc(l.name)}${l.rateAssumed ? ' <small class="muted">(oprocentowanie założone)</small>' : ''}</span><span class="num neg">−${z(l.balance)}</span></div></li>`).join('')}
        <li><div><span>Średnia nadwyżka (${st.avg.months} mies.)</span><span class="num">${st.avg.months ? z(st.avg.net) : 'brak danych'}</span></div></li>
      </ul>
      ${state.data.accounts.filter((a) => !a.archived && looksLikeProperty(a)).map((a) => `<p class="note small">🏠 „${esc(a.name)}” jest liczone jak ${accountGroup(a) === 'savings' ? 'inwestycja' : 'pieniądze na koncie'}, a nie nieruchomość. <button class="link" data-action="to-property" data-id="${esc(a.id)}">Przenieś do Nieruchomości</button></p>`).join('')}
      ${st.estimated ? '<p class="small muted">Dla kredytu bez wpisanej raty przyjęto ratę na 10 lat. Wpisz ratę i oprocentowanie w Majątek → kredyt → Edytuj.</p>' : ''}
    </section>
    <section class="card" id="sim-form"><h2>⚙️ Założenia</h2>
      <label class="field"><span>Horyzont: <b id="sim-years-out">${s.years} lat</b></span><input data-sim="years" type="range" min="1" max="30" step="1" value="${s.years}"></label>
      ${num('monthly', `Odkładam miesięcznie, zł (puste = średnia: ${st.avg.months ? z(Math.max(0, st.avg.net)) : '0 zł'})`, s.monthly, '50', 'placeholder="średnia z danych"')}
      <p class="small muted" style="margin:4px 0 0">Z tej kwoty opłacane są raty kredytów, reszta trafia do oszczędności i inwestycji.</p>
      <div class="grid2">${num('rSafe', 'Lokaty/obligacje %', s.rSafe)}${num('rMarket', 'ETF/akcje %', s.rMarket)}</div>
      <div class="grid2">${num('rRetire', 'IKE/IKZE/PPK %', s.rRetire)}${num('rMetal', 'Złoto/srebro %', s.rMetal)}</div>
      <div class="grid2">${num('inflation', 'Inflacja % rocznie', s.inflation)}${num('overpay', 'Nadpłata kredytów zł/mies.', s.overpay, '50')}</div>
      <label class="check"><input type="checkbox" data-sim="belka" ${s.belka ? 'checked' : ''}> Podatek Belki 19% (bez IKE/IKZE/PPK i metali)</label>
      <div class="field"><span>Gdzie trafia nadwyżka (%)</span><div class="grid3">
        ${num('allocSafe', 'Lokaty', s.allocSafe, '5')}${num('allocMarket', 'ETF', s.allocMarket, '5')}${num('allocRetire', 'IKE', s.allocRetire, '5')}</div></div>
      <details class="more" ${s.il.on ? 'open' : ''}><summary>Kredyt inwestycyjny (symulacja)</summary>
        <label class="check"><input type="checkbox" data-sim="il.on" ${s.il.on ? 'checked' : ''}> Uwzględnij kredyt inwestycyjny</label>
        <div class="grid2">${num('il.amount', 'Kwota kredytu zł', s.il.amount, '1000')}${num('il.rate', 'Oprocentowanie %', s.il.rate)}</div>
        <div class="grid2">${num('il.months', 'Okres (mies.)', s.il.months, '1')}${num('il.ret', 'Zakładany zysk %', s.il.ret)}</div>
        <label class="field"><span>Gdzie inwestuję</span><select data-sim="il.target">
          <option value="market" ${s.il.target === 'market' ? 'selected' : ''}>ETF / akcje / fundusze</option>
          <option value="retire" ${s.il.target === 'retire' ? 'selected' : ''}>IKE / IKZE</option>
          <option value="safe" ${s.il.target === 'safe' ? 'selected' : ''}>Lokaty / obligacje</option>
          <option value="metal" ${s.il.target === 'metal' ? 'selected' : ''}>Złoto / srebro</option></select></label>
      </details>
      <button class="btn block" data-action="sim-reset" style="margin-top:10px">Przywróć domyślne założenia</button>
    </section>
    <div id="sim-results">${simResultsHtml(s, st)}</div>`;
}

function simResultsHtml(s = simSettings(), st = simStart()) {
  const base = runSim(s, st);
  const pess = runSim(s, st, -3);
  const opt = runSim(s, st, 2);
  const z = (g) => esc(formatMoney(g).replace(/,\d\d/, ''));
  const nowYear = Number(todayISO().slice(0, 4));
  const monthsLabel = (m) => { const y = Math.floor(m / 12); const r = m % 12; return [y ? `${y} ${y === 1 ? 'rok' : y < 5 ? 'lata' : 'lat'}` : '', r ? `${r} mies.` : ''].filter(Boolean).join(' '); };
  const whenYm = (m) => monthNamePL(addMonths(monthKey(todayISO()), m)).toLowerCase();
  const sum = s.allocSafe + s.allocMarket + s.allocRetire;
  const pick = [1, 3, 5, 10, 15, 20, 25, 30].filter((y) => y <= s.years);
  if (!pick.includes(s.years)) pick.push(s.years);
  let il = '';
  if (s.il.on && s.il.amount > 0 && s.il.months > 0) {
    const a = investLoanAnalysis({ amount: Math.round(s.il.amount * 100), rate: s.il.rate, months: s.il.months, ret: s.il.ret, belka: s.belka && s.il.target !== 'retire' && s.il.target !== 'metal' });
    const row = (label, x) => `<li><div><span>${label} (${String(x.ret).replace('.', ',')}%)</span><span class="num ${x.benefit >= 0 ? 'pos' : 'neg'}">${esc(formatMoney(x.benefit, 'PLN', { sign: true }))}</span></div></li>`;
    il = `<section class="card"><h2>🏦 Kredyt inwestycyjny — czy się opłaca?</h2>
      <ul class="menu kv">
        <li><div><span>Rata</span><span class="num"><b>${esc(formatMoney(a.installment))}</b></span></div></li>
        <li><div><span>Odsetki łącznie</span><span class="num neg">${esc(formatMoney(a.interest))}</span></div></li>
        <li><div><span>Inwestycja po ${s.il.months} mies. (po podatku)</span><span class="num">${esc(formatMoney(a.base.netA))}</span></div></li>
        <li><div><span>Bez kredytu: odkładanie raty co miesiąc</span><span class="num">${esc(formatMoney(a.base.netB))}</span></div></li>
        <li><div><span><b>Różnica na korzyść kredytu</b></span><span class="num ${a.base.benefit >= 0 ? 'pos' : 'neg'}"><b>${esc(formatMoney(a.base.benefit, 'PLN', { sign: true }))}</b></span></div></li>
        <li><div><span>Próg opłacalności</span><span><b>${a.breakEven != null ? `${String(a.breakEven).replace('.', ',')}% rocznie` : '—'}</b></span></div></li>
      </ul>
      <h3 class="copy-h">Scenariusze zysku</h3>
      <ul class="menu kv">${row('Pesymistyczny', a.pessimistic)}${row('Bazowy', a.base)}${row('Optymistyczny', a.optimistic)}</ul>
      <p class="note warn small">Kredyt na inwestycję zwiększa ryzyko: ratę płacisz zawsze, a wartość inwestycji może spaść. Opłaca się tylko wtedy, gdy zysk po podatku przekroczy próg opłacalności. To szacunek, nie rekomendacja.</p>
    </section>`;
  }
  return `<section class="card"><h2>📈 Szacunek za ${s.years} lat</h2>
      <div class="big-result"><b class="num">${z(base.final.net)}</b><span>majątek netto w ${nowYear + s.years} r.</span></div>
      <p class="small">W dzisiejszych pieniądzach (po inflacji ${String(s.inflation).replace('.', ',')}%): <b class="num">${z(base.final.netReal)}</b></p>
      ${base.properties.length ? `<p class="small">W tym nieruchomości i inne aktywa: <b class="num">${z(base.final.property)}</b> · <b>majątek płynny</b> (bez nich): <b class="num">${z(base.final.liquid)}</b></p>` : ''}
      <div class="chart">${lineChart([
        { values: base.series.map((p) => p.net), color: 'var(--accent)' },
        { values: base.series.map((p) => p.netReal), color: 'var(--muted)', dash: true },
        { values: base.series.map((p) => -p.debt), color: 'var(--expense)' },
        ...(base.properties.length ? [{ values: base.series.map((p) => p.liquid), color: 'var(--transfer)' }] : []),
      ], base.series.map((p) => String(nowYear + p.month / 12 | 0)))}
        <div class="legend"><span><i style="background:var(--accent)"></i>Netto</span><span><i style="background:var(--muted)"></i>Po inflacji</span><span><i style="background:var(--expense)"></i>Długi</span>${base.properties.length ? '<span><i style="background:var(--transfer)"></i>Płynny</span>' : ''}</div></div>
      ${sum !== 100 ? `<p class="small neg">Podział nadwyżki sumuje się do ${sum}% — liczę proporcjonalnie.</p>` : ''}
    </section>
    <section class="card"><h2>Rok po roku</h2><ul class="menu kv">
      ${pick.map((y) => { const p = base.series.find((q) => q.month === y * 12) || base.final; return `<li><div><span>${nowYear + y} (za ${y} ${y === 1 ? 'rok' : y < 5 ? 'lata' : 'lat'})</span><span><b class="num">${z(p.net)}</b> <small class="muted num">/ ${z(p.netReal)}</small></span></div></li>`; }).join('')}
    </ul><p class="small muted">Druga kwota: wartość po inflacji.</p></section>
    ${base.properties.length ? `<section class="card"><h2>Nieruchomości i inne aktywa za ${s.years} lat</h2><ul class="menu kv">
      ${base.properties.map((p, i) => `<li><div><span>${esc(p.name)} <small class="muted">(${st.properties[i].growth >= 0 ? '+' : ''}${String(st.properties[i].growth).replace('.', ',')}%/rok)</small></span><span><span class="num muted">${z(p.start)}</span> → <b class="num">${z(p.end)}</b></span></div></li>`).join('')}
    </ul><p class="small muted">Zmianę % ustawisz w Majątek → aktywo → Edytuj.</p></section>` : ''}
    <section class="card"><h2>Kamienie milowe</h2><ul class="menu kv">
      ${base.payoffs.map((l) => `<li><div><span>${esc(l.name)}</span><span>${l.month != null ? `spłacony: <b>${esc(whenYm(l.month))}</b> <small class="muted">(za ${esc(monthsLabel(l.month))})</small>` : `<span class="neg">do spłaty po ${s.years} latach: ${z(l.left)}</span>`}</span></div></li>`).join('')}
      ${base.milestones.map((m) => `<li><div><span>Majątek netto ${z(m.amount)}</span><span><b>${esc(whenYm(m.month))}</b></span></div></li>`).join('')}
      ${!base.payoffs.length && !base.milestones.length ? '<li><div><span class="muted">Brak kamieni milowych w tym horyzoncie.</span></div></li>' : ''}
    </ul></section>
    <section class="card"><h2>Scenariusze</h2><ul class="menu kv">
      <li><div><span>Pesymistyczny (zwroty −3 pkt %)</span><span class="num">${z(pess.final.net)}</span></div></li>
      <li><div><span><b>Bazowy</b></span><span class="num"><b>${z(base.final.net)}</b></span></div></li>
      <li><div><span>Optymistyczny (zwroty +2 pkt %)</span><span class="num">${z(opt.final.net)}</span></div></li>
    </ul></section>
    ${il}
    <button class="btn primary block" data-action="sim-ai">✨ Zapytaj AI o tę symulację</button>
    <p class="note small">📊 To <b>szacunek</b> na Twoich założeniach, nie prognoza ani gwarancja. Uproszczenia: stałe stopy zwrotu i inflacja, podatek liczony od bieżącego zysku, raty kredytów stałe, kredyty bez wpisanego oprocentowania liczone na ${String(s.loanRateDefault).replace('.', ',')}%.</p>`;
}

let simSaveTimer = null;
function bindSimForm() {
  const form = $('#sim-form');
  if (!form) return;
  const onChange = (e) => {
    const el = e.target.closest('[data-sim]');
    if (!el) return;
    const key = el.dataset.sim;
    const cur = simSettings();
    let v;
    if (el.type === 'checkbox') v = el.checked;
    else if (el.tagName === 'SELECT') v = el.value;
    else v = el.value.trim() === '' ? null : Number(el.value.replace(',', '.'));
    if (v !== null && typeof v === 'number' && !Number.isFinite(v)) return;
    if (key.startsWith('il.')) cur.il = { ...cur.il, [key.slice(3)]: v ?? DEFAULT_SIM.il[key.slice(3)] };
    else cur[key] = key === 'monthly' ? v : (v ?? DEFAULT_SIM[key]);
    if (key === 'years') $('#sim-years-out').textContent = `${v} lat`;
    state.simSettings = cur;
    $('#sim-results').innerHTML = simResultsHtml(cur);
    clearTimeout(simSaveTimer);
    simSaveTimer = setTimeout(() => db.setSetting('simSettings', state.simSettings), 400);
  };
  form.oninput = onChange;
  form.onchange = onChange;
}

// ---------- Pozycje: złoto/srebro (monety, sztabki, biżuteria) i krypto (BTC, ETH…) ----------
const POS_PRESETS = {
  metal: [['Monety', 0.9167, 3], ['Sztabki', 0.9999, 0], ['Biżuteria', 0.585, 15], ['Inne', 0.9999, 0]],
};
const fmtQty = (x) => (Math.round((Number(x) || 0) * 1e8) / 1e8).toLocaleString('pl-PL', { maximumFractionDigits: 8 });
const cgKey = () => getPref('sf-cg-key', '');
const hasCrypto = () => state.data.accounts.some((a) => !a.archived && isCrypto(a) && positionsOf(a).some((p) => p.coin));

function positionsHtml(a) {
  const s = positionsSummary(a, state.prices);
  if (!s.list.length) {
    return `<div class="pos-empty small muted">Brak pozycji. <button class="link" data-action="pos-add" data-id="${esc(a.id)}">+ Dodaj ${metalOf(a) ? 'pozycję (np. monety, sztabki)' : 'kryptowalutę'}</button></div>`;
  }
  const metal = metalOf(a);
  return `<details class="pos" ${state.openPos?.[a.id] ? 'open' : ''} data-pos="${esc(a.id)}"><summary>
      <span>${s.list.length} ${s.list.length === 1 ? 'pozycja' : s.list.length < 5 ? 'pozycje' : 'pozycji'}${metal ? ` · ${fmtGrams(s.grams)}` : ''}</span><span class="chev">▸</span></summary>
    <ul class="pos-list">${s.list.map((p) => {
      const qty = metal ? `${fmtGrams(p.grams)} · próba ${String(Math.round((p.purity || 1) * 10000) / 10).replace('.', ',')}${p.spread ? ` · skup −${String(p.spread).replace('.', ',')}%` : ''}`
        : `${fmtQty(p.amount)} ${esc(p.symbol || '')}${p.coin ? '' : ' · <span class="muted">wycena ręczna</span>'}`;
      return `<li><button class="pos-row" data-action="pos-edit" data-id="${esc(a.id)}" data-pid="${esc(p.id)}">
        <span class="mid"><span class="t1">${esc(p.name)}</span><span class="t2">${qty}</span></span>
        <span class="r"><b class="num">${esc(formatMoney(p.value, a.currency))}</b>
          <small class="num ${p.gain >= 0 ? 'pos' : 'neg'}">${p.paid ? esc(formatMoney(p.gain, a.currency, { sign: true })) : ''} · ${Math.round(p.share * 100)}%</small></span>
      </button></li>`;
    }).join('')}</ul>
    <button class="btn block small-btn" data-action="pos-add" data-id="${esc(a.id)}">+ Dodaj ${metal ? 'pozycję' : 'kryptowalutę'}</button>
  </details>`;
}

/** Dla kont z pozycjami „wpłacono” = suma kwot zapłaconych za pozycje (jeśli wpisane). */
function posResult(a, r) {
  if (!hasPositions(a) || !positionsOf(a).length) return r;
  const s = positionsSummary(a, state.prices);
  if (!s.paid) return r;
  const gain = r.value - s.paid;
  return { ...r, paidIn: s.paid, gain, gainPct: s.paid > 0 ? gain / s.paid : null };
}

function cryptoLine(a) {
  const ids = positionsOf(a).filter((p) => p.coin);
  if (!ids.length) return '';
  const at = Object.values(state.prices?.crypto || {})[0]?.at;
  return `Ceny: CoinGecko${at ? `, ${esc(formatDatePL(at.slice(0, 10)))} ${at.slice(11, 16)}` : ' — <span class="neg">brak, odśwież</span>'}`;
}

function openPositionSheet(accId, posId = null) {
  const a = accById()[accId];
  if (!a) return;
  const metal = metalOf(a);
  const list = positionsOf(a);
  const p = posId ? list.find((x) => x.id === posId) : null;
  let coin = p?.coin ? { id: p.coin, symbol: p.symbol, name: p.name } : null;
  const mi = (v) => (v ? esc(minorToInput(v)) : '');
  const body = metal ? `
    ${p ? '' : `<div class="chips wrap" id="ps-presets">${POS_PRESETS.metal.map(([n]) => `<button type="button" class="chip" data-preset="${esc(n)}">${esc(n)}</button>`).join('')}</div>`}
    <label class="field"><span>Nazwa pozycji</span><input id="ps-name" maxlength="40" value="${esc(p?.name || '')}" placeholder="np. Monety, Sztabki, Biżuteria"></label>
    <div class="grid2"><label class="field"><span>Ilość</span><input id="ps-qty" inputmode="decimal" value="${p ? esc(String(p.grams).replace('.', ',')) : ''}" placeholder="np. 5"></label>
      <label class="field"><span>Jednostka</span><select id="ps-unit"><option value="g">gramy</option><option value="oz">uncje (31,1 g)</option></select></label></div>
    <div class="grid2"><label class="field"><span>Próba</span><select id="ps-purity">${PURITIES.map(([v, l]) => `<option value="${v}" ${(p?.purity || 0.9999) === v ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></label>
      <label class="field"><span>Cena skupu − %</span><input id="ps-spread" inputmode="decimal" value="${p?.spread ? esc(String(p.spread).replace('.', ',')) : ''}" placeholder="np. 3"></label></div>`
    : `
    <label class="field"><span>Kryptowaluta</span><div class="qa"><input id="ps-coinq" placeholder="np. bitcoin, ETH, solana" autocomplete="off" value="${esc(coin ? `${coin.name} (${coin.symbol})` : '')}"><button type="button" class="btn" id="ps-coingo">Szukaj</button></div></label>
    <div id="ps-coins" class="chips wrap"></div>
    <label class="field"><span>Nazwa</span><input id="ps-name" maxlength="40" value="${esc(p?.name || '')}" placeholder="np. Bitcoin"></label>
    <label class="field"><span>Ilość</span><input id="ps-qty" inputmode="decimal" value="${p ? esc(String(p.amount).replace('.', ',')) : ''}" placeholder="np. 0,05"></label>
    <label class="field" id="ps-manual-wrap"><span>Wartość teraz (gdy nie ma ceny z CoinGecko)</span><input id="ps-manual" inputmode="decimal" value="${mi(p?.manualValue)}" placeholder="opcjonalnie"></label>`;
  openSheet(p ? `${p.name}` : `Nowa pozycja: ${a.name}`, `${body}
    <label class="field"><span>Ile za to zapłaciłeś (łącznie)</span><input id="ps-paid" inputmode="decimal" value="${mi(p?.paid)}" placeholder="0,00"></label>
    <p class="small muted">To tylko zapis w majątku. Jeśli pieniądze zeszły z konta, użyj na karcie „+ Kupno” — wtedy powstanie też przelew.</p>
    <div class="err" id="ps-err" role="alert"></div>
    <div class="actions ${p ? 'two' : ''}">${p ? '<button class="btn danger" id="ps-del">Usuń</button>' : ''}<button class="btn primary block" id="ps-save">Zapisz</button></div>`);
  const sheet = $('#sheet');
  sheet.querySelector('#ps-presets')?.addEventListener('click', (e) => {
    const b = e.target.closest('[data-preset]');
    if (!b) return;
    const [n, pur, spr] = POS_PRESETS.metal.find((x) => x[0] === b.dataset.preset);
    $('#ps-name').value = n;
    $('#ps-purity').value = String(pur);
    $('#ps-spread').value = spr ? String(spr) : '';
    sheet.querySelectorAll('#ps-presets [data-preset]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    $('#ps-qty').focus();
  });
  if (!metal) {
    const paintManual = () => { $('#ps-manual-wrap').hidden = !!coin; };
    paintManual();
    const search = async () => {
      const box = $('#ps-coins');
      box.innerHTML = '<span class="small muted">Szukam…</span>';
      try {
        const res = await searchCoins($('#ps-coinq').value, cgKey());
        box.innerHTML = res.length ? res.map((c, i) => `<button type="button" class="chip" data-coin="${i}">${esc(c.symbol)} · ${esc(c.name)}</button>`).join('') + '<button type="button" class="chip" data-coin="none">Bez ceny (wycena ręczna)</button>'
          : '<span class="small muted">Nic nie znaleziono.</span>';
        box.onclick = (e) => {
          const b = e.target.closest('[data-coin]');
          if (!b) return;
          coin = b.dataset.coin === 'none' ? null : res[Number(b.dataset.coin)];
          if (coin) { $('#ps-coinq').value = `${coin.name} (${coin.symbol})`; if (!$('#ps-name').value) $('#ps-name').value = coin.name; }
          box.innerHTML = '';
          paintManual();
        };
      } catch (err) { box.innerHTML = `<span class="small neg">${esc(err.message)}</span>`; }
    };
    $('#ps-coingo').onclick = search;
    $('#ps-coinq').onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); search(); } };
  }
  focusLater(metal ? '#ps-name' : '#ps-coinq');
  $('#ps-save').onclick = async () => {
    const err = (m) => { $('#ps-err').textContent = m; };
    const num = (sel) => Number(($(sel).value || '0').replace(/\s/g, '').replace(',', '.'));
    const name = $('#ps-name').value.trim();
    let qty = num('#ps-qty');
    const paid = $('#ps-paid').value.trim() ? toMinor($('#ps-paid').value) : 0;
    if (!name) return err('Wpisz nazwę.');
    if (!Number.isFinite(qty) || qty < 0) return err('Nieprawidłowa ilość.');
    if (!Number.isInteger(paid) || paid < 0) return err('Nieprawidłowa kwota.');
    const item = { ...(p || { id: db.newId('pos') }), name, paid };
    if (metal) {
      if ($('#ps-unit').value === 'oz') qty *= TROY_OUNCE_G;
      const spread = num('#ps-spread');
      if (!Number.isFinite(spread) || spread < 0 || spread > 50) return err('Cena skupu: od 0 do 50%.');
      Object.assign(item, { grams: Math.round(qty * 10000) / 10000, purity: Number($('#ps-purity').value), spread });
    } else {
      const manual = $('#ps-manual').value.trim() ? toMinor($('#ps-manual').value) : null;
      if (manual != null && (!Number.isInteger(manual) || manual < 0)) return err('Nieprawidłowa wartość.');
      Object.assign(item, { amount: qty, coin: coin?.id || null, symbol: coin?.symbol || item.symbol || '', manualValue: coin ? null : manual });
    }
    const positions = posId ? list.map((x) => (x.id === posId ? item : x)) : [...list, item];
    await savePositions(a, positions);
    closeSheet();
    state.openPos = { ...(state.openPos || {}), [a.id]: true };
    await reload();
    toast('Zapisano pozycję');
    if (!metal && coin) refreshMetalPrices({ force: true });
  };
  if (p) {
    $('#ps-del').onclick = async () => {
      await savePositions(a, list.filter((x) => x.id !== posId));
      closeSheet();
      await reload();
      toast(`Usunięto: ${p.name}`, { label: 'Cofnij', run: async () => { await savePositions(accById()[a.id], [...positionsOf(accById()[a.id]), p]); await reload(); } });
    };
  }
}

/** Zapis pozycji; dla metali utrzymuje też sumę gramów na koncie (zgodność wstecz). */
async function savePositions(a, positions) {
  const upd = { ...a, positions };
  if (metalOf(a)) upd.grams = Math.round(positions.reduce((s, p) => s + (Number(p.grams) || 0), 0) * 10000) / 10000;
  await db.put('accounts', upd);
}

// ---------- Szybka aktualizacja (wiele operacji jednym zdaniem) ----------
const BATCH_EXAMPLE = 'wpłynęła wypłata 9k, wpłata do ppk 300, przelewam na oszczędnościowe 300, na ikze 300, spłata kredytów według planu';

function openBatchSheet(prefill = '') {
  openSheet('⚡ Szybka aktualizacja', `
    <p class="small muted" style="margin-top:0">Napisz albo powiedz, co się wydarzyło — kilka rzeczy naraz, oddzielone przecinkami. Np.: „${esc(BATCH_EXAMPLE)}”.</p>
    <div class="quick"><textarea id="bt-text" rows="3" placeholder="Co się wydarzyło?">${esc(prefill)}</textarea>${speechSupported() ? '<button type="button" class="mic" id="bt-mic" aria-label="Dyktuj">🎤</button>' : ''}</div>
    <div class="actions two" style="grid-template-columns:1fr 1fr"><button class="btn" id="bt-example">Przykład</button><button class="btn primary" id="bt-go">Rozpoznaj</button></div>
    <div id="bt-ops"></div>`);
  focusLater('#bt-text');
  $('#bt-example').onclick = () => { $('#bt-text').value = BATCH_EXAMPLE; showOps(); };
  if ($('#bt-mic')) $('#bt-mic').onclick = async () => { await dictateInto($('#bt-text')); if ($('#bt-text').value.trim()) showOps(); };
  $('#bt-go').onclick = showOps;
  if (prefill) showOps();

  let ops = [];
  function showOps() {
    ops = parseBatch($('#bt-text').value, {
      accounts: state.data.accounts, categories: state.data.categories, bills: state.data.bills, transactions: state.data.transactions,
      month: monthKey(todayISO()), today: todayISO(), defaultAccountId: defaultAccountId(),
    });
    const accs = state.data.accounts.filter((a) => !a.archived && accountGroup(a) === 'current');
    const icon = { income: '💰', expense: '🛒', transfer: '⇄', loan: '🏦', plan: '🗓️', unknown: '❓' };
    $('#bt-ops').innerHTML = ops.length ? `<h3 class="copy-h">Do zapisania (${ops.filter((o) => o.kind !== 'unknown').length})</h3>
      <div class="list">${ops.map((o, i) => `<div class="item bt-op ${o.kind === 'unknown' ? 'muted' : ''}">
        ${o.kind === 'unknown' ? '<span class="ico">❓</span>' : `<input type="checkbox" data-bt="${i}" checked aria-label="Zapisz">`}
        <span class="mid"><span class="t1">${icon[o.kind]} ${esc(o.label)}</span>
          <span class="t2 ${o.warn ? 'neg' : ''}">${o.warn ? esc(o.warn) : o.kind === 'plan' ? 'odhaczy pozycję w planie' + (autoTxOn() ? ' i doda transakcję' : '') : o.kind === 'transfer' || o.kind === 'loan' ? 'przelew z konta: ' + esc(accById()[o.accountId]?.name || '—') : esc(catLabel(o.categoryId))}</span></span>
        ${o.kind === 'unknown' ? '' : `<input class="copy-amt" data-bta="${i}" inputmode="decimal" value="${o.amount ? esc(minorToInput(o.amount)) : ''}" placeholder="kwota">`}
      </div>`).join('')}</div>
      ${accs.length > 1 ? `<label class="field"><span>Konto, z którego / na które</span><select id="bt-acc">${accs.map((a) => `<option value="${esc(a.id)}" ${a.id === defaultAccountId() ? 'selected' : ''}>${esc(a.name)}</option>`).join('')}</select></label>` : ''}
      <div class="err" id="bt-err" role="alert"></div>
      <div class="actions"><button class="btn primary block" id="bt-save">Zapisz zaznaczone</button></div>`
      : '<p class="small muted">Nic nie rozpoznano.</p>';
    const label = () => { const n = $('#sheet').querySelectorAll('[data-bt]:checked').length; const b = $('#bt-save'); if (b) { b.textContent = `Zapisz zaznaczone (${n})`; b.disabled = !n; } };
    $('#sheet').querySelectorAll('[data-bt]').forEach((c) => { c.onchange = label; });
    label();
    if ($('#bt-save')) $('#bt-save').onclick = saveOps;
  }

  async function saveOps() {
    const accId = $('#bt-acc')?.value || defaultAccountId();
    const now = new Date().toISOString();
    const txs = [];
    const plans = [];
    for (const c of $('#sheet').querySelectorAll('[data-bt]:checked')) {
      const i = Number(c.dataset.bt);
      const o = ops[i];
      const amount = toMinor($(`[data-bta="${i}"]`).value);
      if (!Number.isInteger(amount) || amount <= 0) { $('#bt-err').textContent = `${o.label}: wpisz kwotę`; return; }
      if (o.kind === 'plan') { plans.push({ id: o.planId, amount }); continue; }
      const t = {
        id: db.newId('tx'), createdAt: now, updatedAt: now, currency: 'PLN', date: o.date || todayISO(), amount,
        type: o.kind === 'loan' ? 'transfer' : o.kind, categoryId: o.categoryId || null,
        accountId: o.kind === 'income' ? accId : accId, toAccountId: o.toAccountId || null,
        description: o.description || '', tags: ['szybka aktualizacja'], recurring: false, refund: false,
      };
      if (t.type === 'transfer') t.categoryId = null;
      const errors = validateTransaction(t, state.data);
      if (errors.length) { $('#bt-err').textContent = `${o.label}: ${errors.join(', ')}`; return; }
      txs.push(t);
    }
    if (txs.length) await db.put('transactions', ...txs);
    for (const pl of plans) {
      const b = state.data.bills.find((x) => x.id === pl.id);
      if (!b) continue;
      const item = { ...b, amount: pl.amount, paid: true, paidAt: now, accountId: b.accountId || accId };
      item.txId = await syncPlanTx(item);
      await db.put('bills', item);
      await loadData();
    }
    closeSheet();
    await reload();
    toast(`Zapisano ${txs.length + plans.length} operacji`);
  }
}

// ---------- Przenoszenie do nieruchomości ----------
const PROPERTY_NAME_RE = /(mieszkan|\bdom\b|domek|działk|dzialk|garaż|garaz|kawalerk|nieruchom|samoch[oó]d|\bauto\b|lokal|apartament)/i;
function guessPropertyKind(name) {
  const n = String(name || '').toLowerCase();
  if (/mieszkan|kawalerk|apartament|lokal/.test(n)) return 'flat';
  if (/\bdom\b|domek/.test(n)) return 'house';
  if (/działk|dzialk/.test(n)) return 'land';
  if (/garaż|garaz/.test(n)) return 'garage';
  if (/samoch|\bauto\b/.test(n)) return 'car';
  return 'property_other';
}
const looksLikeProperty = (a) => a.type !== 'property' && a.type !== 'loan' && PROPERTY_NAME_RE.test(a.name || '');

async function moveToProperty(id) {
  const a = accById()[id];
  if (!a) return;
  const kind = guessPropertyKind(a.name);
  const ok = await confirmSheet(`Przenieść „${a.name}” do nieruchomości?`,
    `Konto trafi do sekcji „Nieruchomości i inne aktywa” jako <b>${esc(PROPERTY_KINDS[kind].label)}</b>. Wartość i historia zostają. W symulacji będzie rosło o ${PROPERTY_KINDS[kind].growth >= 0 ? '+' : ''}${PROPERTY_KINDS[kind].growth}% rocznie (zmienisz w Edytuj), a nie jak lokata czy inwestycja.`,
    { confirmLabel: 'Przenieś' });
  if (!ok) return;
  const { depositKind, rate, termMonths, startDate, promoRate, promoLimit, promoMonths, positions, grams, purity, spread, ...rest } = a;
  await db.put('accounts', { ...rest, type: 'property', subtype: kind, growth: PROPERTY_KINDS[kind].growth });
  await reload();
  toast('Przeniesiono do Nieruchomości');
}

// ---------- Lokaty i konta oszczędnościowe ----------
const isDepositLike = (a) => a && (a.type === 'savings' || a.subtype === 'deposit');
const pct2 = (x) => String(x).replace('.', ',');

function depositLine(a, bookValue) {
  if (!a.rate) return '';
  if (isTermDeposit(a)) {
    const r = termDeposit({ principal: bookValue, rate: a.rate, months: a.termMonths, startDate: a.startDate, today: todayISO() });
    return `<div class="dep">
      <div class="small"><b>${pct2(a.rate)}%</b> w skali roku · lokata ${a.termMonths} mies. · koniec ${esc(formatDatePL(r.end))}${r.ended ? ' · <b class="neg">zakończona</b>' : ` · zostało ${r.daysLeft} dni`}</div>
      <div class="small muted">Odsetki <span class="num">${esc(formatMoney(r.gross))}</span> − podatek Belki <span class="num">${esc(formatMoney(r.tax))}</span> = <span class="num pos">+${esc(formatMoney(r.net))}</span></div>
      <div class="dep-pay">Wyciągniesz: <b class="num">${esc(formatMoney(r.payout))}</b></div>
      <div class="track"><div class="fill" style="width:${r.total ? ((r.passed / r.total) * 100).toFixed(1) : 0}%"></div></div>
    </div>`;
  }
  const promoActive = a.promoRate != null && a.promoMonths && a.startDate && todayISO() < addMonthsDate(a.startDate, a.promoMonths);
  const e = savingsEstimate({ balance: Math.max(0, bookValue), rate: a.rate, promoRate: a.promoRate, promoLimit: a.promoLimit, promoActive });
  return `<div class="dep small"><b>${pct2(promoActive ? a.promoRate : a.rate)}%</b> ${promoActive ? `promocja do ${esc(formatDatePL(addMonthsDate(a.startDate, a.promoMonths)))}${a.promoLimit ? ` (do ${esc(formatMoney(a.promoLimit))})` : ''}, potem ${pct2(a.rate)}%` : 'w skali roku'}
    · zarobisz ok. <b class="num pos">${esc(formatMoney(e.month))}</b>/mies., <span class="num">${esc(formatMoney(e.year))}</span>/rok <span class="muted">(po podatku)</span></div>`;
}

function depositFieldsHtml(a, subtype) {
  const kind = a?.depositKind || (subtype === 'deposit' ? 'term' : 'savings');
  const show = ['deposit'].includes(subtype) || a?.type === 'savings';
  return `<div id="a-dep" ${show ? '' : 'hidden'}>
    <div class="field"><span>Oprocentowanie</span><div class="seg" id="a-depkind">
      <button type="button" data-dk="term" aria-pressed="${kind === 'term'}">Lokata na okres</button>
      <button type="button" data-dk="savings" aria-pressed="${kind === 'savings'}">Konto oszczędnościowe</button></div></div>
    <div class="grid2"><label class="field"><span>% w skali roku</span><input id="a-rate2" inputmode="decimal" placeholder="np. 4,5" value="${a?.rate ? esc(pct2(a.rate)) : ''}"></label>
      <label class="field" id="a-term-wrap"><span>Okres (miesiące)</span><select id="a-term">${[1, 3, 6, 12, 24].map((m) => `<option value="${m}" ${(a?.termMonths || 6) === m ? 'selected' : ''}>${m} mies.</option>`).join('')}</select></label></div>
    <label class="field"><span id="a-start-label">Data założenia</span><input id="a-start" type="date" value="${esc(a?.startDate || todayISO())}"></label>
    <details class="more" id="a-promo" ${a?.promoRate != null ? 'open' : ''}><summary>Oprocentowanie promocyjne</summary>
      <div class="grid3"><label class="field"><span>Promocja %</span><input id="a-prate" inputmode="decimal" value="${a?.promoRate != null ? esc(pct2(a.promoRate)) : ''}"></label>
        <label class="field"><span>Do kwoty</span><input id="a-plimit" inputmode="decimal" value="${a?.promoLimit ? esc(minorToInput(a.promoLimit)) : ''}"></label>
        <label class="field"><span>Mies.</span><input id="a-pmonths" type="number" inputmode="numeric" value="${a?.promoMonths || ''}"></label></div>
    </details>
    <p class="small muted" id="a-dep-preview"></p>
  </div>`;
}

function mountDepositFields(getSubtype) {
  const box = $('#a-dep');
  if (!box) return { read: () => ({}), paint: () => {} };
  let kind = box.querySelector('#a-depkind [aria-pressed="true"]')?.dataset.dk || 'term';
  const num = (sel) => { const v = $(sel).value.trim().replace(',', '.'); return v ? Number(v) : null; };
  const preview = () => {
    const rate = num('#a-rate2');
    const principal = toMinor($('#a-open').value || '0');
    if (!rate || !(principal > 0)) { $('#a-dep-preview').textContent = ''; return; }
    if (kind === 'term') {
      const r = termDeposit({ principal, rate, months: Number($('#a-term').value), startDate: $('#a-start').value || todayISO(), today: todayISO() });
      $('#a-dep-preview').innerHTML = `Wyciągniesz <b>${esc(formatMoney(r.payout))}</b> (odsetki ${esc(formatMoney(r.gross))} − podatek ${esc(formatMoney(r.tax))}) · koniec ${esc(formatDatePL(r.end))}`;
    } else {
      const e = savingsEstimate({ balance: principal, rate });
      $('#a-dep-preview').innerHTML = `Ok. <b>${esc(formatMoney(e.month))}</b> miesięcznie po podatku`;
    }
  };
  const paint = () => {
    const st = getSubtype();
    box.hidden = !(st === 'deposit');
    box.querySelectorAll('[data-dk]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.dk === kind)));
    $('#a-term-wrap').hidden = kind !== 'term';
    $('#a-promo').hidden = kind === 'term';
    $('#a-start-label').textContent = kind === 'term' ? 'Data założenia lokaty' : 'Początek promocji (jeśli jest)';
    preview();
  };
  box.querySelector('#a-depkind').onclick = (e) => { const b = e.target.closest('[data-dk]'); if (b) { kind = b.dataset.dk; paint(); } };
  for (const sel of ['#a-rate2', '#a-term', '#a-start', '#a-open']) $(sel)?.addEventListener('input', preview);
  paint();
  return {
    paint,
    read() {
      if (box.hidden) return { ok: true, data: { rate: null, depositKind: null } };
      const rate = num('#a-rate2');
      if (rate != null && !(rate >= 0 && rate <= 50)) return { error: 'Oprocentowanie od 0 do 50%.' };
      if (!rate) return { ok: true, data: { rate: null, depositKind: null } };
      const data = { rate, depositKind: kind, startDate: $('#a-start').value || todayISO() };
      if (kind === 'term') Object.assign(data, { termMonths: Number($('#a-term').value), promoRate: null, promoLimit: null, promoMonths: null });
      else {
        const pr = num('#a-prate');
        Object.assign(data, { termMonths: null, promoRate: pr, promoLimit: $('#a-plimit').value.trim() ? toMinor($('#a-plimit').value) : null, promoMonths: num('#a-pmonths') });
        if (pr != null && !(pr >= 0 && pr <= 50)) return { error: 'Promocja: od 0 do 50%.' };
      }
      return { ok: true, data };
    },
  };
}

/** Przypomnienia o lokatach (tylko przypomnienie — nic nie dzieje się automatycznie). */
function depositReminders() {
  const txs = liveTx();
  const bookB = balances(state.data.accounts, txs);
  let snoozed = {};
  try { snoozed = JSON.parse(localStorage.getItem('sf-dep-snooze') || '{}'); } catch { /* brak */ }
  const due = depositsDue(state.data.accounts, bookB, todayISO(), 7, snoozed);
  return due.map((d) => `<div class="note warn dep-note">🔔 <b>${esc(d.account.name)}</b>: ${d.ended ? 'lokata się skończyła' : `koniec za ${d.daysLeft} ${d.daysLeft === 1 ? 'dzień' : 'dni'} (${esc(formatDatePL(d.end))})`}.
    Wyciągniesz <b class="num">${esc(formatMoney(d.payout))}</b> (w tym +${esc(formatMoney(d.net))} odsetek po podatku).
    <div class="actions three-btn">
      <button class="btn primary" data-action="dep-payout" data-id="${esc(d.account.id)}">Wypłać na konto</button>
      <button class="btn" data-action="dep-renew" data-id="${esc(d.account.id)}">Odnów</button>
      <button class="btn" data-action="dep-snooze" data-id="${esc(d.account.id)}">Później</button>
    </div></div>`).join('');
}

/** Zapisuje odsetki z zakończonej lokaty jako przychód na lokacie (kategoria „Inne przychody”). */
async function bookDepositInterest(a) {
  const bookB = balances(state.data.accounts, liveTx())[a.id];
  const r = termDeposit({ principal: bookB, rate: a.rate, months: a.termMonths, startDate: a.startDate, today: todayISO() });
  const now = new Date().toISOString();
  if (r.net > 0) {
    await db.put('transactions', { id: db.newId('tx'), createdAt: now, updatedAt: now, type: 'income', amount: r.net, currency: a.currency, date: r.ended ? r.end : todayISO(),
      categoryId: 'inc-other', accountId: a.id, toAccountId: null, description: `Odsetki: ${a.name}`, tags: ['odsetki'], recurring: false, refund: false });
  }
  return r;
}

async function depositAction(kind, id) {
  const a = accById()[id];
  if (!a) return;
  if (kind === 'snooze') {
    let s = {};
    try { s = JSON.parse(localStorage.getItem('sf-dep-snooze') || '{}'); } catch { /* brak */ }
    s[id] = addDays(todayISO(), 1);
    try { localStorage.setItem('sf-dep-snooze', JSON.stringify(s)); } catch { /* brak */ }
    render();
    toast('Przypomnę jutro');
    return;
  }
  const r = termDeposit({ principal: balances(state.data.accounts, liveTx())[a.id], rate: a.rate, months: a.termMonths, startDate: a.startDate, today: todayISO() });
  const ok = await confirmSheet(kind === 'renew' ? 'Odnowić lokatę?' : 'Wypłacić lokatę?',
    kind === 'renew'
      ? `Odsetki <b>+${esc(formatMoney(r.net))}</b> zostaną dopisane do lokaty, a nowy okres (${a.termMonths} mies., ${pct2(a.rate)}%) zacznie się ${esc(formatDatePL(r.ended ? r.end : todayISO()))}. Oprocentowanie zmienisz później w Edytuj.`
      : `Odsetki <b>+${esc(formatMoney(r.net))}</b> zostaną zapisane jako przychód, a potem otworzy się przelew całej kwoty <b>${esc(formatMoney(r.payout))}</b> na wybrane konto.`,
    { confirmLabel: kind === 'renew' ? 'Odnów' : 'Dalej' });
  if (!ok) return;
  await bookDepositInterest(a);
  if (kind === 'renew') {
    await db.put('accounts', { ...a, startDate: r.ended ? r.end : todayISO() });
    await reload();
    toast('Lokata odnowiona');
  } else {
    await db.put('accounts', { ...a, depositKind: 'term', rate: a.rate, startDate: a.startDate });
    await reload();
    await openMoveSheet(a.id, 'out');
    $('#mv-amount').value = minorToInput(balances(state.data.accounts, liveTx())[a.id]);
  }
}

// ---------- Wykres majątku w czasie ----------
const PART_COLORS = { current: '#5b8def', savings: 'var(--accent)', property: '#c9a227', debt: 'var(--expense)' };
const PART_LABELS = { current: 'Konta', savings: 'Oszczędności i inwestycje', property: 'Nieruchomości', debt: 'Długi' };

function nwSeries() {
  return netWorthHistory({ accounts: state.data.accounts, transactions: liveTx(), prices: state.prices, snapshots: state.snapshots || {}, currentYm: monthKey(todayISO()), today: todayISO() });
}

function nwChartCard({ lpAttr = '' } = {}) {
  const all = nwSeries();
  const range = state.nwRange || '12';
  const series = range === 'all' ? all : all.slice(-Number(range));
  const st = historyStats(all);
  const layers = state.nwLayers;
  const chip = (id, l) => `<button class="chip" data-action="nw-range" data-r="${id}" aria-pressed="${range === id}">${l}</button>`;
  const sign = (v) => `${v >= 0 ? '+' : '−'}${formatMoney(Math.abs(v))}`;
  const labels = series.map((p) => `${monthShortPL(p.ym)}${p.ym.endsWith('-01') || series.length < 13 ? ' ' + p.ym.slice(2, 4) : ''}`);
  const lines = [{ values: series.map((p) => p.net), color: 'var(--accent)' }];
  if (layers) for (const k of ['current', 'savings', 'property', 'debt']) if (series.some((p) => p.parts[k])) lines.push({ values: series.map((p) => p.parts[k]), color: PART_COLORS[k], dash: true });
  return `<section class="card chart" ${lpAttr}><h2>Majątek w czasie <button class="link" data-action="film">🎬 Film</button></h2>
    ${series.length > 1 ? lineChart(lines, labels, { height: 170, fromZero: false }) : '<p class="small muted">Wykres pojawi się, gdy będzie co najmniej miesiąc danych. Już teraz liczy się historia z Twoich transakcji.</p>'}
    ${layers ? `<div class="legend"><span><i style="background:var(--accent)"></i>Netto</span>${['current', 'savings', 'property', 'debt'].filter((k) => series.some((p) => p.parts[k])).map((k) => `<span><i style="background:${PART_COLORS[k]}"></i>${PART_LABELS[k]}</span>`).join('')}</div>` : ''}
    <div class="chips" style="margin-top:8px">${chip('6', '6 mies.')}${chip('12', '12 mies.')}${chip('all', 'Wszystko')}<button class="chip" data-action="nw-layers" aria-pressed="${!!layers}">Warstwy</button></div>
    ${st ? `<div class="stat-row" style="margin-top:10px">
      <div class="stat"><small>Za miesiąc</small><b class="${(st.m1 ?? 0) >= 0 ? 'pos' : 'neg'}">${st.m1 != null ? `<span class="num">${esc(sign(st.m1))}</span>` : '—'}</b>${st.m1pct != null ? `<small>${esc(fmtPct(st.m1pct * 100))}</small>` : ''}</div>
      <div class="stat"><small>Za rok</small><b class="${(st.y1 ?? 0) >= 0 ? 'pos' : 'neg'}">${st.y1 != null ? `<span class="num">${esc(sign(st.y1))}</span>` : '—'}</b>${st.y1pct != null ? `<small>${esc(fmtPct(st.y1pct * 100))}</small>` : ''}</div>
      <div class="stat"><small>Średnio / mies.</small><b class="num">${st.months > 1 ? esc(sign(st.avg)) : '—'}</b>${st.best && st.months > 1 ? `<small>najlepszy: ${esc(monthShortPL(st.best.ym))}</small>` : ''}</div>
    </div>` : ''}
  </section>`;
}

/** Raz dziennie zapisuje „zdjęcie” majątku za bieżący miesiąc (dokładna historia także dla wycen ręcznych). */
async function saveSnapshot() {
  const ym = monthKey(todayISO());
  const w = valuedNetWorth(state.data.accounts, liveTx(), valOpts());
  const snaps = { ...(state.snapshots || {}) };
  snaps[ym] = { net: w.net, assets: w.assets, liabilities: w.liabilities, parts: breakdown(state.data.accounts, w.values), at: todayISO() };
  state.snapshots = snaps;
  await db.setSetting('nwSnapshots', snaps);
}

// ---------- Film o majątku ----------
function filmData() {
  const txs = liveTx();
  const now = monthKey(todayISO());
  const w = valuedNetWorth(state.data.accounts, txs, valOpts());
  const parts = breakdown(state.data.accounts, w.values);
  const hist = nwSeries().slice(-24);
  const st = historyStats(nwSeries());
  const avg = averages(txs, now, 3);
  const cur = monthSummary(txs, now);
  const cats = catById();
  const byP = Object.entries(rollupByParent(cur.expenseByCategory, state.data.categories)).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
  const prev = monthSummary(txs, addMonths(now, -1));
  const ch = categoryChanges(cur, prev, state.data.categories).filter((c) => c.diff > 0)[0];
  const s = simSettings();
  const sim = runSim(s, simStart());
  const pay = sim.payoffs.filter((p) => p.month != null).sort((a, b) => a.month - b.month)[0];
  const y0 = Number(todayISO().slice(0, 4));
  const fmt = (v) => formatMoney(v).replace(/,\d\d(?=\s*zł)/, '');
  const fmtSpeak = (v) => `${Math.round(v / 100).toLocaleString('pl-PL')} złotych`;
  const name = state.profile?.name;
  return {
    title: name ? `${name}, Twój majątek` : 'Twój majątek',
    subtitle: monthNamePL(now),
    net: w.net,
    parts: [
      { label: 'Konta', value: parts.current, color: '#8fb6ff' },
      { label: 'Oszczędności i inwestycje', value: parts.savings, color: '#7CF0B4' },
      { label: 'Nieruchomości', value: parts.property, color: '#FFD54A' },
      { label: 'Długi', value: parts.debt, color: '#FF9C8F' },
    ],
    history: hist.map((h) => ({ label: `${monthShortPL(h.ym)} ${h.ym.slice(2, 4)}`, net: h.net })),
    m1: st?.m1 ?? null,
    avgGrowth: st && st.months > 1 ? st.avg : null,
    savingsRate: avg.months && avg.income > 0 ? Math.max(0, avg.net / avg.income) : cur.savingsRate,
    topCategory: byP[0] ? `${catLabel(byP[0][0], cats)} · ${fmt(byP[0][1])}` : null,
    rising: ch ? `${catLabel(ch.categoryId, cats)} +${fmt(ch.diff)}` : null,
    future: sim.series.map((p) => ({ net: p.net })),
    futureYears: s.years,
    futureNet: sim.final.net,
    payoffText: pay ? `${pay.name} spłacony: ${monthNamePL(addMonths(now, pay.month)).toLowerCase()}` : (sim.milestones[0] ? `${fmt(sim.milestones[0].amount)} netto: ${monthNamePL(addMonths(now, sim.milestones[0].month)).toLowerCase()}` : ''),
    outro: w.net >= 0 ? (st?.m1 > 0 ? 'Idziesz w dobrą stronę! 🚀' : 'Krok po kroku do celu 💪') : 'Każda spłata to krok do przodu 💪',
    fmt, fmtSpeak,
  };
}

function openFilm() {
  const root = $('#film-root');
  if (!root) return;
  playFilm(root, filmData(), { voice: getPref('sf-film-voice', '0') === '1', onClose: () => {} });
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
  const lk = lockCfg();
  return `<section class="card"><h2>Profil</h2>
      <button class="hello link" data-action="profile" style="color:inherit;margin:0"><span class="av">${profileAvatar()}</span>${state.profile?.name ? esc(state.profile.name) : 'Dodaj imię i avatar'} <span class="small muted" style="margin-left:auto">Edytuj ›</span></button>
    </section>
    <section class="card"><h2>Logowanie (blokada aplikacji)</h2>
      <div class="row-set"><span>Wymagaj PIN-u przy otwarciu<span class="sub">Chroni przed kimś, kto weźmie odblokowany telefon</span></span>${sw('set-lock', !!lk?.pin, 'lock-toggle')}</div>
      ${lk?.pin ? `
        ${state.bioAvailable ? `<div class="row-set"><span>Odblokowanie odciskiem palca<span class="sub">Lub rozpoznaniem twarzy — zależnie od telefonu</span></span>${sw('set-bio', !!lk.bio, 'bio-toggle')}</div>` : ''}
        <div class="row-set"><span>Blokuj po wyjściu z aplikacji</span><select id="set-locktime">
          ${[[0, 'od razu'], [1, 'po 1 minucie'], [5, 'po 5 minutach'], [15, 'po 15 minutach']].map(([v, l]) => `<option value="${v}" ${(lk.timeout ?? 1) === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
        <ul class="menu"><li><button data-action="lock-change"><span>Zmień PIN</span>›</button></li></ul>` : ''}
      <p class="small muted">Blokada działa w tym telefonie. Dane w pamięci przeglądarki nie są przez nią dodatkowo szyfrowane — dlatego używaj też blokady ekranu telefonu.</p>
    </section>
    <section class="card"><h2>Wygląd</h2>
      <div class="row-set" style="border-top:0;padding-top:0"><span>Animacja przy uruchomieniu<span class="sub">2 sekundy, dotknięcie pomija</span></span>${sw('set-splash', getPref('sf-splash', '1') === '1', 'splash-toggle')}</div>
      <div class="row-set"><span>Lektor w filmie o majątku<span class="sub">Głos syntezatora telefonu (po polsku)</span></span>${sw('set-film-voice', getPref('sf-film-voice', '0') === '1', 'film-voice-toggle')}</div>
      <div class="row-set"><span>Ikony generowane<span class="sub">Kolory banków i firm, inicjały, ikony rodzaju — bez internetu</span></span>${sw('set-genicons', genIconsOn(), 'genicons-toggle')}</div>
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
    <section class="card"><h2>Ceny kryptowalut (CoinGecko)</h2>
      <p class="small muted">Działa bez klucza. Jeśli pojawi się „limit zapytań”, załóż darmowy klucz „Demo” na coingecko.com/api i wklej go tutaj — zostaje tylko w tym telefonie.</p>
      <div class="qa"><input id="set-cg-key" type="password" autocomplete="off" spellcheck="false" placeholder="${cgKey() ? '••••' + esc(cgKey().slice(-4)) : 'klucz (opcjonalnie)'}"><button class="btn" data-action="cg-key-save">Zapisz</button></div>
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
    if (g === 'savings') items.push(item('move', '➕', metalOf(a) ? 'Kupno' : 'Wpłata', { close: false, extra: 'data-mode="in"' }), item('move', '➖', metalOf(a) ? 'Sprzedaż' : 'Wypłata', { close: false, extra: 'data-mode="out"' }));
    if ((g === 'savings' && !metalOf(a)) || g === 'property') items.push(item('valuate', '📈', 'Aktualizuj wartość', { close: false }));
    if (g === 'loan') items.push(item('move', '💸', 'Dodaj spłatę', { close: false, extra: 'data-mode="pay"' }));
    items.push(
      item('account-detail', '📜', 'Historia', { close: false }),
      item('edit-account', '✏️', 'Edytuj', { close: false }),
      item('archive-acc', '📦', 'Zarchiwizuj (ukryj)'),
      item('del-account', '🗑️', 'Usuń konto', { danger: true }),
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
  const row = (c, child) => `<li><button data-action="edit-cat" data-id="${esc(c.id)}"><span>${child ? '&nbsp;&nbsp;↳ ' : ''}${ico(c.icon, c.image, { mini: true })} ${esc(c.name)}${c.archived ? ' <span class="badge">ukryta</span>' : ''}</span>›</button></li>`;
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
    ${imagePickerHtml()}
    ${c ? `<label class="check"><input type="checkbox" id="c-arch" ${c.archived ? 'checked' : ''}> Ukryj kategorię (historia zostaje)</label>` : ''}
    <div class="err" id="c-err"></div>
    <div class="actions"><button class="btn primary block" id="c-save">Zapisz</button></div>`);
  const pick = mountImagePicker(c?.image);
  $('#c-save').onclick = async () => {
    const name = $('#c-name').value.trim();
    if (!name) { $('#c-err').textContent = 'Podaj nazwę.'; return; }
    const item = {
      ...(c || { id: db.newId('cat'), kind }),
      name, icon: $('#c-icon').value.trim(),
      parentId: $('#c-parent').value || null,
      keywords: $('#c-kw').value.split(',').map((s) => s.trim()).filter(Boolean),
      archived: c ? $('#c-arch').checked : false,
      image: pick.get() || null,
    };
    await db.put('categories', item);
    await reload();
    openCategoriesSheet(kind);
    toast('Zapisano kategorię');
  };
}

function openTrashSheet() {
  const cats = catById();
  const del = state.data.transactions.filter((t) => t.deletedAt && !t.deletedWithAccount).sort((a, b) => b.deletedAt.localeCompare(a.deletedAt));
  const accs = state.deletedAccounts;
  const withAcc = (id) => state.data.transactions.filter((t) => t.deletedWithAccount === id).length;
  openSheet('Kosz', del.length || accs.length ? `
    ${accs.length ? `<h3 class="copy-h">Usunięte konta</h3><div class="list">${accs.map((a) => `<div class="item"><span class="ico">${accIco(a)}</span>
      <span class="mid"><span class="t1">${esc(a.name)}</span><span class="t2">${esc(accountKindLabel(a))} · ${withAcc(a.id)} transakcji · usunięte ${esc(formatDatePL(a.deletedAt.slice(0, 10)))}</span></span>
      <button class="link" data-action="restore-account" data-id="${esc(a.id)}">Przywróć</button></div>`).join('')}</div>` : ''}
    ${del.length ? `<h3 class="copy-h">Transakcje</h3><div class="list">${del.map((t) => `<div class="item"><span class="ico">${txIco(t, cats)}</span>
      <span class="mid"><span class="t1">${esc(t.description || catLabel(t.categoryId, cats))}</span><span class="t2">${esc(formatDatePL(t.date))} · ${esc(formatMoney(t.amount, t.currency))}</span></span>
      <button class="link" data-action="restore-tx" data-id="${esc(t.id)}">Przywróć</button></div>`).join('')}</div>` : ''}
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
    type: existing?.type || opts.type || 'expense',
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
    ${existing ? '' : `<div class="quick"><input id="t-quick" placeholder="Szybko: „Paliwo 250 zł dzisiaj”" autocomplete="off" enterkeyhint="done">${speechSupported() ? '<button type="button" class="mic" id="t-mic" aria-label="Dyktuj głosem">🎤</button>' : ''}</div>
    <div class="quick-hint" id="t-hint"></div>`}
    ${recent.length ? `<div class="chips" style="margin-top:6px">${recent.map((t, i) => `<button type="button" class="chip" data-recent="${i}">${catIco(t.categoryId, catById(), { mini: true })} ${esc(t.description)}</button>`).join('')}</div>` : ''}
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
      <b>${ico(c.icon || '•', c.image)}</b>${esc(c.name)}${c.parentId && all[c.parentId] ? `<small class="muted">${esc(all[c.parentId].name)}</small>` : ''}</button>`).join('')
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
    const mic = $('#t-mic');
    if (mic) mic.onclick = () => dictateInto(quick);
    if (opts.voice && mic) setTimeout(() => dictateInto(quick), 300);
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
    // spóźnione zdarzenie „close” od poprzedniego okienka nie może anulować tego potwierdzenia
    const onClose = () => { if (!$('#sheet').open) { $('#sheet').removeEventListener('close', onClose); resolve(false); } };
    $('#sheet').addEventListener('close', onClose);
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
    case 'plan-fix-tx': fixMissingPlanTx(); break;
    case 'to-property': moveToProperty(el.dataset.id); break;
    case 'dep-payout': depositAction('payout', el.dataset.id); break;
    case 'dep-renew': depositAction('renew', el.dataset.id); break;
    case 'dep-snooze': depositAction('snooze', el.dataset.id); break;
    case 'nw-range': state.nwRange = el.dataset.r; render(); break;
    case 'nw-layers': state.nwLayers = !state.nwLayers; render(); break;
    case 'film': openFilm(); break;
    case 'film-voice-toggle': setPref('sf-film-voice', el.checked ? '1' : '0'); break;
    case 'pos-add': openPositionSheet(el.dataset.id); break;
    case 'pos-edit': openPositionSheet(el.dataset.id, el.dataset.pid); break;
    case 'batch': openBatchSheet(); break;
    case 'cg-key-save': setPref('sf-cg-key', $('#set-cg-key').value.trim()); toast('Zapisano'); render(); break;
    case 'del-account': if ($('#sheet').open) closeSheet(); deleteAccountFlow(el.dataset.id); break;
    case 'restore-account': await restoreAccount(el.dataset.id); openTrashSheet(); break;
    case 'profile': openProfileSheet(); break;
    case 'genicons-toggle': setPref('sf-genicons', el.checked ? '1' : '0'); render(); break;
    case 'splash-toggle': setPref('sf-splash', el.checked ? '1' : '0'); break;
    case 'lock-toggle':
      if (el.checked) { el.checked = false; openPinSetup(); } else { el.checked = true; disableLock(); }
      break;
    case 'lock-change': openPinSetup({ change: true }); break;
    case 'bio-toggle': toggleBio(el.checked); break;
    case 'dash-mic': { const inp = $('#dash-quick'); if (inp) { await dictateInto(inp); if (inp.value.trim()) openTxSheet(null, { quick: inp.value.trim() }); } break; }
    case 'valuate': openValuationSheet(el.dataset.id); break;
    case 'del-valuation': {
      const acc = accById()[el.dataset.id];
      if (!acc) break;
      const removed = (acc.valuations || []).find((v) => v.date === el.dataset.date);
      await db.put('accounts', { ...acc, valuations: (acc.valuations || []).filter((v) => v.date !== el.dataset.date) });
      await reload();
      openAccountDetail(acc.id);
      toast('Usunięto wycenę', { label: 'Cofnij', run: async () => { const cur = accById()[acc.id]; await db.put('accounts', { ...cur, valuations: [...(cur.valuations || []), removed] }); await reload(); } });
      break;
    }
    case 'refresh-prices': refreshMetalPrices({ force: true, silent: false }); break;
    case 'metal-chart': state.metalChart = el.dataset.m; render(); break;
    case 'sim-reset': state.simSettings = null; await db.setSetting('simSettings', null); render(); toast('Przywrócono domyślne założenia'); break;
    case 'sim-ai': {
      const s2 = simSettings();
      const r = runSim(s2, simStart());
      const nowY = Number(todayISO().slice(0, 4));
      const il = s2.il.on ? investLoanAnalysis({ amount: Math.round(s2.il.amount * 100), rate: s2.il.rate, months: s2.il.months, ret: s2.il.ret, belka: s2.belka }) : null;
      state.plansTab = 'ai';
      render();
      askAI(`Oceń moją symulację majątku na ${s2.years} lat. Założenia: zwroty lokaty ${s2.rSafe}%, ETF ${s2.rMarket}%, IKE ${s2.rRetire}%, metale ${s2.rMetal}%, inflacja ${s2.inflation}%, podatek Belki ${s2.belka ? 'tak' : 'nie'}, nadpłata kredytów ${s2.overpay || 0} zł/mies. Wynik (szacunek): majątek netto w ${nowY + s2.years} r. ok. ${formatMoney(r.final.net)} (po inflacji ${formatMoney(r.final.netReal)}).${il ? ` Kredyt inwestycyjny ${s2.il.amount} zł na ${s2.il.rate}% przez ${s2.il.months} mies., zakładany zysk ${s2.il.ret}%: rata ${formatMoney(il.installment)}, odsetki ${formatMoney(il.interest)}, różnica vs bez kredytu ${formatMoney(il.base.benefit)}, próg opłacalności ${il.breakEven}%.` : ''} Czy założenia są realistyczne i na co uważać?`);
      break;
    }
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
      const na = state.deletedAccounts.length;
      if (await confirmSheet('Opróżnić kosz?', `Trwale usunąć ${n} transakcji${na ? ` i ${na} kont` : ''}? Tego nie da się cofnąć.`, { confirmLabel: 'Usuń trwale', danger: true })) {
        for (const t of state.data.transactions.filter((x) => x.deletedAt)) await db.remove('transactions', t.id);
        for (const a of state.deletedAccounts) await db.remove('accounts', a.id);
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
  runSplash();
  setupLock();
  const params = new URLSearchParams(location.search);
  const shortcut = params.get('add');
  if (shortcut) history.replaceState(null, '', location.pathname + location.hash);
  window.addEventListener('unhandledrejection', (e) => showError(e.reason));
  window.addEventListener('error', (e) => showError(e.error || e.message));
  document.addEventListener('click', onAction);
  setupLongPress();
  document.addEventListener('toggle', (e) => { const d = e.target; if (d.matches?.('details.pos')) state.openPos = { ...state.openPos, [d.dataset.pos]: d.open }; }, true);
  document.addEventListener('change', async (e) => {
    if (e.target.id === 'set-locktime') {
      const cfg = lockCfg();
      if (cfg) saveLockCfg({ ...cfg, timeout: Number(e.target.value) });
      toast('Zapisano');
      return;
    }
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
    state.prices = await db.getSetting('metalPrices', null);
    state.simSettings = await db.getSetting('simSettings', null);
    state.profile = await db.getSetting('profile', null);
    state.snapshots = (await db.getSetting('nwSnapshots', null)) || {};
    if (state.profile?.name) setPref('sf-name', state.profile.name);
    state.prefs.defaultAccount = await db.getSetting('defaultAccount', '') || '';
    await loadData();
  } catch (err) {
    $('#view').innerHTML = `<div class="note warn">Nie można otworzyć bazy danych: ${esc(err.message)}<br>Sprawdź, czy przeglądarka nie jest w trybie prywatnym.</div>`;
    return;
  }
  state.persisted = await db.requestPersistence();
  const locked = lockEnabled() ? showLock() : Promise.resolve();
  route();
  biometricAvailable().then((v) => { state.bioAvailable = v; if (state.view === 'settings') render(); });
  if (hasMetals() || hasCrypto() || visibleCards(state.layout).includes('metals')) refreshMetalPrices();
  saveSnapshot().catch(() => {});
  await locked;
  if (shortcut === 'expense' || shortcut === 'income') openTxSheet(null, { type: shortcut });
  else if (shortcut === 'voice') openTxSheet(null, { voice: true });
  else if (shortcut === 'batch') openBatchSheet();
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch(() => { /* offline niedostępny — aplikacja działa dalej */ });
  }
}

init();
