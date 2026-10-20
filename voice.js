// Dyktowanie głosem (Web Speech API w Chrome / Edge na Androidzie).
// Uwaga: rozpoznawanie mowy wykonuje przeglądarka — w Chrome nagranie jest przetwarzane przez serwery Google.

const Recognition = typeof window !== 'undefined' ? (window.SpeechRecognition || window.webkitSpeechRecognition) : null;

export const speechSupported = () => !!Recognition;

/** Słucha jednej wypowiedzi. onPartial(tekst) — podgląd na żywo. Zwraca Promise z tekstem. */
export function listen({ lang = 'pl-PL', onPartial = () => {}, timeoutMs = 12000 } = {}) {
  return new Promise((resolve, reject) => {
    if (!Recognition) { reject(new Error('Ta przeglądarka nie obsługuje dyktowania. Użyj Chrome lub Edge.')); return; }
    const rec = new Recognition();
    rec.lang = lang;
    rec.interimResults = true;
    rec.maxAlternatives = 1;
    rec.continuous = false;
    let finalText = '';
    let done = false;
    const finish = (fn) => { if (!done) { done = true; clearTimeout(timer); fn(); } };
    const timer = setTimeout(() => { try { rec.stop(); } catch { /* już zatrzymane */ } }, timeoutMs);
    rec.onresult = (e) => {
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const t = e.results[i][0].transcript;
        if (e.results[i].isFinal) finalText += t; else interim += t;
      }
      onPartial((finalText + ' ' + interim).trim());
    };
    rec.onerror = (e) => finish(() => reject(new Error({
      'not-allowed': 'Brak zgody na mikrofon. Zezwól w ustawieniach przeglądarki.',
      'service-not-allowed': 'Brak zgody na mikrofon. Zezwól w ustawieniach przeglądarki.',
      'no-speech': 'Nic nie usłyszałem — spróbuj jeszcze raz.',
      network: 'Rozpoznawanie mowy wymaga internetu.',
      'audio-capture': 'Nie znaleziono mikrofonu.',
    }[e.error] || `Błąd rozpoznawania mowy (${e.error})`)));
    rec.onend = () => finish(() => (finalText.trim() ? resolve(finalText.trim()) : reject(new Error('Nic nie usłyszałem — spróbuj jeszcze raz.'))));
    try { rec.start(); } catch (err) { finish(() => reject(err)); }
  });
}
