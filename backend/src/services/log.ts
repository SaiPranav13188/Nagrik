/**
 * Error text that is safe for the Render logs. Never log the error object itself: AI SDK errors
 * carry the whole request (photo, name, phone, address) in requestBodyValues.
 */
export function safeError(e: unknown) {
  if (!(e instanceof Error)) return String(e).slice(0, 300);
  const status = (e as { statusCode?: number }).statusCode;
  return `${e.name}${status ? ` (${status})` : ''}: ${e.message.slice(0, 300)}`;
}
