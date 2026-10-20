// Układ strony startowej i ustawienia wyglądu — czyste funkcje (testowane w tests/).

export const DASH_CARDS = {
  balance: { label: 'Bilans miesiąca', icon: '📊' },
  quick: { label: 'Szybkie dodawanie', icon: '⚡' },
  bills: { label: 'Plan miesiąca', icon: '🗓️' },
  networth: { label: 'Majątek netto', icon: '🏛️' },
  savings: { label: 'Oszczędności i inwestycje', icon: '🐷' },
  loans: { label: 'Kredyty', icon: '📉' },
  categories: { label: 'Na co poszło', icon: '🍰' },
  recent: { label: 'Ostatnie transakcje', icon: '🧾' },
  purchases: { label: 'Do kupienia', icon: '🛒' },
  metals: { label: 'Złoto i srebro', icon: '🥇' },
  nwchart: { label: 'Majątek w czasie (wykres)', icon: '📈' },
  pulse: { label: 'Puls finansowy i poduszka', icon: '❤️' },
  allowance: { label: 'Ile mogę dziś wydać + prognoza', icon: '💸' },
  piggy: { label: 'Skarbonka', icon: '🐷' },
  envelopes: { label: 'Koperty', icon: '✉️' },
};

export const DEFAULT_LAYOUT = [
  { id: 'allowance', visible: true },
  { id: 'balance', visible: true },
  { id: 'pulse', visible: true },
  { id: 'bills', visible: true },
  { id: 'networth', visible: true },
  { id: 'categories', visible: true },
  { id: 'recent', visible: true },
  { id: 'quick', visible: false },
  { id: 'savings', visible: false },
  { id: 'loans', visible: false },
  { id: 'purchases', visible: false },
  { id: 'metals', visible: false },
  { id: 'nwchart', visible: false },
  { id: 'piggy', visible: false },
  { id: 'envelopes', visible: false },
];

/** Naprawia zapisany układ: usuwa nieznane/zdublowane karty, dopisuje nowe na końcu. */
export function normalizeLayout(saved) {
  const out = [];
  const seen = new Set();
  for (const x of Array.isArray(saved) ? saved : []) {
    if (!x || !DASH_CARDS[x.id] || seen.has(x.id)) continue;
    seen.add(x.id);
    out.push({ id: x.id, visible: x.visible !== false });
  }
  for (const d of DEFAULT_LAYOUT) if (!seen.has(d.id)) out.push({ ...d });
  return out;
}

/**
 * Przesuwa kartę o jedną pozycję (dir = -1 wyżej, +1 niżej).
 * visibleOnly: zamienia z najbliższą WIDOCZNĄ kartą (tak jak użytkownik widzi stronę).
 */
export function moveCard(layout, id, dir, { visibleOnly = false } = {}) {
  const list = layout.map((x) => ({ ...x }));
  const i = list.findIndex((x) => x.id === id);
  if (i < 0) return list;
  let j = i + dir;
  if (visibleOnly) while (j >= 0 && j < list.length && !list[j].visible) j += dir;
  if (j < 0 || j >= list.length) return list;
  [list[i], list[j]] = [list[j], list[i]];
  return list;
}

export function setCardVisible(layout, id, visible) {
  return layout.map((x) => (x.id === id ? { ...x, visible } : { ...x }));
}

export const visibleCards = (layout) => layout.filter((x) => x.visible).map((x) => x.id);

/** Kolory aplikacji: light = [akcent, tło akcentu], dark = [akcent, tło akcentu, tekst na akcencie]. */
export const ACCENTS = {
  teal: { label: 'Morski', light: ['#0f766e', '#d6efec'], dark: ['#2bb3a3', '#123b36', '#062320'] },
  blue: { label: 'Niebieski', light: ['#1d4ed8', '#dce6fb'], dark: ['#6b9cff', '#172a4f', '#06122b'] },
  violet: { label: 'Fioletowy', light: ['#6d28d9', '#ebe2fb'], dark: ['#a98bfa', '#2a1f4a', '#160b2e'] },
  pink: { label: 'Różowy', light: ['#be185d', '#fbe1ec'], dark: ['#f27aae', '#45182c', '#2a0716'] },
  red: { label: 'Czerwony', light: ['#b91c1c', '#fbe0e0'], dark: ['#f87171', '#46191a', '#2a0606'] },
  orange: { label: 'Pomarańczowy', light: ['#c2410c', '#fde5d6'], dark: ['#fb923c', '#47240f', '#2a1204'] },
  green: { label: 'Zielony', light: ['#15803d', '#dcf3e3'], dark: ['#4ade80', '#153a23', '#052e14'] },
  graphite: { label: 'Grafitowy', light: ['#374151', '#e5e7eb'], dark: ['#cbd5e1', '#2a313b', '#0f141b'] },
};

export const TEXT_SIZES = { normal: 'Normalny', large: 'Duży', xlarge: 'Bardzo duży' };
