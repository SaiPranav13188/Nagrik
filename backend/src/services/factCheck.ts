/**
 * Hallucination guard for letters the model writes to government offices: phone numbers, emails,
 * links, long numbers (pincodes, reference numbers) and years must come from the facts it was given.
 * Prompts say "do not invent"; this checks it.
 */
const URL_RE = /https?:\/\/[^\s<>"')\]]+/gi;
const EMAIL_RE = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
// 6+ digits, optionally split by spaces or dashes, not part of a decimal (GPS coordinates).
const NUMBER_RE = /(?<!\d|\d\.)\+?\d(?:[\d -]*\d){5,}(?!\d|\.\d)/g;
const YEAR_RE = /\b(?:19|20)\d{2}\b/g;

const digits = (s: string) => s.replace(/\D/g, '');
const trimUrl = (u: string) => u.replace(/[.,;:!?]+$/, '');

export function inventedDetails(text: string, facts: string): string[] {
  const found = new Set<string>();
  const factsLower = facts.toLowerCase();
  const factUrls = (facts.match(URL_RE) ?? []).map(trimUrl);
  const factNumbers = (facts.replace(URL_RE, ' ').match(NUMBER_RE) ?? []).map(digits);

  for (const raw of text.match(URL_RE) ?? []) {
    const url = trimUrl(raw);
    if (!factUrls.includes(url)) found.add(url);
  }
  const rest = text.replace(URL_RE, ' ');
  for (const email of rest.match(EMAIL_RE) ?? []) {
    if (!factsLower.includes(email.toLowerCase())) found.add(email);
  }
  for (const n of rest.replace(EMAIL_RE, ' ').match(NUMBER_RE) ?? []) {
    const d = digits(n);
    // "+91 98765 43210" is fine when the facts have "9876543210".
    const known = factNumbers.some((f) => f === d || (d.length > 10 && f.length === 10 && d.endsWith(f)));
    if (!known) found.add(n.trim());
  }
  const thisYear = String(new Date().getFullYear());
  for (const y of text.match(YEAR_RE) ?? []) {
    if (y !== thisYear && !facts.includes(y)) found.add(y);
  }
  return [...found];
}
