import { Platform } from 'react-native';
import { API_URL } from './config';
import type { AnalyzeResult, AppNotification, ComplaintDetail, Complaint, IssueType, Profile } from './types';

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public body?: unknown,
  ) {
    super(message);
  }
}

let tokenGetter: () => Promise<string | null> = async () => null;
let onUnauthorized: () => void = () => {};
export function configureApi(opts: { getToken: () => Promise<string | null>; onUnauthorized: () => void }) {
  tokenGetter = opts.getToken;
  onUnauthorized = opts.onUnauthorized;
}

async function request<T>(path: string, opts: { method?: string; body?: unknown; form?: FormData; timeoutMs?: number; auth?: boolean } = {}): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (opts.auth !== false) {
    const token = await tokenGetter();
    if (token) headers.Authorization = `Bearer ${token}`;
  }
  let body: BodyInit | undefined;
  if (opts.form) body = opts.form;
  else if (opts.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(opts.body);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 20000);
  let res: Response;
  try {
    res = await fetch(API_URL + path, { method: opts.method ?? 'GET', headers, body, signal: controller.signal });
  } catch (e) {
    throw new ApiError((e as Error).name === 'AbortError' ? 'This is taking longer than usual. Please try again.' : 'NETWORK', 0);
  } finally {
    clearTimeout(timer);
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  if (!res.ok) {
    if (res.status === 401 && opts.auth !== false) onUnauthorized();
    throw new ApiError(json?.error ?? `Request failed (${res.status})`, res.status, json);
  }
  return json as T;
}

async function appendPhoto(form: FormData, uri: string) {
  if (Platform.OS === 'web') {
    const blob = await (await fetch(uri)).blob();
    form.append('photo', blob, 'photo.jpg');
  } else {
    // React Native's FormData accepts file descriptors.
    form.append('photo', { uri, name: 'photo.jpg', type: 'image/jpeg' } as unknown as Blob);
  }
}

export const api = {
  health: () => request<{ ok: boolean; ai: string; portal_mode: string; auth: string }>('/health', { auth: false, timeoutMs: 6000 }),
  localSignIn: (deviceId: string) => request<{ token: string; userId: string; profile: Profile }>('/auth/local', { method: 'POST', body: { deviceId }, auth: false }),

  me: () => request<{ profile: Profile }>('/me'),
  updateMe: (patch: Partial<Pick<Profile, 'full_name' | 'phone' | 'email' | 'preferred_language' | 'auto_submit_default'>>) =>
    request<{ profile: Profile }>('/me', { method: 'PUT', body: patch }),
  setPushToken: (token: string | null) => request('/me/push-token', { method: 'POST', body: { token } }),
  notifications: () => request<{ notifications: AppNotification[]; unread: number }>('/me/notifications'),
  markNotificationsRead: () => request('/me/notifications/read', { method: 'POST' }),

  complaints: () => request<{ complaints: Complaint[] }>('/complaints'),
  geocode: (lat: number, lng: number) => request<{ label: string; address: string; city: string | null }>(`/complaints/geocode?lat=${lat}&lng=${lng}`, { timeoutMs: 12000 }),
  complaint: (id: string) => request<ComplaintDetail>(`/complaints/${id}/status`),

  async analyze(input: {
    photoUri?: string;
    photoUrl?: string;
    intakeId?: string;
    latitude?: number;
    longitude?: number;
    manualAddress?: string;
    note?: string;
    clarificationAnswer?: IssueType;
  }) {
    const form = new FormData();
    if (input.photoUri) await appendPhoto(form, input.photoUri);
    for (const k of ['photoUrl', 'intakeId', 'latitude', 'longitude', 'manualAddress', 'note', 'clarificationAnswer'] as const) {
      const v = input[k];
      if (v !== undefined && v !== null && v !== '') form.append(k, String(v));
    }
    return request<AnalyzeResult>('/complaints/analyze', { method: 'POST', form, timeoutMs: 120000 });
  },

  hold: (id: string) => request<ComplaintDetail>(`/complaints/${id}/hold`, { method: 'POST' }),
  submit: (id: string) => request<ComplaintDetail>(`/complaints/${id}/submit`, { method: 'POST' }),
  retry: (id: string) => request<ComplaintDetail>(`/complaints/${id}/retry`, { method: 'POST' }),
  redraft: (id: string) => request<ComplaintDetail>(`/complaints/${id}/draft`, { method: 'POST', timeoutMs: 60000 }),
  editDraft: (id: string, subject: string, text: string) => request<ComplaintDetail>(`/complaints/${id}/draft`, { method: 'PATCH', body: { subject, text } }),
  manualSubmitted: (id: string, trackingId?: string) =>
    request<ComplaintDetail>(`/complaints/${id}/manual-submitted`, { method: 'POST', body: { trackingId: trackingId || undefined } }),
  userStatus: (id: string, resolved: boolean, note?: string) => request<ComplaintDetail>(`/complaints/${id}/user-status`, { method: 'POST', body: { resolved, note } }),
  checkStatus: (id: string) => request<ComplaintDetail>(`/complaints/${id}/check-status`, { method: 'POST', timeoutMs: 90000 }),
  remove: (id: string) => request<void>(`/complaints/${id}`, { method: 'DELETE' }),
};

export function errorMessage(e: unknown, offlineText: string, fallback: string) {
  if (e instanceof ApiError) return e.message === 'NETWORK' ? offlineText : e.message;
  return fallback;
}
