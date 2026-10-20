// Kwoty przechowujemy w groszach (liczby całkowite), żeby uniknąć błędów zaokrągleń.

/** Zamienia tekst ("1 234,56", "87.4", "250 zł") lub liczbę na grosze. Zwraca NaN przy błędzie. */
export function toMinor(input) {
  if (typeof input === 'number') {
    return Number.isFinite(input) ? Math.round(input * 100) : NaN;
  }
  let s = String(input ?? '').trim()
    .replace(/[\s  ]/g, '')
    .replace(/zł|zl|pln/gi, '');
  if (!s) return NaN;
  const lastComma = s.lastIndexOf(',');
  const lastDot = s.lastIndexOf('.');
  if (lastComma > -1 && lastDot > -1) {
    // oba separatory: ostatni jest dziesiętny
    s = lastComma > lastDot ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  } else {
    s = s.replace(',', '.');
  }
  if (!/^-?\d+(\.\d{1,2})?$/.test(s)) return NaN;
  const negative = s.startsWith('-');
  if (negative) s = s.slice(1);
  const [intPart, frac = ''] = s.split('.');
  const value = parseInt(intPart, 10) * 100 + parseInt((frac + '00').slice(0, 2), 10);
  return negative ? -value : value;
}

const formatters = {};
/** 874000 -> "8 740,00 zł" */
export function formatMoney(minor, currency = 'PLN', { sign = false } = {}) {
  if (!formatters[currency]) {
    formatters[currency] = new Intl.NumberFormat('pl-PL', {
      style: 'currency', currency, minimumFractionDigits: 2, maximumFractionDigits: 2,
    });
  }
  const text = formatters[currency].format((minor || 0) / 100);
  return sign && minor > 0 ? '+' + text : text;
}

/** Grosze -> tekst do pola formularza: 8740 -> "87,40" */
export function minorToInput(minor) {
  if (!Number.isFinite(minor)) return '';
  const neg = minor < 0;
  const abs = Math.abs(minor);
  return (neg ? '-' : '') + Math.floor(abs / 100) + ',' + String(abs % 100).padStart(2, '0');
}
