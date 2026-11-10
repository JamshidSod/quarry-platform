// The haul-distance rule. The same rule is written in Python (quarrydb/haul.py) and the two are
// tested against each other: change them together.
//
// 1. the site is the midpoint of the straight line between the section's ends;
// 2. site and quarry are each moved to the nearest point on the network;
// 3. each such move counts as its straight-line length times a factor;
// 4. between the two network points the shortest way along the roads is taken;
// 5. if site and quarry are nearer to each other than the two of them together are to the roads,
//    no road is used: the straight line between them, times the factor, is the distance.
import { haversineM } from "./geo.js";
import { snap } from "./network.js";
import { distancesFrom, onRoadM } from "./route.js";

/** The quarry's stored network point, in the shape snap() returns. */
export function quarrySnap(quarry) {
  const s = quarry.snap;
  return { edge: s.edge, t: s.t, lon: s.lon, lat: s.lat, offsetM: s.offset_m };
}

/** Haul distance from a quarry to a site ([lon, lat]) with its parts, in km. */
export function haulTo(net, tree, siteSnap, site, quarry, factor) {
  const q = quarrySnap(quarry);
  const siteStraightKm = siteSnap.offsetM / 1000, quarryStraightKm = q.offsetM / 1000;
  const onroadKm = onRoadM(net, tree, siteSnap, q) / 1000;
  const directStraightKm = haversineM(site[0], site[1], quarry.lon, quarry.lat) / 1000;
  // one metre of slack: a site standing on the quarry's own road point is on a road, not roadless
  const direct = directStraightKm < siteStraightKm + quarryStraightKm - 0.001;
  const siteOffroadKm = siteStraightKm * factor, quarryOffroadKm = quarryStraightKm * factor;
  return {
    siteStraightKm, siteOffroadKm, onroadKm, quarryStraightKm, quarryOffroadKm, direct, directStraightKm,
    totalKm: direct ? directStraightKm * factor : siteOffroadKm + onroadKm + quarryOffroadKm,
  };
}

const round1 = (value) => Math.round(value * 10) / 10;

/**
 * The figures as shown and exported: rounded so that a reader can re-add them.
 * Straight-line stretches and the on-road distance are rounded to 0.1 km; each counted off-road
 * stretch is its rounded straight line times the factor, rounded; the haul distance is the sum of
 * the rounded parts.
 */
export function presented(r, factor) {
  if (r.direct) {
    const directStraightKm = round1(r.directStraightKm);
    return { direct: true, directStraightKm, totalKm: round1(directStraightKm * factor) };
  }
  const siteStraightKm = round1(r.siteStraightKm), quarryStraightKm = round1(r.quarryStraightKm), onroadKm = round1(r.onroadKm);
  const siteOffroadKm = round1(siteStraightKm * factor), quarryOffroadKm = round1(quarryStraightKm * factor);
  return { direct: false, siteStraightKm, siteOffroadKm, onroadKm, quarryStraightKm, quarryOffroadKm,
    totalKm: round1(siteOffroadKm + onroadKm + quarryOffroadKm) };
}

/**
 * Every quarry of a material group (0 = all) with its haul distance to the site, nearest first.
 * Each item is {quarry, siteSnap, tree, ...the exact parts from haulTo, shown: the figures as presented}.
 */
export function rank(net, quarries, site, groupNo, factor) {
  const wanted = quarries.filter((q) => groupNo === 0 || q.group_no === groupNo);
  if (!wanted.length) return [];
  const siteSnap = snap(net, site[0], site[1]);
  const tree = distancesFrom(net, siteSnap);
  return wanted
    .map((quarry) => {
      const exact = haulTo(net, tree, siteSnap, site, quarry, factor);
      return { quarry, siteSnap, tree, ...exact, shown: presented(exact, factor) };
    })
    .sort((a, b) => a.totalKm - b.totalKm || (a.quarry.quarry_id < b.quarry.quarry_id ? -1 : 1));
}

/** Why a quarry's distance deserves caution: "coarse" coordinates, an open "finding", or null. */
export function warning(quarry) {
  if (quarry.warn_coarse) return "coarse";
  return quarry.warn_finding ? "finding" : null;
}
