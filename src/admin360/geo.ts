/**
 * IP → place, offline (geoip-lite ships its own GeoLite data; no IP ever
 * leaves the server). Loaded lazily the first time the console asks, and
 * degrades to "Unknown" if the database is not installed.
 */
interface GeoRecord {
  country: string;
  city: string;
  ll: [number, number];
}
type Lookup = (ip: string) => GeoRecord | null;

let lookup: Promise<Lookup> | null = null;

function load(): Promise<Lookup> {
  lookup ??= import('geoip-lite')
    .then((module) => {
      const geoip = (module as unknown as { default?: { lookup: Lookup }; lookup?: Lookup }).default ?? (module as unknown as { lookup: Lookup });
      return (ip: string) => geoip.lookup(ip);
    })
    .catch(() => () => null);
  return lookup;
}

export interface Place {
  country: string;
  city: string | null;
  lat: number | null;
  lon: number | null;
}

const PRIVATE = /^(10\.|127\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|::1$|fc|fd|fe80)/i;
const regionNames = new Intl.DisplayNames(['en'], { type: 'region' });

export const countryName = (code: string): string => {
  if (code === 'LOCAL') return 'Local network';
  if (code === '??') return 'Unknown';
  try {
    return regionNames.of(code) ?? code;
  } catch {
    return code;
  }
};

/** One IP → its place (ISO country code, city, coordinates). */
export async function placeOf(ip: string | null | undefined): Promise<Place> {
  if (!ip) return { country: '??', city: null, lat: null, lon: null };
  const clean = ip.replace(/^::ffff:/, '');
  if (PRIVATE.test(clean)) return { country: 'LOCAL', city: null, lat: null, lon: null };
  const record = (await load())(clean);
  return record ? { country: record.country || '??', city: record.city || null, lat: record.ll?.[0] ?? null, lon: record.ll?.[1] ?? null } : { country: '??', city: null, lat: null, lon: null };
}

/** Great-circle distance in km. */
export function distanceKm(a: Place, b: Place): number | null {
  if (a.lat === null || a.lon === null || b.lat === null || b.lon === null) return null;
  const rad = (degrees: number): number => (degrees * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(h));
}

/** A short device label from a user agent: "Chrome on Windows". */
export function deviceOf(userAgent: string | null | undefined): string {
  if (!userAgent) return 'Unknown device';
  const browser = /Edg\//.test(userAgent) ? 'Edge' : /OPR\//.test(userAgent) ? 'Opera' : /Chrome\//.test(userAgent) ? 'Chrome' : /Firefox\//.test(userAgent) ? 'Firefox' : /Safari\//.test(userAgent) ? 'Safari' : /okhttp|Expo|ReactNative/i.test(userAgent) ? 'Mobile app' : 'Other';
  const os = /Windows/.test(userAgent) ? 'Windows' : /Android/.test(userAgent) ? 'Android' : /iPhone|iPad|iOS/.test(userAgent) ? 'iOS' : /Mac OS X/.test(userAgent) ? 'macOS' : /Linux/.test(userAgent) ? 'Linux' : 'Other';
  return `${browser} on ${os}`;
}
