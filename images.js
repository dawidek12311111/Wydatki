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

/**
 * Szukanie darmowych obrazków po tagu (Openverse + Wikimedia Commons).
 * Wysyłane jest tylko wpisane słowo — żadne Twoje dane.
 * Zwraca [{ thumb, title, creator, license, source }].
 */
export async function searchImages(query) {
  const q = String(query || '').trim();
  if (!q) throw new Error('Wpisz słowo, np. dom, auto, wakacje');
  if (!navigator.onLine) throw new Error('Brak internetu');
  const enc = encodeURIComponent(q);
  const opts = { credentials: 'omit', referrerPolicy: 'no-referrer' };
  const out = [];
  const tasks = [
    fetch(`https://api.openverse.org/v1/images/?q=${enc}&page_size=18&mature=false`, opts)
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        for (const x of j?.results || []) {
          if (x.thumbnail && isAllowedImageUrl(x.thumbnail)) out.push({ thumb: x.thumbnail, title: x.title || '', creator: x.creator || '', license: `${(x.license || '').toUpperCase()} ${x.license_version || ''}`.trim(), source: 'Openverse' });
        }
      }).catch(() => {}),
    fetch(`https://commons.wikimedia.org/w/api.php?action=query&format=json&origin=*&generator=search&gsrsearch=${enc}%20filetype:bitmap&gsrnamespace=6&gsrlimit=18&prop=imageinfo&iiprop=url&iiurlwidth=256`, opts)
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        for (const page of Object.values(j?.query?.pages || {})) {
          const info = page.imageinfo?.[0];
          if (info?.thumburl && isAllowedImageUrl(info.thumburl)) out.push({ thumb: info.thumburl, title: (page.title || '').replace(/^File:|\.[a-z]+$/gi, ''), creator: '', license: 'Wikimedia Commons', source: 'Wikimedia' });
        }
      }).catch(() => {}),
  ];
  await Promise.all(tasks);
  if (!out.length) throw new Error('Nic nie znaleziono — spróbuj innego słowa (także po angielsku, np. house, car)');
  return out.slice(0, 30);
}
