// How a quarry's values and a search result are put into words and into export rows.
// t(key, values) is the wording function of the chosen language.
import { presented, warning } from "./haul.js";

const round1 = (v) => Math.round(v * 10) / 10;

/** Strength in MPa with kgf/cm² in brackets: "78.5–98.1 (800–1000)", "117.7 (1200)", or the no-data wording. */
export function strengthText(quarry, t) {
  if (quarry.strength_min === null) return t("site.card.nodata");
  const range = (lo, hi) => (lo === hi ? String(lo) : `${lo}–${hi}`);
  return `${range(quarry.strength_min_mpa, quarry.strength_max_mpa)} (${range(quarry.strength_min, quarry.strength_max)})`;
}

/** The reserves figure, the source's wording where there is no figure, or the no-data wording. */
export function reservesValue(quarry, t) {
  if (quarry.reserves_th_m3 !== null) return quarry.reserves_th_m3;
  return quarry.reserves_text || t("site.card.nodata");
}

/** A length in metres as "850 m" or "11.1 km". */
export function lengthText(metres, t) {
  return metres >= 1000 ? `${round1(metres / 1000)} ${t("site.unit.km")}` : `${Math.round(metres)} ${t("site.unit.m")}`;
}

/** The words behind a quarry's warning mark, or "" when it has none. */
export function warningText(quarry, t) {
  const kind = warning(quarry);
  if (kind === "coarse") return t("site.warn.coarse", { precision: String(round1(quarry.coord_precision_m / 1000)) });
  return kind === "finding" ? t("site.warn.finding") : "";
}

/**
 * The rows of the Excel export.
 * section: {start: [lon, lat], end: [lon, lat], mid: [lon, lat]}.
 */
export function exportRows(results, section, materialName, factor, t) {
  const point = (label, [lon, lat]) => [label, t("site.lat"), lat, t("site.lon"), lon];
  const km = (label) => label;
  const rows = [
    [t("site.export.title")],
    point(t("site.start"), section.start),
    point(t("site.end"), section.end),
    [t("site.midpoint", { lat: section.mid[1].toFixed(5), lon: section.mid[0].toFixed(5) })],
    [t("site.material"), materialName],
    [t("site.export.factor"), factor],
    [],
    [t("site.col.rank"), t("site.export.id"), t("site.col.quarry"), t("site.col.district"), t("site.card.rock"),
      `${t("site.card.reserves")}, ${t("site.unit.reserves")}`, `${t("site.card.strength")}, ${t("site.unit.strength")}`,
      km(t("site.export.site_straight")), km(t("site.export.site_offroad")), km(t("site.export.onroad")),
      km(t("site.export.quarry_straight")), km(t("site.export.quarry_offroad")), t("site.col.total"),
      t("site.export.note"), t("site.export.warning")],
  ];
  results.forEach((r, i) => {
    const q = r.quarry, p = r.shown || presented(r, factor);
    const parts = p.direct
      ? [null, null, null, null, null]
      : [p.siteStraightKm, p.siteOffroadKm, p.onroadKm, p.quarryStraightKm, p.quarryOffroadKm];
    const note = p.direct ? t("site.dist.direct", { km: p.directStraightKm.toFixed(1), factor: String(factor) }) : "";
    rows.push([i + 1, q.quarry_id, q.name, q.district, q.rock_type, reservesValue(q, t), strengthText(q, t),
      ...parts, p.totalKm, note, warningText(q, t)]);
  });
  return rows;
}
