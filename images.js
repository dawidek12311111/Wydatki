// Obrazki do kont, pozycji planu, zakupów i kategorii.
// Domyślnie zapisujemy MAŁĄ KOPIĘ w telefonie (data URL) — potem nic już nie jest pobierane z sieci.
// Bezpośrednie wyświetlanie z serwera tylko z listy darmowych serwerów i tylko po zgodzie użytkownika.

/** Darmowe serwery obrazków, z których aplikacja może pobrać obrazek (to samo jest w CSP w index.html). */
export const IMAGE_HOSTS = [
  'icons.duckduckgo.com', // logo firm po nazwie domeny
  'upload.wikimedia.org', // Wikipedia / Wikimedia Commons
  'images.unsplash.com', // Unsplash
  'cdn.pixabay.com', // Pixabay
  'images.pexels.com', // Pexels
  'i.imgur.com', // Imgur
  'cdn.jsdelivr.net', // m.in. darmowe zestawy ikon i logo (simple-icons)
  'raw.githubusercontent.com', // Twoje pliki na GitHubie
];
const GITHUB_PAGES = /\.github\.io$/i;

export const ICON_SIZE = 160; // px — wystarczy na ikonę, mało zajmuje

export function isAllowedImageUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && !u.username && !u.password
      && (IMAGE_HOSTS.includes(u.hostname.toLowerCase()) || GITHUB_PAGES.test(u.hostname));
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

export function logoUrl(domain) {
  const d = normalizeDomain(domain);
  return d ? `https://icons.duckduckgo.com/ip3/${d}.ico` : null;
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
