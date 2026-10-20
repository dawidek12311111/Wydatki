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
  if (!t.accountId || (accounts.length && !accIds.has(t.accountId))) errors.push('Wybierz konto');
  if (t.type === 'transfer') {
    if (!t.toAccountId || (accounts.length && !accIds.has(t.toAccountId))) errors.push('Wybierz konto docelowe');
    else if (t.toAccountId === t.accountId) errors.push('Konto źródłowe i docelowe muszą być różne');
    if (t.toAmount != null && (!Number.isInteger(t.toAmount) || t.toAmount <= 0)) errors.push('Nieprawidłowa kwota docelowa');
  } else if (t.categoryId && categories.length) {
    const cat = categories.find((c) => c.id === t.categoryId);
    if (!cat) errors.push('Nieznana kategoria');
    else if (cat.kind !== t.type) errors.push('Kategoria nie pasuje do typu transakcji');
  }
  if (t.description != null && (typeof t.description !== 'string' || t.description.length > 200)) errors.push('Opis może mieć maks. 200 znaków');
  if (t.tags != null && (!Array.isArray(t.tags) || t.tags.some((x) => typeof x !== 'string'))) errors.push('Nieprawidłowe tagi');
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
  return {
    ok: errors.length === 0,
    errors,
    counts: { accounts: data.accounts.length, categories: data.categories.length, transactions: data.transactions.length },
  };
}
