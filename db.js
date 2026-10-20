// Jedyne miejsce dostępu do danych. W MVP: IndexedDB w telefonie.
// W Etapie 6 ten moduł dostanie synchronizację z Firebase — reszta aplikacji się nie zmieni.
import { DEFAULT_CATEGORIES, DEFAULT_ACCOUNTS } from './defaults.js';

const DB_NAME = 'smart-finance';
const DB_VERSION = 3; // 2: lista „Do zapłaty” (bills), 3: „Do kupienia” (purchases)
export const SCHEMA_VERSION = 3;
const STORES = ['accounts', 'categories', 'transactions', 'budgets', 'bills', 'purchases', 'settings'];
const DATA_STORES = ['accounts', 'categories', 'transactions', 'budgets', 'bills', 'purchases'];

let dbPromise;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const name of STORES) {
        if (!db.objectStoreNames.contains(name)) {
          const store = db.createObjectStore(name, { keyPath: 'id' });
          if (name === 'transactions') store.createIndex('date', 'date');
        }
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      // inna karta / nowsza wersja aplikacji chce zaktualizować bazę — zwalniamy ją i przeładowujemy
      db.onversionchange = () => { db.close(); location.reload(); };
      resolve(db);
    };
    req.onerror = () => {
      dbPromise = null;
      const e = req.error;
      reject(e && e.name === 'VersionError'
        ? new Error('Na telefonie jest nowsza baza niż ta wersja aplikacji. Zamknij aplikację całkowicie i otwórz ponownie.')
        : e);
    };
    req.onblocked = () => reject(new Error('Zamknij inne karty z aplikacją i spróbuj ponownie.'));
  });
  return dbPromise;
}

function done(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('Zapis przerwany'));
  });
}

export async function getAll(store) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const req = db.transaction(store).objectStore(store).getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function put(store, ...items) {
  const db = await open();
  const tx = db.transaction(store, 'readwrite');
  for (const item of items) tx.objectStore(store).put(item);
  return done(tx);
}

export async function remove(store, id) {
  const db = await open();
  const tx = db.transaction(store, 'readwrite');
  tx.objectStore(store).delete(id);
  return done(tx);
}

export async function getSetting(key, fallback = null) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const req = db.transaction('settings').objectStore('settings').get(key);
    req.onsuccess = () => resolve(req.result ? req.result.value : fallback);
    req.onerror = () => reject(req.error);
  });
}
export const setSetting = (key, value) => put('settings', { id: key, value });

/** Pierwsze uruchomienie: domyślne kategorie i konta (bez żadnych transakcji). */
export async function ensureDefaults() {
  if (await getSetting('initialized')) return false;
  const now = new Date().toISOString();
  await put('categories', ...DEFAULT_CATEGORIES.map(({ since, ...c }) => ({ parentId: null, archived: false, ...c })));
  await setSetting('catsVersion', 2);
  await put('accounts', ...DEFAULT_ACCOUNTS.map((a) => ({ archived: false, createdAt: now, ...a })));
  await setSetting('initialized', now);
  await setSetting('schemaVersion', SCHEMA_VERSION);
  return true;
}

/** Dodaje kategorie wprowadzone w nowszych wersjach (nie nadpisuje istniejących). */
export async function migrate() {
  const done = await getSetting('catsVersion', 1);
  if (done >= 2) return;
  const existing = new Set((await getAll('categories')).map((c) => c.id));
  const added = DEFAULT_CATEGORIES.filter((c) => c.since === 2 && !existing.has(c.id))
    .map(({ since, ...c }) => ({ parentId: null, archived: false, ...c }));
  if (added.length) await put('categories', ...added);
  await setSetting('catsVersion', 2);
}

export async function loadAll() {
  const [accounts, categories, transactions, budgets, bills, purchases] = await Promise.all(DATA_STORES.map(getAll));
  return { accounts, categories, transactions, budgets, bills, purchases };
}

export async function exportBackup() {
  const data = await loadAll();
  const settings = (await getAll('settings')).filter((s) => s.id !== 'lastBackup');
  return { app: 'smart-finance', schemaVersion: SCHEMA_VERSION, exportedAt: new Date().toISOString(), ...data, settings };
}

/** Zastępuje wszystkie dane zawartością kopii (wywoływać dopiero po validateBackup i potwierdzeniu). */
export async function restoreBackup(data) {
  const db = await open();
  const tx = db.transaction(STORES, 'readwrite');
  for (const n of STORES) tx.objectStore(n).clear();
  for (const n of DATA_STORES) {
    for (const item of data[n] || []) tx.objectStore(n).put(item); // starsze kopie nie mają „bills”
  }
  for (const s of data.settings || []) if (s && typeof s.id === 'string') tx.objectStore('settings').put(s);
  tx.objectStore('settings').put({ id: 'initialized', value: new Date().toISOString() });
  return done(tx);
}

export async function wipeAll() {
  const db = await open();
  const tx = db.transaction(STORES, 'readwrite');
  for (const n of STORES) tx.objectStore(n).clear();
  return done(tx);
}

export function newId(prefix = 'id') {
  const rnd = crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now().toString(36);
  return `${prefix}-${rnd}`;
}

/** Prosi Androida, żeby nie czyścił danych aplikacji przy braku miejsca. */
export async function requestPersistence() {
  try {
    if (navigator.storage?.persisted && (await navigator.storage.persisted())) return true;
    return navigator.storage?.persist ? await navigator.storage.persist() : false;
  } catch {
    return false;
  }
}
