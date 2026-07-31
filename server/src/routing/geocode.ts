// Address geocoding for the trip planner. Uses a configurable Nominatim
// instance (public by default; set GEOCODER_URL to a self-hosted one to avoid
// rate limits). Results are biased to the NYC area.

const GEOCODER_URL =
  process.env.GEOCODER_URL ?? "https://nominatim.openstreetmap.org";

// Rough NYC bounding box (viewbox = left,top,right,bottom).
const NYC_VIEWBOX = "-74.30,40.95,-73.65,40.48";

export interface GeoResult {
  name: string;
  lat: number;
  lon: number;
}

/** Forward-geocode a free-text address to a coordinate near NYC. */
export async function geocode(query: string): Promise<GeoResult | null> {
  // Allow "lat,lon" input directly (bypasses the geocoder).
  const ll = /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/.exec(query);
  if (ll) {
    return { name: query.trim(), lat: Number(ll[1]), lon: Number(ll[2]) };
  }

  const url =
    `${GEOCODER_URL}/search?format=jsonv2&limit=1&countrycodes=us` +
    `&viewbox=${encodeURIComponent(NYC_VIEWBOX)}&bounded=1` +
    `&q=${encodeURIComponent(query)}`;

  const res = await fetch(url, {
    headers: {
      // Nominatim usage policy requires a descriptive User-Agent.
      "User-Agent": "transitplotter/0.1 (nyc subway live map)",
      Accept: "application/json",
    },
  });
  if (!res.ok) return null;
  const arr = (await res.json()) as any[];
  if (!Array.isArray(arr) || arr.length === 0) return null;
  const r = arr[0];
  return {
    name: r.display_name?.split(",").slice(0, 2).join(",") ?? query,
    lat: Number(r.lat),
    lon: Number(r.lon),
  };
}
