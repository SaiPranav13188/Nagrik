import { config } from '../config.js';

export interface GeocodeResult {
  address: string;
  city: string | null;
  state: string | null;
  pincode: string | null;
  locality: string | null;
  district: string | null;
}

const cache = new Map<string, GeocodeResult>();
let lastCall = 0;

/** Nominatim reverse geocoding (free, no key). Respects the 1 req/sec usage policy. */
export async function reverseGeocode(lat: number, lng: number): Promise<GeocodeResult> {
  const key = `${lat.toFixed(5)},${lng.toFixed(5)}`;
  const hit = cache.get(key);
  if (hit) return hit;

  const wait = lastCall + 1100 - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastCall = Date.now();

  const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&addressdetails=1&zoom=18&lat=${lat}&lon=${lng}`;
  const res = await fetch(url, {
    headers: { 'User-Agent': config.nominatimUserAgent, 'Accept-Language': 'en' },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`Nominatim ${res.status}`);
  const j = (await res.json()) as { display_name?: string; address?: Record<string, string>; error?: string };
  if (j.error) throw new Error(j.error);
  const a = j.address ?? {};
  const result: GeocodeResult = {
    address: j.display_name ?? `${lat}, ${lng}`,
    city: a.city || a.town || a.municipality || a.village || a.suburb || a.county || null,
    state: a.state || null,
    pincode: a.postcode || null,
    locality: a.neighbourhood || a.suburb || a.road || a.hamlet || null,
    district: a.state_district || a.county || null,
  };
  cache.set(key, result);
  return result;
}
