/**
 * Citizen-typed text (notes, addresses, voice transcripts) is untrusted input that ends up in agent
 * prompts and in letters sent to government offices. Strip anything that reads like an instruction
 * to the AI so it can neither steer an agent nor be pasted into an official complaint.
 * The tools enforce the real guardrails; this only keeps the text clean.
 */
const INJECTION_PATTERNS: RegExp[] = [
  /\b(ignore|disregard|forget)\b[^.!?\n]{0,40}\b(instructions?|rules|prompts?|above|previous)\b[^.!?\n]*/gi,
  /\b(system|assistant|developer|user)\s*:[^\n]*/gi,
  /<\/?\s*(note|system|assistant|user|instructions?|prompt)\s*>/gi,
  /\byou are now\b[^.!?\n]*/gi,
  /\b(call|use|invoke|run)\s+(the\s+)?[a-z]+_[a-z_]+\b[^.!?\n]*/gi,
  /\b(mark|set)\b[^.!?\n]{0,40}\b(as\s+(submitted|resolved|filed)|issue_type\s*=)[^.!?\n]*/gi,
];

export function cleanCitizenText(text: string | null | undefined): string | null {
  if (!text) return null;
  let t = text;
  for (const re of INJECTION_PATTERNS) t = t.replace(re, ' ');
  t = t.replace(/\s+([.,!?])/g, '$1').replace(/([.,!?])(\s*[.,!?])+/g, '$1').replace(/\s{2,}/g, ' ').trim();
  t = t.replace(/^[.,!?\s]+|[,\s]+$/g, '');
  return t || null;
}

// ── Places we have verified mappings for. Citizens misspell town names a lot. ──
const KNOWN_PLACES = [
  {
    city: 'Wanaparthy',
    state: 'Telangana',
    pins: ['509103'],
    aliases: /\b(wa|va)n(a)?parth?[iy]\b|వనపర్తి|वनपर्ती|वनपर्थी/i,
  },
];

export function inferPlace(text: string | null | undefined): { city: string; state: string; pincode: string | null } | null {
  if (!text) return null;
  const pin = text.match(/\b(\d{6})\b/)?.[1] ?? null;
  for (const p of KNOWN_PLACES) {
    if (p.aliases.test(text) || (pin && p.pins.includes(pin))) return { city: p.city, state: p.state, pincode: pin ?? p.pins[0] };
  }
  return null;
}
