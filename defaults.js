// Domyślne kategorie i konta tworzone przy pierwszym uruchomieniu. Wszystko można później edytować.

export const DEFAULT_CATEGORIES = [
  // przychody
  { id: 'inc-salary', name: 'Wynagrodzenie', kind: 'income', icon: '💼', keywords: ['wypłata', 'wyplata', 'pensja', 'wynagrodzenie'] },
  { id: 'inc-bonus', name: 'Premie i nadgodziny', kind: 'income', icon: '⭐', keywords: ['premia', 'nadgodziny', 'bonus'] },
  { id: 'inc-benefits', name: 'Świadczenia (800+)', kind: 'income', icon: '👶', keywords: ['800+', '800', 'świadczenie', 'swiadczenie', 'zus', 'zasiłek', 'zasilek'], since: 2 },
  { id: 'inc-tax', name: 'Zwrot podatku', kind: 'income', icon: '🧾', keywords: ['pit', 'zwrot podatku', 'urząd skarbowy'], since: 2 },
  { id: 'inc-other', name: 'Inne przychody', kind: 'income', icon: '➕', keywords: ['sprzedaż', 'sprzedaz', 'olx', 'vinted'] },
  // wydatki
  { id: 'exp-home', name: 'Mieszkanie', kind: 'expense', icon: '🏠', keywords: ['czynsz', 'najem', 'wspólnota', 'kredyt hipoteczny'] },
  { id: 'exp-bills', name: 'Rachunki', kind: 'expense', icon: '💡', keywords: ['prąd', 'prad', 'gaz', 'woda', 'internet', 'telefon', 'abonament'] },
  { id: 'exp-renovation', name: 'Remonty', kind: 'expense', icon: '🔨', keywords: ['remont', 'castorama', 'leroy', 'obi', 'farba'] },
  { id: 'exp-food', name: 'Żywność', kind: 'expense', icon: '🛒', keywords: ['biedronka', 'lidl', 'żabka', 'zabka', 'kaufland', 'auchan', 'carrefour', 'dino', 'zakupy spożywcze', 'jedzenie', 'netto'] },
  { id: 'exp-transport', name: 'Transport', kind: 'expense', icon: '🚗', keywords: ['bilet', 'uber', 'bolt', 'pkp', 'parking', 'mechanik', 'myjnia'] },
  { id: 'exp-fuel', name: 'Paliwo', kind: 'expense', icon: '⛽', parentId: 'exp-transport', keywords: ['paliwo', 'tankowanie', 'orlen', 'bp', 'shell', 'circle k', 'moya', 'benzyna', 'diesel', 'lpg'] },
  { id: 'exp-health', name: 'Zdrowie', kind: 'expense', icon: '💊', keywords: ['apteka', 'lekarz', 'dentysta', 'leki'] },
  { id: 'exp-kids', name: 'Dzieci', kind: 'expense', icon: '🧸', keywords: ['przedszkole', 'zabawki', 'pieluchy'] },
  { id: 'exp-edu', name: 'Edukacja', kind: 'expense', icon: '📚', keywords: ['kurs', 'szkoła', 'szkola', 'książki', 'ksiazki'] },
  { id: 'exp-fun', name: 'Rozrywka', kind: 'expense', icon: '🎬', keywords: ['kino', 'netflix', 'spotify', 'restauracja', 'pizza', 'koncert'] },
  { id: 'exp-travel', name: 'Wakacje', kind: 'expense', icon: '✈️', keywords: ['hotel', 'wakacje', 'booking', 'lot', 'urlop'] },
  { id: 'exp-shopping', name: 'Zakupy', kind: 'expense', icon: '🛍️', keywords: ['allegro', 'ubrania', 'buty', 'rtv', 'media expert', 'zalando'] },
  { id: 'exp-debt', name: 'Zobowiązania', kind: 'expense', icon: '📄', keywords: ['rata', 'odsetki', 'leasing'] },
  { id: 'exp-other', name: 'Inne wydatki', kind: 'expense', icon: '📦', keywords: [] },
];

export const DEFAULT_ACCOUNTS = [
  { id: 'acc-main', name: 'Konto osobiste', type: 'checking', currency: 'PLN', openingBalance: 0 },
  { id: 'acc-cash', name: 'Gotówka', type: 'cash', currency: 'PLN', openingBalance: 0 },
  { id: 'acc-savings', name: 'Oszczędności', type: 'savings', currency: 'PLN', openingBalance: 0 },
];

export const ACCOUNT_TYPES = {
  checking: 'Konto bankowe',
  savings: 'Oszczędności / lokata',
  cash: 'Gotówka',
  card: 'Karta kredytowa',
  investment: 'Inwestycje (IKE, IKZE, PPK, ETF…)',
  loan: 'Kredyt / pożyczka',
  other: 'Inne',
};

/** Rodzaje oszczędności i inwestycji (pole subtype). type: 'savings' albo 'investment'. */
export const SAVINGS_KINDS = {
  deposit: { label: 'Konto oszczędn. / lokata', icon: '🐷', type: 'savings' },
  ike: { label: 'IKE', icon: '🏛️', type: 'investment' },
  ikze: { label: 'IKZE', icon: '🧾', type: 'investment' },
  ppk: { label: 'PPK', icon: '👷', type: 'investment' },
  etf: { label: 'ETF / fundusze', icon: '📈', type: 'investment' },
  bonds: { label: 'Obligacje skarbowe', icon: '📜', type: 'investment' },
  crypto: { label: 'Kryptowaluty', icon: '🪙', type: 'investment' },
  gold: { label: 'Złoto', icon: '🥇', type: 'investment' },
  silver: { label: 'Srebro', icon: '🥈', type: 'investment' },
  other: { label: 'Inne', icon: '💰', type: 'investment' },
};

/** Grupa w zakładce Majątek. */
export function accountGroup(a) {
  if (a.type === 'loan') return 'loan';
  if (a.type === 'savings' || a.type === 'investment') return 'savings';
  return 'current';
}

export const BILL_ICONS = ['🏠', '💡', '🔥', '💧', '🗑️', '📱', '🌐', '📺', '🚗', '⛽', '🛡️', '🏦', '💳', '🎓', '🧸', '🏥', '🐶', '🏋️', '🎵', '📦'];

export const CURRENCIES = ['PLN', 'EUR', 'USD', 'GBP', 'CHF'];
