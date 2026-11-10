// Wording in the chosen language. All of it comes from data/strings.json (built from strings.csv).

/** t(key, values): the wording for a key with its {placeholders} filled; the key itself when unknown. */
export function makeT(strings, lang) {
  const table = strings[lang] || strings.en || {};
  const fallback = strings.en || {};
  return (key, values) => {
    const text = table[key] || fallback[key];
    if (text === undefined) return key;
    return values ? text.replace(/\{(\w+)\}/g, (whole, name) => (name in values ? String(values[name]) : whole)) : text;
  };
}

/** Put the wording into every element that names a key: data-i18n, data-i18n-placeholder, data-i18n-title. */
export function applyTo(root, t) {
  for (const el of root.querySelectorAll("[data-i18n]")) el.textContent = t(el.dataset.i18n);
  for (const el of root.querySelectorAll("[data-i18n-placeholder]")) el.placeholder = t(el.dataset.i18nPlaceholder);
  for (const el of root.querySelectorAll("[data-i18n-title]")) el.title = t(el.dataset.i18nTitle);
}
