import { Platform } from 'react-native';
import { API_URL, APP_VERSION } from './config';

/**
 * Free crash reporting: JS errors are sent to the backend's /client-errors route, which logs them
 * and records them in Langfuse as "app-crash". The backend scrubs personal data too, but we send
 * only the error itself — never complaint text, location or profile details.
 */

const sent = new Set<string>();
let currentScreen = '';

export function setCrashScreen(path: string) {
  currentScreen = path.replace(/\/[0-9a-f-]{20,}/gi, '/[id]');
}

export function reportError(error: unknown, opts: { fatal?: boolean; source?: string } = {}) {
  if (__DEV__) return;
  const e = error instanceof Error ? error : new Error(String(error));
  const key = `${e.message}|${(e.stack ?? '').slice(0, 200)}`;
  if (sent.has(key) || sent.size > 20) return; // once per error per app session
  sent.add(key);
  fetch(`${API_URL}/client-errors`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: e.message,
      stack: e.stack,
      screen: currentScreen,
      fatal: opts.fatal === true,
      source: opts.source ?? 'manual',
      appVersion: APP_VERSION,
      platform: Platform.OS,
      osVersion: String(Platform.Version),
    }),
  }).catch(() => {});
}

let installed = false;

/** Catch uncaught JS errors and unhandled promise rejections. Call once at startup. */
export function installCrashReporter() {
  if (installed || __DEV__) return;
  installed = true;
  const g = globalThis as unknown as {
    ErrorUtils?: { getGlobalHandler: () => (e: unknown, fatal?: boolean) => void; setGlobalHandler: (h: (e: unknown, fatal?: boolean) => void) => void };
    HermesInternal?: { enablePromiseRejectionTracker?: (opts: { allRejections: boolean; onUnhandled: (id: number, reason: unknown) => void }) => void };
  };
  const previous = g.ErrorUtils?.getGlobalHandler();
  g.ErrorUtils?.setGlobalHandler((e, fatal) => {
    reportError(e, { fatal, source: 'global' });
    previous?.(e, fatal);
  });
  g.HermesInternal?.enablePromiseRejectionTracker?.({
    allRejections: true,
    onUnhandled: (_id, reason) => reportError(reason, { source: 'promise' }),
  });
}
