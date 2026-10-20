// Eksport transakcji do CSV (średnik + przecinek dziesiętny — otwiera się poprawnie w polskim Excelu).
import { minorToInput } from './money.js';
import { formatDatePL } from './dates.js';
import { isLive } from './calc.js';

const TYPE_PL = { income: 'Przychód', expense: 'Wydatek', transfer: 'Transfer' };

function cell(v) {
  let s = String(v ?? '');
  // ochrona przed "wstrzykiwaniem formuł" w Excelu
  if (/^[=+\-@\t\r]/.test(s) && !/^-?\d/.test(s)) s = "'" + s;
  return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function transactionsToCSV(transactions, { accounts = [], categories = [] } = {}) {
  const acc = Object.fromEntries(accounts.map((a) => [a.id, a.name]));
  const cat = Object.fromEntries(categories.map((c) => [c.id, c]));
  const catName = (id) => {
    const c = cat[id];
    if (!c) return ['', ''];
    return c.parentId && cat[c.parentId] ? [cat[c.parentId].name, c.name] : [c.name, ''];
  };
  const header = ['Data', 'Typ', 'Kwota', 'Waluta', 'Kategoria', 'Podkategoria', 'Konto', 'Konto docelowe', 'Opis', 'Tagi', 'Cykliczna', 'Zwrot'];
  const rows = transactions
    .filter(isLive)
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((t) => {
      const signed = t.type === 'income' || (t.type === 'expense' && t.refund) ? t.amount : t.type === 'expense' ? -t.amount : t.amount;
      const [c1, c2] = catName(t.categoryId);
      return [formatDatePL(t.date), TYPE_PL[t.type], minorToInput(signed), t.currency, c1, c2,
        acc[t.accountId] || '', acc[t.toAccountId] || '', t.description || '', (t.tags || []).join(', '),
        t.recurring ? 'tak' : '', t.refund ? 'tak' : ''];
    });
  return '﻿' + [header, ...rows].map((r) => r.map(cell).join(';')).join('\r\n');
}
