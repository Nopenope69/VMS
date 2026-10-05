/** Query phrasing templates. Dependency-free on purpose: config/settings.ts loads it at start-up. */

export const DEFAULT_TEMPLATES: readonly string[] = [
  '{q}',
  'a photo of {q}',
  'a CCTV image of {q}',
  'a security camera photo of {q}',
];

export const MAX_TEMPLATES = 8;

/** Templates must each contain `{q}` once; at most MAX_TEMPLATES; blank input means the defaults. */
export function parseTemplates(raw: string | undefined | null): string[] {
  const list = (raw ?? '')
    .split('|')
    .map((t) => t.trim())
    .filter(Boolean);
  if (list.length === 0) return [...DEFAULT_TEMPLATES];
  if (list.length > MAX_TEMPLATES) throw new Error(`at most ${MAX_TEMPLATES} templates, got ${list.length}`);
  for (const t of list) {
    if (t.split('{q}').length !== 2) throw new Error(`template '${t}' must contain {q} exactly once`);
  }
  return list;
}

export const applyTemplate = (template: string, query: string) => template.replace('{q}', query);
