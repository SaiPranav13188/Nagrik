export interface CaptchaDetection {
  hasCaptcha: boolean;
  kind: 'recaptcha' | 'hcaptcha' | 'turnstile' | 'image_captcha' | 'otp_gate' | 'text_challenge' | null;
  evidence: string[];
}

const CHECKS: Array<{ kind: NonNullable<CaptchaDetection['kind']>; re: RegExp; label: string }> = [
  { kind: 'recaptcha', re: /g-recaptcha|google\.com\/recaptcha|recaptcha\/api\.js|grecaptcha/i, label: 'Google reCAPTCHA widget' },
  { kind: 'hcaptcha', re: /hcaptcha\.com|class=["'][^"']*h-captcha/i, label: 'hCaptcha widget' },
  { kind: 'turnstile', re: /challenges\.cloudflare\.com|cf-turnstile/i, label: 'Cloudflare Turnstile' },
  {
    kind: 'image_captcha',
    re: /<img[^>]+(?:id|src|alt|class|name)=["'][^"']*captcha[^"']*["']/i,
    label: 'Image CAPTCHA',
  },
  {
    kind: 'image_captcha',
    re: /<input[^>]+(?:id|name|placeholder)=["'][^"']*captcha[^"']*["']/i,
    label: 'CAPTCHA input field',
  },
  {
    kind: 'otp_gate',
    re: /(send|get|generate|verify)\s*otp|enter\s*(the\s*)?otp|<input[^>]+(?:id|name)=["'][^"']*\botp\b[^"']*["']/i,
    label: 'Mobile OTP verification gate',
  },
  {
    kind: 'text_challenge',
    re: /enter the (characters|code|text) (shown|you see)|security code|verify you are (a )?human|i'?m not a robot/i,
    label: 'Human-verification challenge text',
  },
];

/**
 * Detects anything that means "a human must be present" — CAPTCHAs and OTP gates alike.
 * The system never attempts to bypass these; detection always triggers the manual fallback.
 */
export function detectCaptcha(html: string): CaptchaDetection {
  const evidence: string[] = [];
  let kind: CaptchaDetection['kind'] = null;
  for (const c of CHECKS) {
    const m = html.match(c.re);
    if (m) {
      kind ??= c.kind;
      evidence.push(`${c.label}: “${m[0].slice(0, 80)}”`);
    }
  }
  return { hasCaptcha: evidence.length > 0, kind, evidence };
}
