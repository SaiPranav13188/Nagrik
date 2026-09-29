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

/**
 * Reverse geocoding with two free OpenStreetMap sources: Nominatim first (richest addresses),
 * Photon as a fallback — Nominatim often rejects requests from cloud hosts like Render.
 */
export async function reverseGeocode(lat: number, lng: number): Promise<GeocodeResult> {
  const key = `${lat.toFixed(5)},${lng.toFixed(5)}`;
  const hit = cache.get(key);
  if (hit) return hit;
  let result: GeocodeResult;
  try {
    result = await nominatim(lat, lng);
  } catch (e) {
    console.warn(`[geocode] Nominatim failed (${(e as Error).message}), using Photon`);
    result = await photon(lat, lng);
  }
  cache.set(key, result);
  if (cache.size > 5000) cache.clear();
  return result;
}

async function nominatim(lat: number, lng: number): Promise<GeocodeResult> {
  // Usage policy: max 1 request/second.
  const wait = lastCall + 1100 - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastCall = Date.now();
  const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&addressdetails=1&zoom=18&lat=${lat}&lon=${lng}`;
  const res = await fetch(url, {
    headers: { 'User-Agent': config.nominatimUserAgent, 'Accept-Language': 'en' },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`Nominatim ${res.status}`);
  const j = (await res.json()) as { display_name?: string; address?: Record<string, string>; error?: string };
  if (j.error) throw new Error(j.error);
  const a = j.address ?? {};
  return {
    address: j.display_name ?? `${lat}, ${lng}`,
    city: a.city || a.town || a.municipality || a.village || a.suburb || a.county || null,
    state: a.state || null,
    pincode: a.postcode || null,
    locality: a.neighbourhood || a.suburb || a.road || a.hamlet || null,
    district: a.state_district || a.county || null,
  };
}

async function photon(lat: number, lng: number): Promise<GeocodeResult> {
  const res = await fetch(`https://photon.komoot.io/reverse?lat=${lat}&lon=${lng}&lang=en`, {
    headers: { 'User-Agent': config.nominatimUserAgent },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`Photon ${res.status}`);
  const j = (await res.json()) as { features?: Array<{ properties?: Record<string, string> }> };
  const p = j.features?.[0]?.properties;
  if (!p) throw new Error('No address found for this location');
  const street = [p.housenumber, p.street].filter(Boolean).join(' ');
  const locality = p.district || p.locality || street || p.name || null;
  const city = p.city || p.town || p.village || p.county || null;
  const address = [p.name && p.name !== street ? p.name : null, street || null, p.district || p.locality, city, p.county, p.state, p.postcode, p.country]
    .filter((x, i, arr) => x && arr.indexOf(x) === i)
    .join(', ');
  return { address: address || `${lat}, ${lng}`, city, state: p.state || null, pincode: p.postcode || null, locality, district: p.county || null };
}
