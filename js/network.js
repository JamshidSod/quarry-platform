// The prepared road network: decoding the stored form, and finding the nearest point on it.
import { EARTH_RADIUS_M, haversineM } from "./geo.js";

const RAD = Math.PI / 180;
const CELL = 0.05; // degrees; size of the search grid's cells

/**
 * Decode network.json.
 * nodes: Float64Array of lon, lat pairs. edges[i]: {a, b, length (true metres), geom (lon, lat pairs),
 * along (metres along the stored shape at each of its points)}.
 */
export function decode(json) {
  const scale = json.scale;
  const nodes = Float64Array.from(json.nodes, (v) => v / scale);
  const edges = json.edges.map(([a, b, length, delta]) => {
    const geom = new Float64Array(delta.length);
    let x = 0, y = 0;
    for (let i = 0; i < delta.length; i += 2) {
      x += delta[i]; y += delta[i + 1];
      geom[i] = x / scale; geom[i + 1] = y / scale;
    }
    const along = new Float64Array(geom.length / 2);
    for (let i = 1; i < along.length; i++) {
      along[i] = along[i - 1] + haversineM(geom[2 * i - 2], geom[2 * i - 1], geom[2 * i], geom[2 * i + 1]);
    }
    return { a, b, length, geom, along };
  });

  const adjacency = Array.from({ length: nodes.length / 2 }, () => []);
  edges.forEach((e, i) => {
    if (e.a !== e.b) { adjacency[e.a].push([e.b, e.length, i]); adjacency[e.b].push([e.a, e.length, i]); }
  });

  const grid = new Map();
  edges.forEach((e, i) => {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let k = 0; k < e.geom.length; k += 2) {
      x0 = Math.min(x0, e.geom[k]); x1 = Math.max(x1, e.geom[k]);
      y0 = Math.min(y0, e.geom[k + 1]); y1 = Math.max(y1, e.geom[k + 1]);
    }
    for (let cx = Math.floor(x0 / CELL); cx <= Math.floor(x1 / CELL); cx++) {
      for (let cy = Math.floor(y0 / CELL); cy <= Math.floor(y1 / CELL); cy++) {
        const key = cx + ":" + cy;
        if (!grid.has(key)) grid.set(key, []);
        grid.get(key).push(i);
      }
    }
  });
  return { nodes, edges, adjacency, grid, stamp: new Int32Array(edges.length), round: 0 };
}

/** Nearest point of one edge to lon/lat, measured in a flat projection centred on lon/lat. */
function nearestOnEdge(e, lon, lat) {
  const kx = Math.cos(lat * RAD) * RAD * EARTH_RADIUS_M, ky = RAD * EARTH_RADIUS_M;
  let best = null;
  for (let i = 0; i + 3 < e.geom.length; i += 2) {
    const x0 = (e.geom[i] - lon) * kx, y0 = (e.geom[i + 1] - lat) * ky;
    const dx = (e.geom[i + 2] - lon) * kx - x0, dy = (e.geom[i + 3] - lat) * ky - y0;
    const seg2 = dx * dx + dy * dy;
    let u = seg2 > 0 ? -(x0 * dx + y0 * dy) / seg2 : 0;
    u = Math.min(1, Math.max(0, u));
    const px = x0 + u * dx, py = y0 + u * dy, d2 = px * px + py * py;
    if (best === null || d2 < best.d2) best = { d2, i: i / 2, u, px, py };
  }
  const total = e.along[e.along.length - 1];
  const t = total > 0 ? (e.along[best.i] + best.u * (e.along[best.i + 1] - e.along[best.i])) / total : 0;
  return { d2: best.d2, t, lon: lon + best.px / kx, lat: lat + best.py / ky };
}

/** The nearest point on the network: {edge, t, lon, lat, offsetM}. Ties go to the lowest edge number. */
export function snap(net, lon, lat) {
  const cx = Math.floor(lon / CELL), cy = Math.floor(lat / CELL);
  const cellM = CELL * RAD * EARTH_RADIUS_M * Math.cos((Math.abs(lat) + 1) * RAD); // narrowest a cell can be here
  const round = ++net.round;
  let best = null;
  for (let ring = 0; ring <= 800; ring++) {
    for (let x = cx - ring; x <= cx + ring; x++) {
      for (let y = cy - ring; y <= cy + ring; y++) {
        if (Math.max(Math.abs(x - cx), Math.abs(y - cy)) !== ring) continue;
        const list = net.grid.get(x + ":" + y);
        if (!list) continue;
        for (const i of list) {
          if (net.stamp[i] === round) continue;
          net.stamp[i] = round;
          const c = nearestOnEdge(net.edges[i], lon, lat);
          if (best === null || c.d2 < best.d2 || (c.d2 === best.d2 && i < best.edge)) best = { ...c, edge: i };
        }
      }
    }
    // everything within `ring` whole cells of the point has been looked at
    if (best !== null && Math.sqrt(best.d2) <= ring * cellM) break;
  }
  return { edge: best.edge, t: best.t, lon: best.lon, lat: best.lat, offsetM: haversineM(lon, lat, best.lon, best.lat) };
}

/** The point at fraction t along an edge's stored shape, as [lon, lat]. */
export function pointAt(net, edge, t) {
  return slice(net, edge, t, t)[0];
}

/** The stored shape of an edge between fractions t0 and t1, in that order, as [[lon, lat], ...]. */
export function slice(net, edge, t0, t1) {
  const e = net.edges[edge], total = e.along[e.along.length - 1];
  const at = (t) => {
    const d = t * total;
    let i = 0;
    while (i < e.along.length - 2 && e.along[i + 1] < d) i++;
    const span = e.along[i + 1] - e.along[i], u = span > 0 ? (d - e.along[i]) / span : 0;
    return [e.geom[2 * i] + u * (e.geom[2 * i + 2] - e.geom[2 * i]), e.geom[2 * i + 1] + u * (e.geom[2 * i + 3] - e.geom[2 * i + 1])];
  };
  const lo = Math.min(t0, t1), hi = Math.max(t0, t1), points = [at(lo)];
  for (let i = 0; i < e.along.length; i++) {
    if (e.along[i] > lo * total && e.along[i] < hi * total) points.push([e.geom[2 * i], e.geom[2 * i + 1]]);
  }
  if (hi > lo) points.push(at(hi));
  return t0 <= t1 ? points : points.reverse();
}
