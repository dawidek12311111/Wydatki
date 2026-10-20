// Ikony generowane w aplikacji (bez internetu): plakietka w kolorze marki albo inicjały.
// Nie kopiujemy prawdziwych logo (znaki towarowe) — tylko kolor i skrót nazwy.

/** Znane banki, sklepy i firmy w Polsce: wzorzec nazwy, skrót, tło, kolor tekstu. */
export const BRANDS = [
  [/\bpko\b|pko ?bp|ipko/i, 'PKO', '#0a2a66', '#ffffff'],
  [/\bmbank\b|\bm ?bank\b/i, 'm', '#e3051b', '#ffffff'],
  [/\bing\b/i, 'ING', '#ff6200', '#ffffff'],
  [/santander/i, 'S', '#ec0000', '#ffffff'],
  [/pekao/i, 'P', '#c8102e', '#ffffff'],
  [/millennium/i, 'M', '#a3005b', '#ffffff'],
  [/alior/i, 'A', '#7c1c3d', '#ffffff'],
  [/bnp|paribas/i, 'BNP', '#00915a', '#ffffff'],
  [/credit ?agricole/i, 'CA', '#00848a', '#ffffff'],
  [/revolut/i, 'R', '#191c1f', '#ffffff'],
  [/\bxtb\b/i, 'XTB', '#0b0b0b', '#ffffff'],
  [/velo ?bank/i, 'V', '#4a2a8a', '#ffffff'],
  [/inteligo/i, 'i', '#009ad8', '#ffffff'],
  [/nest ?bank/i, 'N', '#1d3f72', '#ffffff'],
  [/citi/i, 'citi', '#056dae', '#ffffff'],
  [/pocztowy/i, 'BP', '#e30613', '#ffd200'],
  [/toyota/i, 'T', '#cc0000', '#ffffff'],
  [/\bbos\b/i, 'BOŚ', '#007a3d', '#ffffff'],
  [/getin/i, 'G', '#f39200', '#ffffff'],
  [/paypal/i, 'PP', '#003087', '#ffffff'],
  [/allegro/i, 'a', '#ff5a00', '#ffffff'],
  [/orlen/i, 'O', '#e2001a', '#ffffff'],
  [/\bbp\b/i, 'bp', '#009b3a', '#ffe600'],
  [/shell/i, 'S', '#fbce07', '#dd1d21'],
  [/circle ?k/i, 'K', '#ee2e24', '#ffffff'],
  [/biedronka/i, 'B', '#e2001a', '#ffd200'],
  [/lidl/i, 'L', '#0050aa', '#fff000'],
  [/[żz]abka/i, 'Ż', '#00843d', '#ffffff'],
  [/kaufland/i, 'K', '#e10915', '#ffffff'],
  [/auchan/i, 'A', '#e2001a', '#ffffff'],
  [/carrefour/i, 'C', '#004e9f', '#ffffff'],
  [/\bdino\b/i, 'D', '#e30613', '#ffffff'],
  [/rossmann/i, 'R', '#c5003e', '#ffffff'],
  [/ikea/i, 'IK', '#0058a3', '#ffdb00'],
  [/media ?expert/i, 'ME', '#ffd400', '#1a1a1a'],
  [/netflix/i, 'N', '#000000', '#e50914'],
  [/spotify/i, 'S', '#1db954', '#000000'],
  [/youtube/i, '▶', '#ff0000', '#ffffff'],
  [/disney/i, 'D+', '#0b1c4d', '#ffffff'],
  [/\bmax\b|hbo/i, 'max', '#002be7', '#ffffff'],
  [/orange/i, 'O', '#ff7900', '#000000'],
  [/\bplay\b/i, 'P', '#5f259f', '#ffffff'],
  [/t-?mobile/i, 'T', '#e20074', '#ffffff'],
  [/\bplus\b/i, '+', '#00a650', '#ffffff'],
  [/\bpge\b/i, 'PGE', '#00589c', '#ffffff'],
  [/tauron/i, 'T', '#e2007a', '#ffffff'],
  [/enea/i, 'E', '#00a3e0', '#ffffff'],
  [/energa/i, 'E', '#00a19a', '#ffffff'],
  [/pgnig|gazownia|gaz /i, 'G', '#0066b3', '#ffffff'],
  [/\bzus\b/i, 'ZUS', '#007a3e', '#ffffff'],
  [/\bpzu\b/i, 'PZU', '#003e7e', '#ffffff'],
  [/allianz/i, 'A', '#003781', '#ffffff'],
  [/warta/i, 'W', '#00559b', '#ffffff'],
  [/uber/i, 'U', '#000000', '#ffffff'],
  [/\bbolt\b/i, 'B', '#34d186', '#000000'],
  [/amazon/i, 'a', '#232f3e', '#ff9900'],
  [/apple|icloud/i, '', '#000000', '#ffffff'],
  [/google/i, 'G', '#4285f4', '#ffffff'],
  [/olx/i, 'OLX', '#002f34', '#23e5db'],
  [/vinted/i, 'V', '#007782', '#ffffff'],
  [/\bpkp\b|intercity/i, 'PKP', '#003a7d', '#ffffff'],
  [/upc|vectra|netia/i, 'TV', '#1d3557', '#ffffff'],
];

export function brandOf(name) {
  const s = String(name || '');
  for (const [re, short, bg, fg] of BRANDS) if (re.test(s)) return { short, bg, fg };
  return null;
}

/** Stały kolor wyliczony z nazwy (ten sam tekst = zawsze ten sam kolor). */
export function hashHue(text) {
  let h = 2166136261;
  for (const ch of String(text || '').toLowerCase()) { h ^= ch.codePointAt(0); h = Math.imul(h, 16777619); }
  return Math.abs(h) % 360;
}

const STOP = new Set(['konto', 'rachunek', 'karta', 'lokata', 'moje', 'mój', 'moja', 'na', 'w', 'i', 'z', 'do', 'oraz', 'osobiste', 'osobisty', 'bank']);

/** Inicjały: „Konto Ani” → „A”, „Oszczędności wakacje” → „OW”, „IKE XTB” → „IX”. */
export function initials(name) {
  const words = String(name || '').trim().split(/[\s\-_/.,]+/).filter(Boolean);
  const useful = words.filter((w) => !STOP.has(w.toLowerCase()));
  const list = useful.length ? useful : words;
  if (!list.length) return '?';
  const first = [...list[0]][0] || '?';
  const second = list.length > 1 ? [...list[1]][0] : '';
  return (first + second).toUpperCase();
}

/** Ikony rodzajów (dla kont bez marki): emoji na kolorowym tle. */
export const TYPE_ICONS = {
  flat: '🏢', house: '🏠', land: '🌳', garage: '🅿️', car: '🚗', property_other: '📦',
  gold: '🥇', silver: '🥈', ike: '🏛️', ikze: '🧾', ppk: '👷', etf: '📈', bonds: '📜', crypto: '🪙', deposit: '🐷',
  cash: '💵', loan: '📉',
};

/**
 * Opis plakietki do narysowania: { text, bg, fg, emoji? }.
 * Kolejność: marka z nazwy → ikona rodzaju (nieruchomość, metal, gotówka…) → inicjały w kolorze z nazwy.
 */
export function badgeFor(name, kind = null) {
  const brand = brandOf(name);
  if (brand) return { text: brand.short || initials(name), bg: brand.bg, fg: brand.fg };
  const hue = hashHue(name);
  if (kind && TYPE_ICONS[kind]) return { emoji: TYPE_ICONS[kind], bg: `hsl(${hue} 55% 88%)`, bg2: `hsl(${hue} 45% 26%)` };
  return { text: initials(name), bg: `hsl(${hue} 52% 42%)`, fg: '#ffffff' };
}
