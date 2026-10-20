// „Film o majątku” — 30 sekund animacji (canvas) z muzyką i efektami (Web Audio), opcjonalnie lektor.
// Wszystko powstaje w telefonie z Twoich danych — nic nie jest wysyłane do sieci.

export const DURATION = 30;
const SCENES = [[0, 3], [3, 9], [9, 16], [16, 22], [22, 28], [28, 30]];

const ease = (t) => (t < 0 ? 0 : t > 1 ? 1 : 1 - (1 - t) ** 3);
const seg = (t, a, b) => Math.min(1, Math.max(0, (t - a) / (b - a)));

/** Która scena trwa w sekundzie t (0..5). */
export function sceneAt(t) {
  for (let i = 0; i < SCENES.length; i++) if (t < SCENES[i][1]) return i;
  return SCENES.length - 1;
}

// ---------- dźwięk ----------
function makeAudio() {
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return null;
  const ctx = new AC();
  const master = ctx.createGain();
  master.gain.value = 0.5;
  master.connect(ctx.destination);
  const tone = (freq, at, dur, { type = 'sine', vol = 0.15, attack = 0.02 } = {}) => {
    const o = ctx.createOscillator(); const g = ctx.createGain();
    o.type = type; o.frequency.value = freq;
    const t0 = ctx.currentTime + at;
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(vol, t0 + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g); g.connect(master);
    o.start(t0); o.stop(t0 + dur + 0.05);
  };
  // podkład: akordy C–G–Am–F, 4 s każdy, z delikatnym pulsem
  const chords = [[261.6, 329.6, 392], [196, 246.9, 392], [220, 261.6, 329.6], [174.6, 220, 349.2]];
  const music = (from) => {
    for (let bar = 0; bar < 8; bar++) {
      const at = bar * 4 - from;
      if (at + 4 < 0) continue;
      const ch = chords[bar % 4];
      for (const f of ch) tone(f, Math.max(0, at), 3.9, { type: 'triangle', vol: 0.05, attack: 0.4 });
      for (let beat = 0; beat < 8; beat++) {
        const bt = at + beat * 0.5;
        if (bt >= 0 && bar * 4 + beat * 0.5 < DURATION - 1) tone(ch[0] / 2, bt, 0.25, { type: 'sine', vol: 0.07 });
      }
    }
  };
  return {
    ctx, master,
    start(from = 0) { music(from); },
    tick() { tone(1400 + Math.random() * 300, 0, 0.05, { type: 'square', vol: 0.025, attack: 0.002 }); },
    ding() { tone(1046.5, 0, 0.9, { vol: 0.12 }); tone(1568, 0.08, 0.9, { vol: 0.08 }); },
    whoosh() { tone(220, 0, 0.5, { type: 'sawtooth', vol: 0.03, attack: 0.2 }); },
    mute(m) { master.gain.value = m ? 0 : 0.5; },
    close() { try { ctx.close(); } catch { /* już zamknięty */ } },
  };
}

/**
 * Odtwarza film. data: { title, net, parts[{label,value,color}], history[{label,net}], m1, savingsRate,
 *   topCategory, rising, future[{label,net}], futureYears, futureNet, payoffText, outro, fmt(v) }
 * opts: { voice, onClose }
 */
export function playFilm(root, data, opts = {}) {
  root.innerHTML = `<div class="film">
    <canvas class="film-cv"></canvas>
    <div class="film-bar">
      <button data-f="play" aria-label="Pauza">⏸</button>
      <div class="film-prog"><i></i></div>
      <button data-f="mute" aria-label="Wycisz">🔊</button>
      <button data-f="close" aria-label="Zamknij">✕</button>
    </div>
    <button class="film-replay" data-f="replay" hidden>↻ Odtwórz ponownie</button>
  </div>`;
  const wrap = root.firstElementChild;
  const cv = wrap.querySelector('canvas');
  const g = cv.getContext('2d');
  const css = getComputedStyle(document.documentElement);
  const C = {
    bg1: css.getPropertyValue('--accent').trim() || '#0f766e', ink: '#ffffff',
    soft: 'rgba(255,255,255,.75)', faint: 'rgba(255,255,255,.18)', pos: '#7CF0B4', neg: '#FF9C8F', gold: '#FFD54A',
  };
  let W = 0; let H = 0; let dpr = 1;
  const resize = () => {
    dpr = Math.min(2, window.devicePixelRatio || 1);
    W = wrap.clientWidth; H = wrap.clientHeight;
    cv.width = W * dpr; cv.height = H * dpr; cv.style.width = W + 'px'; cv.style.height = H + 'px';
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
  };
  resize();
  window.addEventListener('resize', resize);

  let audio = null; let muted = false;
  try { audio = makeAudio(); } catch { audio = null; }
  let t = 0; let playing = true; let last = performance.now(); let raf = 0; let lastScene = -1; let lastTick = 0;
  const say = (text) => {
    if (!opts.voice || muted || !window.speechSynthesis) return;
    try { const u = new SpeechSynthesisUtterance(text); u.lang = 'pl-PL'; u.rate = 1.1; speechSynthesis.cancel(); speechSynthesis.speak(u); } catch { /* brak syntezatora */ }
  };
  const voiceLines = [
    data.title,
    `Twój majątek netto to ${data.fmtSpeak(data.net)}.`,
    data.m1 != null ? `W tym miesiącu ${data.m1 >= 0 ? 'wzrósł' : 'spadł'} o ${data.fmtSpeak(Math.abs(data.m1))}.` : 'Tak wyglądała droga do dziś.',
    data.savingsRate != null ? `Odkładasz średnio ${Math.round(data.savingsRate * 100)} procent dochodu.` : 'Oto analiza wydatków.',
    `Za ${data.futureYears} lat to może być około ${data.fmtSpeak(data.futureNet)}.`,
    data.outro,
  ];

  const font = (px, w = 700) => { g.font = `${w} ${px}px system-ui, -apple-system, Roboto, sans-serif`; };
  const text = (s, x, y, px, { w = 700, color = C.ink, align = 'center', alpha = 1 } = {}) => {
    font(px, w); g.globalAlpha = alpha; g.fillStyle = color; g.textAlign = align; g.textBaseline = 'middle'; g.fillText(s, x, y); g.globalAlpha = 1;
  };
  const fit = (s, px, maxW, w = 700) => { font(px, w); let p = px; while (p > 12 && g.measureText(s).width > maxW) { p -= 1; font(p, w); } return p; };
  const line = (vals, x0, y0, w, h, prog, color, { dash = false } = {}) => {
    if (vals.length < 2) return;
    const min = Math.min(0, ...vals); const max = Math.max(...vals, 1);
    const n = vals.length; const upto = Math.max(1, prog * (n - 1));
    g.beginPath();
    for (let i = 0; i <= Math.floor(upto); i++) {
      const x = x0 + (w * i) / (n - 1); const y = y0 + h - ((vals[i] - min) / (max - min || 1)) * h;
      i ? g.lineTo(x, y) : g.moveTo(x, y);
    }
    const fr = upto - Math.floor(upto); const i0 = Math.floor(upto);
    if (fr > 0 && i0 + 1 < n) {
      const xa = x0 + (w * i0) / (n - 1); const xb = x0 + (w * (i0 + 1)) / (n - 1);
      const ya = y0 + h - ((vals[i0] - min) / (max - min || 1)) * h; const yb = y0 + h - ((vals[i0 + 1] - min) / (max - min || 1)) * h;
      g.lineTo(xa + (xb - xa) * fr, ya + (yb - ya) * fr);
    }
    g.setLineDash(dash ? [8, 6] : []); g.strokeStyle = color; g.lineWidth = 4; g.lineJoin = 'round'; g.lineCap = 'round'; g.stroke(); g.setLineDash([]);
    return { min, max };
  };

  const draw = () => {
    const sc = sceneAt(t);
    if (sc !== lastScene) {
      lastScene = sc;
      if (audio && !muted) (sc === 4 || sc === 5 ? audio.ding() : audio.whoosh());
      say(voiceLines[sc]);
    }
    // tło
    const grd = g.createLinearGradient(0, 0, W, H);
    grd.addColorStop(0, C.bg1); grd.addColorStop(1, '#0b1412');
    g.fillStyle = grd; g.fillRect(0, 0, W, H);
    // pływające monety w tle
    for (let i = 0; i < 9; i++) {
      const x = ((i * 97 + t * 18 * (1 + (i % 3))) % (W + 40)) - 20;
      const y = H - ((i * 131 + t * 40 * (1 + (i % 2))) % (H + 40));
      g.globalAlpha = 0.08; g.fillStyle = C.gold; g.beginPath(); g.arc(x, y, 6 + (i % 4) * 3, 0, Math.PI * 2); g.fill(); g.globalAlpha = 1;
    }
    const cx = W / 2; const pad = 24; const cw = W - pad * 2;
    if (sc === 0) {
      const p = seg(t, 0, 3);
      for (let i = 0; i < 4; i++) {
        const bh = (40 + i * 30) * ease(seg(t, 0.2 + i * 0.25, 1 + i * 0.25));
        g.fillStyle = `rgba(255,255,255,${0.5 + i * 0.15})`;
        g.fillRect(cx - 90 + i * 48, H * 0.45 - bh, 36, bh);
      }
      text(data.title, cx, H * 0.58, fit(data.title, 30, cw), { alpha: ease(seg(t, 0.8, 1.6)) });
      text(data.subtitle, cx, H * 0.58 + 36, 17, { w: 500, color: C.soft, alpha: ease(seg(t, 1.2, 2)) });
      text('🎬', cx, H * 0.2, 40, { alpha: 1 - p * 0.3 });
    } else if (sc === 1) {
      const p = ease(seg(t, 3, 6));
      const val = Math.round(data.net * p);
      if (audio && !muted && p < 1 && t - lastTick > 0.07) { audio.tick(); lastTick = t; }
      text(data.netLabel || 'Majątek netto', cx, H * 0.16, 18, { w: 600, color: C.soft });
      const s = data.fmt(val);
      text(s, cx, H * 0.24, fit(s, 44, cw), { color: val < 0 ? C.neg : C.ink });
      const parts = data.parts.filter((x) => x.value !== 0);
      const max = Math.max(...parts.map((x) => Math.abs(x.value)), 1);
      parts.forEach((x, i) => {
        const a = ease(seg(t, 4.5 + i * 0.5, 5.5 + i * 0.5));
        const y = H * 0.36 + i * 54;
        text(x.label, pad, y, 15, { w: 600, align: 'left', alpha: a });
        text(data.fmt(x.value), W - pad, y, 15, { w: 700, align: 'right', alpha: a, color: x.value < 0 ? C.neg : C.ink });
        g.globalAlpha = a; g.fillStyle = C.faint; g.fillRect(pad, y + 14, cw, 10);
        g.fillStyle = x.value < 0 ? C.neg : x.color || C.gold; g.fillRect(pad, y + 14, (cw * Math.abs(x.value) / max) * a, 10); g.globalAlpha = 1;
      });
    } else if (sc === 2) {
      const p = ease(seg(t, 9, 14.5));
      text(data.historyLabel || 'Droga do dziś', cx, H * 0.14, 22);
      const vals = data.history.map((h) => h.net);
      const box = { x: pad, y: H * 0.25, w: cw, h: H * 0.42 };
      g.strokeStyle = C.faint; g.lineWidth = 1; g.strokeRect(box.x, box.y, box.w, box.h);
      if (vals.length > 1) line(vals, box.x + 8, box.y + 8, box.w - 16, box.h - 16, p, C.ink);
      else text('Historia pojawi się za miesiąc 🙂', cx, box.y + box.h / 2, 16, { w: 500, color: C.soft });
      if (data.history.length) {
        text(data.history[0].label, box.x, box.y + box.h + 18, 13, { w: 500, color: C.soft, align: 'left' });
        text(data.history[data.history.length - 1].label, box.x + box.w, box.y + box.h + 18, 13, { w: 500, color: C.soft, align: 'right' });
      }
      if (data.m1 != null) {
        const a = ease(seg(t, 14, 15));
        const s = `${data.m1 >= 0 ? '+' : '−'}${data.fmt(Math.abs(data.m1))} ${data.m1Label || 'w tym miesiącu'}`;
        text(s, cx, H * 0.8, fit(s, 22, cw), { alpha: a, color: data.m1 >= 0 ? C.pos : C.neg });
      }
    } else if (sc === 3) {
      text(data.analysisLabel || 'Analiza', cx, H * 0.14, 22);
      const items = [
        data.savingsRate != null ? ['💰', 'Odkładasz z dochodu', `${Math.round(data.savingsRate * 100)}%`] : null,
        data.topCategory ? ['🛒', 'Najwięcej wydajesz na', data.topCategory] : null,
        data.rising ? ['📈', data.risingLabel || 'Najbardziej wzrosło', data.rising] : null,
        data.extra || null,
        data.avgGrowth != null ? ['📊', 'Średnio miesięcznie', `${data.avgGrowth >= 0 ? '+' : '−'}${data.fmt(Math.abs(data.avgGrowth))}`] : null,
      ].filter(Boolean).slice(0, 4);
      items.forEach(([ic, label, val], i) => {
        const a = ease(seg(t, 16.3 + i * 0.9, 17.1 + i * 0.9));
        const y = H * 0.27 + i * 92 + (1 - a) * 30;
        g.globalAlpha = a; g.fillStyle = 'rgba(255,255,255,.1)';
        g.beginPath(); g.roundRect ? g.roundRect(pad, y - 34, cw, 72, 16) : g.rect(pad, y - 34, cw, 72); g.fill(); g.globalAlpha = 1;
        text(ic, pad + 30, y, 26, { alpha: a });
        text(label, pad + 60, y - 12, 14, { w: 500, color: C.soft, align: 'left', alpha: a });
        text(val, pad + 60, y + 13, fit(val, 20, cw - 80), { align: 'left', alpha: a });
      });
    } else if (sc === 4) {
      const p = ease(seg(t, 22, 26.5));
      text(`Za ${data.futureYears} lat`, cx, H * 0.13, 22);
      const vals = data.future.map((f) => f.net);
      const box = { x: pad, y: H * 0.22, w: cw, h: H * 0.36 };
      if (vals.length > 1) line(vals, box.x + 8, box.y + 8, box.w - 16, box.h - 16, p, C.pos, { dash: true });
      const v = Math.round(data.net + (data.futureNet - data.net) * p);
      if (audio && !muted && p < 1 && t - lastTick > 0.09) { audio.tick(); lastTick = t; }
      const s = `ok. ${data.fmt(v)}`;
      text(s, cx, H * 0.68, fit(s, 36, cw));
      text('szacunek na założeniach z symulacji', cx, H * 0.68 + 30, 13, { w: 500, color: C.soft });
      if (data.payoffText) text(data.payoffText, cx, H * 0.82, fit(data.payoffText, 17, cw, 600), { w: 600, alpha: ease(seg(t, 25.5, 26.5)), color: C.gold });
    } else {
      const a = ease(seg(t, 28, 29));
      text('✨', cx, H * 0.32, 48, { alpha: a });
      text(data.outro, cx, H * 0.45, fit(data.outro, 22, cw), { alpha: a });
      text('Smart Finance', cx, H * 0.56, 16, { w: 600, color: C.soft, alpha: a });
    }
    wrap.querySelector('.film-prog i').style.width = `${(t / DURATION) * 100}%`;
  };

  const frame = (now) => {
    const dt = Math.min(0.1, (now - last) / 1000); last = now;
    if (playing) t += dt;
    if (t >= DURATION) { t = DURATION; playing = false; wrap.querySelector('.film-replay').hidden = false; wrap.querySelector('[data-f=play]').textContent = '▶'; }
    draw();
    raf = requestAnimationFrame(frame);
  };
  const close = () => {
    cancelAnimationFrame(raf); window.removeEventListener('resize', resize);
    audio?.close(); try { speechSynthesis.cancel(); } catch { /* brak */ }
    root.innerHTML = ''; opts.onClose?.();
  };
  const restart = () => {
    audio?.close(); try { audio = makeAudio(); } catch { audio = null; }
    audio?.mute(muted); t = 0; lastScene = -1; playing = true; audio?.start(0);
    wrap.querySelector('.film-replay').hidden = true; wrap.querySelector('[data-f=play]').textContent = '⏸';
  };
  wrap.addEventListener('click', (e) => {
    const b = e.target.closest('[data-f]');
    if (!b) return;
    if (b.dataset.f === 'close') close();
    else if (b.dataset.f === 'replay') restart();
    else if (b.dataset.f === 'mute') { muted = !muted; audio?.mute(muted); b.textContent = muted ? '🔇' : '🔊'; if (muted) try { speechSynthesis.cancel(); } catch { /* brak */ } }
    else if (b.dataset.f === 'play') {
      if (t >= DURATION) { restart(); return; }
      playing = !playing; b.textContent = playing ? '⏸' : '▶';
      if (audio) (playing ? audio.ctx.resume() : audio.ctx.suspend());
    }
  });
  audio?.start(0);
  raf = requestAnimationFrame(frame);
  return { close, get time() { return t; }, seek(s) { t = s; } };
}
