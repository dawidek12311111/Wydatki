// „Do kupienia” — analiza większych zakupów. Wszystko liczone z danych aplikacji;
// wynik rozróżnia dane rzeczywiste, założenia i szacunki.
import { addMonths } from './dates.js';

export const PRIORITIES = { high: 'Wysoki', mid: 'Średni', low: 'Niski' };
export const STATUSES = { idea: 'Pomysł', saving: 'Odkładam', bought: 'Kupione' };
export const PURCHASE_ICONS = ['🚗', '☀️', '🏠', '🛋️', '📺', '💻', '🔧', '🏍️', '🚲', '✈️', '💍', '🎁'];

/** Rata kredytu (annuitetowa). rateYear w %, np. 9.5. */
export function loanInstallment(principal, rateYear, months) {
  if (!(principal > 0) || !(months > 0)) return 0;
  const r = rateYear / 100 / 12;
  if (r === 0) return Math.round(principal / months);
  return Math.round((principal * r) / (1 - (1 + r) ** -months));
}

export function monthsBetween(fromYm, toYm) {
  const [a, b] = [fromYm, toYm].map((x) => { const [y, m] = x.split('-').map(Number); return y * 12 + m; });
  return b - a;
}

/**
 * Pełna analiza zakupu.
 * ctx: { saved (zgromadzone), avgNet (średnia miesięczna nadwyżka), avgExpense, avgIncome,
 *        savingsTotal (suma oszczędności), currentYm }
 */
export function analyzePurchase(p, ctx) {
  const price = p.price || 0;
  const saved = Math.max(0, Math.min(ctx.saved || 0, price));
  const missing = Math.max(0, price - saved);
  const out = { price, saved, missing, progress: price ? saved / price : 0 };

  // Tempo odkładania: plan użytkownika ma pierwszeństwo, inaczej średnia nadwyżka
  const pace = p.monthlySaving > 0 ? p.monthlySaving : ctx.avgNet > 0 ? ctx.avgNet : 0;
  out.pace = pace;
  out.paceSource = p.monthlySaving > 0 ? 'plan' : ctx.avgNet > 0 ? 'average' : null;
  out.monthsToAfford = missing === 0 ? 0 : pace > 0 ? Math.ceil(missing / pace) : null;
  out.affordYm = out.monthsToAfford == null ? null : addMonths(ctx.currentYm, out.monthsToAfford);

  if (p.targetYm) {
    const months = monthsBetween(ctx.currentYm, p.targetYm);
    out.monthsToTarget = months;
    out.requiredMonthly = missing === 0 ? 0 : months > 0 ? Math.ceil(missing / months) : null;
    out.onTrack = out.monthsToAfford != null && out.monthsToAfford <= Math.max(0, months);
  }

  // Poduszka bezpieczeństwa: ile miesięcy wydatków pokrywają oszczędności przed i po zakupie (za gotówkę)
  if (ctx.avgExpense > 0) {
    out.cushionBefore = ctx.savingsTotal / ctx.avgExpense;
    out.cushionAfter = (ctx.savingsTotal - price) / ctx.avgExpense;
  }

  // Kredyt: rata, koszt całkowity, udział raty w średnim dochodzie
  if (p.loanRate != null && p.loanMonths > 0) {
    const principal = Math.max(0, price - (p.loanOwn || 0));
    const inst = loanInstallment(principal, p.loanRate, p.loanMonths);
    out.loan = {
      principal, installment: inst, total: inst * p.loanMonths, interest: inst * p.loanMonths - principal,
      incomeShare: ctx.avgIncome > 0 ? inst / ctx.avgIncome : null,
    };
  }

  // Zwrot z inwestycji (np. fotowoltaika): cena / miesięczna korzyść
  if (p.monthlyBenefit > 0) {
    const months = Math.ceil(price / p.monthlyBenefit);
    out.payback = { months, years: months / 12 };
  }
  return out;
}
