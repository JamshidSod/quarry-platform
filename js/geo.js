// Distances and coordinates. No page code here: these functions are also run by the tests.

export const EARTH_RADIUS_M = 6371000;
const RAD = Math.PI / 180;

/** Great-circle distance in metres. */
export function haversineM(lon1, lat1, lon2, lat2) {
  const p1 = lat1 * RAD, p2 = lat2 * RAD;
  const a = Math.sin((p2 - p1) / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(((lon2 - lon1) * RAD) / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(a));
}

/** The point halfway along the great circle between two points, as [lon, lat]. */
export function midpoint(lon1, lat1, lon2, lat2) {
  const p1 = lat1 * RAD, p2 = lat2 * RAD, l1 = lon1 * RAD, dl = (lon2 - lon1) * RAD;
  const bx = Math.cos(p2) * Math.cos(dl), by = Math.cos(p2) * Math.sin(dl);
  const lat = Math.atan2(Math.sin(p1) + Math.sin(p2), Math.sqrt((Math.cos(p1) + bx) ** 2 + by ** 2));
  const lon = l1 + Math.atan2(by, Math.cos(p1) + bx);
  return [lon / RAD, lat / RAD];
}

/** A typed coordinate in decimal degrees (comma or point), or null when it is not one. */
export function parseCoordinate(text) {
  if (text === null || text === undefined) return null;
  const t = String(text).replace(/\s+/g, "").replace(",", ".");
  return /^-?\d+(\.\d+)?$/.test(t) ? Number(t) : null;
}

/** bbox is [lon min, lat min, lon max, lat max]. */
export function inBbox(lon, lat, bbox) {
  return lon >= bbox[0] && lon <= bbox[2] && lat >= bbox[1] && lat <= bbox[3];
}
