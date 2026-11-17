/**
 * Describing where the phone was without any third-party service (docs/design/phase4-location.md,
 * "On the server"): relative to the family's own places ("At School, within 40 m"; "1.2 km from
 * Home"), by the haversine distance from each place's center, worked out here. "Open in a map"
 * puts the coordinates in a link to the map site the family picked; only the parent's browser
 * follows it, when the parent clicks. The server never fetches it, and no map is embedded.
 */
import type { MapSite } from "../../settings.js";

/** The Earth's mean radius (IUGG), in meters. */
const EARTH_M = 6_371_008.8;

const rad = (deg: number) => (deg * Math.PI) / 180;

/** The great-circle distance between two points, in meters (the haversine formula). */
export function distanceMeters(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** "40 m", "350 m", "1.2 km", "45 km": meters to the nearest 10 under a kilometer. */
export function distanceWords(meters: number): string {
  const m = Math.max(0, meters);
  if (m < 995) return `${Math.max(10, Math.round(m / 10) * 10)} m`;
  const km = m / 1000;
  return km < 9.95 ? `${km.toFixed(1)} km` : `${Math.round(km)} km`;
}

/** "within 40 m": how accurate a fix is. */
export const accuracyWords = (accuracyM: number): string => `within ${distanceWords(accuracyM)}`;

export interface PlaceRef {
  id: string;
  /** The family's words. */
  name: string;
  lat: number;
  lng: number;
  radiusM: number;
}

/** Where a fix was, relative to the family's places. */
export type FixPlace =
  /** Inside a place (the nearest center, of those it's in). */
  | { relation: "at"; place: PlaceRef; distanceM: number }
  /** Outside every place: how far from the nearest one's center. */
  | { relation: "from"; place: PlaceRef; distanceM: number }
  /** The phone has no places to compare with. */
  | { relation: "none" };

export function placeOf(fix: { lat: number; lng: number }, places: PlaceRef[]): FixPlace {
  let inside: { place: PlaceRef; d: number } | null = null;
  let nearest: { place: PlaceRef; d: number } | null = null;
  for (const place of places) {
    const d = distanceMeters(fix, place);
    if (d <= place.radiusM && (inside === null || d < inside.d)) inside = { place, d };
    if (nearest === null || d < nearest.d) nearest = { place, d };
  }
  if (inside) return { relation: "at", place: inside.place, distanceM: inside.d };
  if (nearest) return { relation: "from", place: nearest.place, distanceM: nearest.d };
  return { relation: "none" };
}

/**
 * The fix in words: "At School, within 40 m" (inside a place, and how accurate the fix is), or
 * "1.2 km from Home" (from the nearest place's center), or, with no places, null. The place names
 * are the family's words: over MCP the sentence goes under `untrusted`.
 */
export function describeFix(fix: { lat: number; lng: number; accuracyM: number }, places: PlaceRef[]): { where: FixPlace; words: string | null } {
  const where = placeOf(fix, places);
  switch (where.relation) {
    case "at":
      return { where, words: `At ${where.place.name}, ${accuracyWords(fix.accuracyM)}` };
    case "from":
      return { where, words: `${distanceWords(where.distanceM)} from ${where.place.name}` };
    case "none":
      return { where, words: null };
  }
}

/** The coordinates as the link carries them: 5 decimal places, about a meter. */
const coord = (n: number) => n.toFixed(5);

/** "Open in a map": a link to the family's map site, followed only by the parent's browser. */
export function mapLink(site: MapSite, lat: number, lng: number): string {
  switch (site) {
    case "google":
      return `https://www.google.com/maps/search/?api=1&query=${coord(lat)},${coord(lng)}`;
    case "openstreetmap":
      return `https://www.openstreetmap.org/?mlat=${coord(lat)}&mlon=${coord(lng)}#map=17/${coord(lat)}/${coord(lng)}`;
  }
}

/** Coordinates as the phone sends them and the server keeps them: 5 decimal places. */
export const round5 = (n: number): number => Math.round(n * 1e5) / 1e5;
