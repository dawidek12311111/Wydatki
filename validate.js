// Walidacja danych przed zapisem i przed przywróceniem kopii zapasowej.
import { isValidISODate } from './dates.js';

const TYPES = ['income', 'expense', 'transfer'];
const MAX_AMOUNT = 100_000_000_000; // 1 mld zł w groszach

/** Zwraca listę błędów (pustą, gdy transakcja jest poprawna). */
export function validateTransaction(t, { accounts = [], categories = [] } = {}) {
  const errors = [];
  const accIds = new Set(accounts.map((a) => a.id));
  if (!t || typeof t !== 'object') return ['Brak danych transakcji'];
  if (!TYPES.includes(t.type)) errors.push('Nieznany typ transakcji');
  if (!Number.isInteger(t.amount) || t.amount <= 0) errors.push('Kwota musi być większa od zera');
  else if (t.amount > MAX_AMOUNT) errors.push('Kwota jest zbyt duża');
  if (!isValidISODate(t.date)) errors.push('Nieprawidłowa data');
  if (typeof t.currency !== 'string' || !/^[A-Z]{3}$/.test(t.currency)) errors.push('Nieprawidłowa waluta');
  const known = (id) => !accounts.length || accIds.has(id);
  if (t.type === 'transfer') {
    // jedna strona może być „poza aplikacją” (null) — np. wpłata na IKE zapisana bez konta źródłowego
    const from = t.accountId || null;
    const to = t.toAccountId || null;
    if (!from && !to) errors.push('Wybierz konto');
    if (from && !known(from)) errors.push('Nieznane konto źródłowe');
    if (to && !known(to)) errors.push('Nieznane konto docelowe');
    if (from && to && from === to) errors.push('Konto źródłowe i docelowe muszą być różne');
    if (t.toAmount != null && (!Number.isInteger(t.toAmount) || t.toAmount <= 0)) errors.push('Nieprawidłowa kwota docelowa');
  } else if (!t.accountId || !known(t.accountId)) {
    errors.push('Wybierz konto');
  }
  if (t.type !== 'transfer' && t.categoryId && categories.length) {
    const cat = categories.find((c) => c.id === t.categoryId);
    if (!cat) errors.push('Nieznana kategoria');
    else if (cat.kind !== t.type) errors.push('Kategoria nie pasuje do typu transakcji');
  }
  if (t.description != null && (typeof t.description !== 'string' || t.description.length > 200)) errors.push('Opis może mieć maks. 200 znaków');
  if (t.tags != null && (!Array.isArray(t.tags) || t.tags.some((x) => typeof x !== 'string'))) errors.push('Nieprawidłowe tagi');
  return errors;
}

/** Pozycja listy „Do zapłaty”. */
export function validateBill(b) {
  const errors = [];
  if (!b || typeof b !== 'object') return ['Brak danych'];
  if (typeof b.name !== 'string' || !b.name.trim()) errors.push('Wpisz, co trzeba zapłacić');
  else if (b.name.length > 80) errors.push('Opis może mieć maks. 80 znaków');
  if (!Number.isInteger(b.amount) || b.amount <= 0) errors.push('Kwota musi być większa od zera');
  else if (b.amount > MAX_AMOUNT) errors.push('Kwota jest zbyt duża');
  if (typeof b.month !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(b.month)) errors.push('Nieprawidłowy miesiąc');
  if (typeof b.paid !== 'boolean') errors.push('Nieprawidłowy status');
  return errors;
}

/** Sprawdza plik kopii zapasowej. Zwraca { ok, errors, counts }. */
export function validateBackup(data) {
  const errors = [];
  if (!data || typeof data !== 'object') return { ok: false, errors: ['To nie jest plik kopii Smart Finance'] };
  if (data.app !== 'smart-finance') errors.push('To nie jest plik kopii Smart Finance');
  for (const key of ['accounts', 'categories', 'transactions', 'budgets']) {
    if (!Array.isArray(data[key])) errors.push(`Brak sekcji: ${key}`);
  }
  if (errors.length) return { ok: false, errors };
  const ids = (arr) => arr.every((x) => x && typeof x.id === 'string');
  if (!ids(data.accounts) || !ids(data.categories) || !ids(data.transactions) || !ids(data.budgets)) {
    errors.push('Uszkodzone rekordy (brak identyfikatorów)');
  }
  let bad = 0;
  for (const t of data.transactions) {
    if (validateTransaction(t, { accounts: data.accounts, categories: data.categories }).length) bad++;
  }
  if (bad) errors.push(`${bad} transakcji ma nieprawidłowe dane`);
  if (data.bills != null) {
    if (!Array.isArray(data.bills) || !ids(data.bills)) errors.push('Uszkodzona lista „Do zapłaty”');
    else if (data.bills.some((b) => validateBill(b).length)) errors.push('Nieprawidłowe pozycje na liście „Do zapłaty”');
  }
  return {
    ok: errors.length === 0,
    errors,
    counts: { accounts: data.accounts.length, categories: data.categories.length, transactions: data.transactions.length },
  };
}
