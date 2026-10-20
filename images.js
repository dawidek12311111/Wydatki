// Obrazki do kont, pozycji planu, zakupów i kategorii.
// Domyślnie zapisujemy MAŁĄ KOPIĘ w telefonie (data URL) — potem nic już nie jest pobierane z sieci.
// Bezpośrednie wyświetlanie z serwera tylko z listy darmowych serwerów i tylko po zgodzie użytkownika.

/** Serwery darmowych obrazków (wolne licencje), z których można pobrać wybrany obrazek. To samo jest w CSP w index.html. */
export const IMAGE_HOSTS = [
  'api.openverse.org', // Openverse — wyszukiwarka obrazów na licencjach Creative Commons
  'upload.wikimedia.org', // Wikimedia Commons
];

export const ICON_SIZE = 160; // px — wystarczy na ikonę, mało zajmuje

export function isAllowedImageUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && !u.username && !u.password
      && IMAGE_HOSTS.includes(u.hostname.toLowerCase());
  } catch {
    return false;
  }
}

const DATA_IMG = /^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/;
export const MAX_DATA_URL = 400_000; // ~300 KB

/** Zwraca obrazek, jeśli jest bezpieczny do zapisania/wyświetlenia, inaczej null. */
export function sanitizeImage(v) {
  if (typeof v !== 'string' || !v) return null;
  if (v.startsWith('data:')) return v.length <= MAX_DATA_URL && DATA_IMG.test(v) ? v : null;
  return isAllowedImageUrl(v) ? v : null;
}

export const isLocalImage = (v) => typeof v === 'string' && v.startsWith('data:');

/** „https://www.mBank.pl/xyz” → „mbank.pl”; zwraca null dla błędnej nazwy. */
export function normalizeDomain(input) {
  let s = String(input || '').trim().toLowerCase();
  if (!s) return null;
  s = s.replace(/^[a-z]+:\/\//, '').split(/[/?#]/)[0].replace(/^www\./, '').replace(/:\d+$/, '');
  return /^([a-z0-9-]+\.)+[a-z]{2,}$/.test(s) && !s.split('.').some((p) => p.startsWith('-') || p.endsWith('-')) ? s : null;
}


// ---------- w przeglądarce ----------

function loadImg(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Nie udało się odczytać obrazka (nieobsługiwany format?)'));
    img.src = src;
  });
}

/** Zmniejsza obrazek do kwadratu ICON_SIZE. fit: 'cover' (zdjęcia) albo 'contain' (logo). */
async function shrink(blob, fit) {
  if (!blob.type.startsWith('image/') && blob.type !== '' && !/octet-stream|icon/.test(blob.type)) {
    throw new Error('To nie jest obrazek');
  }
  const url = URL.createObjectURL(blob);
  try {
    const img = await loadImg(url);
    const w = img.naturalWidth || ICON_SIZE;
    const h = img.naturalHeight || ICON_SIZE;
    const canvas = document.createElement('canvas');
    canvas.width = ICON_SIZE;
    canvas.height = ICON_SIZE;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    const scale = fit === 'cover' ? Math.max(ICON_SIZE / w, ICON_SIZE / h) : Math.min(ICON_SIZE / w, ICON_SIZE / h);
    const dw = w * scale;
    const dh = h * scale;
    ctx.drawImage(img, (ICON_SIZE - dw) / 2, (ICON_SIZE - dh) / 2, dw, dh);
    let out = canvas.toDataURL('image/webp', 0.85);
    if (!out.startsWith('data:image/webp')) out = canvas.toDataURL('image/png');
    if (out.length > MAX_DATA_URL) out = canvas.toDataURL('image/jpeg', 0.8);
    return out;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Zdjęcie z telefonu (galeria / aparat) → mała kopia. Nic nie jest wysyłane do sieci. */
export async function imageFromFile(file) {
  if (!file) throw new Error('Nie wybrano pliku');
  if (file.size > 25 * 1024 * 1024) throw new Error('Plik jest za duży (maks. 25 MB)');
  return shrink(file, 'cover');
}

export class CorsBlockedError extends Error {}

/** Pobiera obrazek z darmowego serwera i zapisuje małą kopię. Rzuca CorsBlockedError, gdy serwer nie pozwala. */
export async function imageFromUrl(url, fit = 'contain') {
  if (!isAllowedImageUrl(url)) throw new Error('Ten adres nie jest na liście darmowych serwerów obrazków');
  if (!navigator.onLine) throw new Error('Brak internetu');
  let res;
  try {
    res = await fetch(url, { mode: 'cors', credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store' });
  } catch {
    throw new CorsBlockedError('Serwer nie pozwala zapisać kopii obrazka w aplikacji.');
  }
  if (!res.ok) throw new Error(res.status === 404 ? 'Nie znaleziono obrazka pod tym adresem' : `Serwer odpowiedział błędem ${res.status}`);
  const blob = await res.blob();
  if (blob.size > 10 * 1024 * 1024) throw new Error('Obrazek jest za duży');
  return shrink(blob, fit);
}

/** Popularne polskie słowa → angielskie (darmowe bazy obrazków mają dużo więcej opisów po angielsku). */
const PL_EN = {
  dom: 'house', mieszkanie: 'apartment', blok: 'apartment building', działka: 'land plot', dzialka: 'land plot', garaż: 'garage', garaz: 'garage',
  auto: 'car', samochód: 'car', samochod: 'car', rower: 'bicycle', motor: 'motorcycle', bank: 'bank', pieniądze: 'money', pieniadze: 'money',
  oszczędności: 'savings piggy bank', oszczednosci: 'savings piggy bank', skarbonka: 'piggy bank', lokata: 'savings', emerytura: 'retirement',
  złoto: 'gold', zloto: 'gold', srebro: 'silver', moneta: 'coin', monety: 'coins', sztabka: 'gold bar', biżuteria: 'jewelry', bizuteria: 'jewelry',
  wakacje: 'vacation beach', morze: 'sea', góry: 'mountains', gory: 'mountains', jedzenie: 'food', zakupy: 'shopping', sklep: 'shop',
  prąd: 'electricity', prad: 'electricity', woda: 'water', gaz: 'gas flame', internet: 'internet router', telefon: 'smartphone', telewizja: 'television',
  dziecko: 'child', dzieci: 'children', przedszkole: 'kindergarten', szkoła: 'school', szkola: 'school', pies: 'dog', kot: 'cat',
  czynsz: 'rent house', kredyt: 'loan', paliwo: 'fuel station', lekarz: 'doctor', apteka: 'pharmacy', sport: 'sport', siłownia: 'gym', silownia: 'gym',
  kino: 'cinema', książki: 'books', ksiazki: 'books', remont: 'renovation', kuchnia: 'kitchen', ogród: 'garden', ogrod: 'garden', fotowoltaika: 'solar panels',
  krypto: 'cryptocurrency', bitcoin: 'bitcoin', akcje: 'stock market', inwestycje: 'investment', praca: 'office work', wypłata: 'salary', wyplata: 'salary',
};
export function toEnglishQuery(q) {
  const words = String(q || '').toLowerCase().trim().split(/\s+/);
  const tr = words.map((w) => PL_EN[w] || null);
  return tr.some(Boolean) ? words.map((w, i) => tr[i] || w).join(' ') : null;
}

function withTimeout(promise, ms, label) {
  return Promise.race([promise, new Promise((_, rej) => setTimeout(() => rej(new Error(`${label}: brak odpowiedzi`)), ms))]);
}

async function searchCommons(q) {
  const url = `https://commons.wikimedia.org/w/api.php?action=query&format=json&origin=*&generator=search&gsrsearch=${encodeURIComponent(q)}%20filetype:bitmap&gsrnamespace=6&gsrlimit=24&prop=imageinfo&iiprop=url&iiurlwidth=256`;
  const r = await fetch(url, { credentials: 'omit' });
  if (!r.ok) throw new Error(`Wikimedia: błąd ${r.status}`);
  const j = await r.json();
  return Object.values(j?.query?.pages || {})
    .sort((a, b) => (a.index || 0) - (b.index || 0))
    .map((page) => ({ page, info: page.imageinfo?.[0] }))
    .filter(({ info }) => info?.thumburl && isAllowedImageUrl(info.thumburl))
    .map(({ page, info }) => ({ thumb: info.thumburl, title: (page.title || '').replace(/^File:|\.[a-z]+$/gi, ''), creator: '', license: 'Wikimedia Commons', source: 'Wikimedia' }));
}

async function searchOpenverse(q) {
  const r = await fetch(`https://api.openverse.org/v1/images/?q=${encodeURIComponent(q)}&page_size=18&mature=false`, { credentials: 'omit' });
  if (!r.ok) throw new Error(`Openverse: błąd ${r.status}`);
  const j = await r.json();
  return (j?.results || []).filter((x) => x.thumbnail && isAllowedImageUrl(x.thumbnail))
    .map((x) => ({ thumb: x.thumbnail, title: x.title || '', creator: x.creator || '', license: `${(x.license || '').toUpperCase()} ${x.license_version || ''}`.trim(), source: 'Openverse' }));
}

/**
 * Szukanie darmowych obrazków po tagu (Wikimedia Commons + Openverse; polskie słowa także po angielsku).
 * Wysyłane jest tylko wpisane słowo — żadne Twoje dane. Zwraca { results, problems }.
 */
export async function searchImages(query) {
  const q = String(query || '').trim();
  if (!q) throw new Error('Wpisz słowo, np. dom, auto, wakacje');
  if (!navigator.onLine) throw new Error('Brak internetu');
  const en = toEnglishQuery(q);
  const jobs = [['Wikimedia', () => searchCommons(q)], ['Openverse', () => searchOpenverse(q)]];
  if (en && en !== q.toLowerCase()) jobs.push(['Wikimedia (ang.)', () => searchCommons(en)], ['Openverse (ang.)', () => searchOpenverse(en)]);
  const settled = await Promise.allSettled(jobs.map(([label, fn]) => withTimeout(fn(), 9000, label)));
  const seen = new Set();
  const results = [];
  const problems = [];
  settled.forEach((r, i) => {
    if (r.status === 'rejected') {
      const m = String(r.reason?.message || '');
      problems.push(m.startsWith(jobs[i][0].split(' ')[0]) ? m : `${jobs[i][0]}: brak połączenia`);
      return;
    }
    for (const x of r.value) if (!seen.has(x.thumb)) { seen.add(x.thumb); results.push(x); }
  });
  if (!results.length) {
    throw new Error(problems.length === jobs.length
      ? `Nie udało się połączyć z wyszukiwarkami (${problems.join('; ')}). Sprawdź internet lub spróbuj za chwilę.`
      : 'Nic nie znaleziono — spróbuj innego słowa (np. po angielsku: house, car)');
  }
  return { results: results.slice(0, 36), problems };
}

/** Zmniejszona kopia obrazka z serwera przez <img crossorigin> (bez fetch) — działa, gdy serwer na to pozwala. */
export function imageViaCanvas(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.referrerPolicy = 'no-referrer';
    img.onload = () => {
      try {
        const c = document.createElement('canvas');
        c.width = ICON_SIZE; c.height = ICON_SIZE;
        const g = c.getContext('2d');
        const w = img.naturalWidth || ICON_SIZE; const h = img.naturalHeight || ICON_SIZE;
        const sc = Math.max(ICON_SIZE / w, ICON_SIZE / h);
        g.drawImage(img, (ICON_SIZE - w * sc) / 2, (ICON_SIZE - h * sc) / 2, w * sc, h * sc);
        let out = c.toDataURL('image/webp', 0.85);
        if (!out.startsWith('data:image/webp')) out = c.toDataURL('image/png');
        resolve(out);
      } catch (e) { reject(e); }
    };
    img.onerror = () => reject(new Error('Nie udało się wczytać obrazka'));
    img.src = url;
  });
}
