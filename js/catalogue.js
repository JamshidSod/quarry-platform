// Browsing the register: filtering, the summary by region, and how the entered attributes are worded.
// Nothing here touches the page; app.js draws what these return.
import { strengthText, reservesValue } from "./exportrows.js";

/**
 * The quarries that pass the filters, in register order.
 * filters: {region: code or "", group: number or 0, minStrengthMpa: number or null, labOnly: boolean}.
 * A quarry with no strength value cannot pass a strength floor; withoutStrength says how many
 * otherwise-matching quarries were left out for that reason.
 */
export function filterQuarries(quarries, filters) {
  const list = [];
  let withoutStrength = 0;
  for (const q of quarries) {
    if (filters.region && q.region_code !== filters.region) continue;
    if (filters.group && q.group_no !== filters.group) continue;
    if (filters.labOnly && q.lab.length === 0) continue;
    if (filters.minStrengthMpa !== null) {
      if (q.strength_min_mpa === null) { withoutStrength += 1; continue; }
      if (q.strength_min_mpa < filters.minStrengthMpa) continue;
    }
    list.push(q);
  }
  return { list, withoutStrength };
}

/** One row per region, in the order the regions first appear: counts by material group, total, with lab results. */
export function regionSummary(quarries, groupCount) {
  const rows = new Map();
  for (const q of quarries) {
    if (!rows.has(q.region_code)) rows.set(q.region_code, { region: q.region_code, groups: Array(groupCount).fill(0), total: 0, lab: 0 });
    const row = rows.get(q.region_code);
    row.groups[q.group_no - 1] += 1;
    row.total += 1;
    if (q.lab.length) row.lab += 1;
  }
  return [...rows.values()];
}

// field -> how its value is put into words
const CODED = { status: "status.", radiation_class: "" };
const UNITS = { capacity_th_m3_year: "site.unit.capacity", aeff_bq_kg: "site.unit.aeff" };
export const ATTRIBUTES = ["status", "operator", "licence", "capacity_th_m3_year", "products", "recommended_use",
  "material_class", "aeff_bq_kg", "radiation_class", "chemistry"];
export const BALANCE = ["balance_deposit", "balance_licence", "balance_status", "balance_holder"];

const code = (value) => value.replaceAll(" ", "_");

/** The wording of one entered attribute of a quarry, or the no-data wording. */
export function attributeText(quarry, field, t) {
  const value = quarry[field];
  if (value === null || value === undefined || value === "") return t("site.card.nodata");
  if (field === "recommended_use") return value.split("; ").map((use) => t("use." + code(use))).join("; ");
  if (field === "status") return t(CODED.status + code(value));
  if (field in UNITS) return `${value} ${t(UNITS[field])}`;
  return String(value);
}

/** The rows of the Excel export of a filtered list. */
export function catalogueRows(list, t) {
  const rows = [[t("site.export.id"), t("site.col.quarry"), t("site.card.region"), t("site.col.district"), t("site.card.rock"),
    t("site.card.group"), `${t("site.card.reserves")}, ${t("site.unit.reserves")}`,
    `${t("site.card.strength")}, ${t("site.unit.strength")}`, t("site.lat"), t("site.lon"),
    ...ATTRIBUTES.map((field) => t("site.attr." + field)), t("site.browse.lab")]];
  for (const q of list) {
    rows.push([q.quarry_id, q.name, t("region." + q.region_code), q.district, q.rock_type, t("group." + q.group_no),
      reservesValue(q, t), strengthText(q, t), q.lat, q.lon,
      ...ATTRIBUTES.map((field) => attributeText(q, field, t)), q.lab.length ? t("site.yes") : t("site.no")]);
  }
  return rows;
}

/** A quarry's laboratory rows as one group per sample, in the order the samples first appear. */
export function samples(labRows) {
  const groups = new Map();
  for (const row of labRows) {
    if (!groups.has(row.sample_id)) groups.set(row.sample_id, { id: row.sample_id, tested: row.tested, laboratory: row.laboratory, rows: [] });
    groups.get(row.sample_id).rows.push(row);
  }
  return [...groups.values()];
}
