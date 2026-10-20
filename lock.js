// Blokada aplikacji: PIN (zapisany jako skrót PBKDF2, nigdy jako tekst) i opcjonalnie odcisk palca (WebAuthn).
// UWAGA: to blokada ekranu aplikacji w tym telefonie — dane w pamięci przeglądarki nie są przez nią szyfrowane.

const enc = new TextEncoder();
const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export const PIN_RE = /^\d{4,8}$/;
export const ITERATIONS = 150000;

export async function hashPin(pin, saltB64 = null, iterations = ITERATIONS) {
  if (!PIN_RE.test(pin)) throw new Error('PIN musi mieć od 4 do 8 cyfr');
  const salt = saltB64 ? unb64(saltB64) : crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey('raw', enc.encode(pin), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256);
  return { salt: b64(salt), hash: b64(bits), iterations };
}

export async function verifyPin(pin, record) {
  if (!record || !PIN_RE.test(String(pin))) return false;
  const h = await hashPin(String(pin), record.salt, record.iterations || ITERATIONS);
  // porównanie stałoczasowe
  const a = unb64(h.hash); const b = unb64(record.hash);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/** Ile sekund czekać po kolejnych błędnych próbach (5 prób bez czekania). */
export function lockoutSeconds(failed) {
  if (failed < 5) return 0;
  return Math.min(300, 30 * 2 ** Math.floor((failed - 5) / 3));
}

// ---------- odcisk palca / rozpoznawanie twarzy (WebAuthn, tylko na tym urządzeniu) ----------

export async function biometricAvailable() {
  try {
    return !!(window.PublicKeyCredential && await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable());
  } catch {
    return false;
  }
}

export async function registerBiometric(displayName = 'Smart Finance') {
  const cred = await navigator.credentials.create({
    publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      rp: { name: 'Smart Finance' },
      user: { id: crypto.getRandomValues(new Uint8Array(16)), name: displayName, displayName },
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
      authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required', residentKey: 'discouraged' },
      timeout: 60000,
      attestation: 'none',
    },
  });
  if (!cred) throw new Error('Nie udało się dodać odcisku palca');
  return b64(cred.rawId);
}

export async function verifyBiometric(credId) {
  const res = await navigator.credentials.get({
    publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      allowCredentials: [{ type: 'public-key', id: unb64(credId), transports: ['internal'] }],
      userVerification: 'required',
      timeout: 60000,
    },
  });
  return !!res;
}
