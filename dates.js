// Daty jako tekst "RRRR-MM-DD" w czasie lokalnym — bez przesunięć strefy czasowej.

export const pad = (n) => String(n).padStart(2, '0');

export function todayISO(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function addDays(iso, n) {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(y, m - 1, d + n, 12); // południe — odporne na zmianę czasu
  return todayISO(dt);
}

export const monthKey = (iso) => iso.slice(0, 7);

export function addMonths(ym, n) {
  let [y, m] = ym.split('-').map(Number);
  const idx = y * 12 + (m - 1) + n;
  y = Math.floor(idx / 12);
  m = idx - y * 12 + 1;
  return `${y}-${pad(m)}`;
}

export function isValidISODate(iso) {
  if (typeof iso !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return false;
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d;
}

export function formatDatePL(iso) {
  const [y, m, d] = iso.split('-');
  return `${d}.${m}.${y}`;
}

const MONTHS = ['styczeń', 'luty', 'marzec', 'kwiecień', 'maj', 'czerwiec', 'lipiec',
  'sierpień', 'wrzesień', 'październik', 'listopad', 'grudzień'];
const MONTHS_SHORT = ['sty', 'lut', 'mar', 'kwi', 'maj', 'cze', 'lip', 'sie', 'wrz', 'paź', 'lis', 'gru'];

export function monthNamePL(ym) {
  const [y, m] = ym.split('-').map(Number);
  const name = MONTHS[m - 1];
  return name.charAt(0).toUpperCase() + name.slice(1) + ' ' + y;
}
export const monthShortPL = (ym) => MONTHS_SHORT[Number(ym.slice(5, 7)) - 1];

const WEEKDAYS = ['niedziela', 'poniedziałek', 'wtorek', 'środa', 'czwartek', 'piątek', 'sobota'];
export function dayLabelPL(iso, today = todayISO()) {
  if (iso === today) return 'Dzisiaj';
  if (iso === addDays(today, -1)) return 'Wczoraj';
  const [y, m, d] = iso.split('-').map(Number);
  const wd = WEEKDAYS[new Date(y, m - 1, d).getDay()];
  return `${wd.charAt(0).toUpperCase() + wd.slice(1)}, ${formatDatePL(iso)}`;
}

export function daysInMonth(ym) {
  const [y, m] = ym.split('-').map(Number);
  return new Date(y, m, 0).getDate();
}

/** Dzień miesiąca jako data ISO, przycięty do długości miesiąca (31 → 28/29/30). */
export function dateInMonth(ym, day) {
  const d = Math.min(Math.max(1, Number(day) || 1), daysInMonth(ym));
  return `${ym}-${pad(d)}`;
}

export const WEEKDAYS_SHORT = ['pn', 'wt', 'śr', 'cz', 'pt', 'so', 'nd'];
