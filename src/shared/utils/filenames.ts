/**
 * Windows-safe filename utilities.
 *
 * Rules applied:
 * - illegal characters: <>:"/\|?* and C0 control chars
 * - reserved device names (CON, PRN, AUX, NUL, COM1-9, LPT1-9)
 * - no trailing dots or spaces
 * - length cap, whitespace collapse
 */

const ILLEGAL = /[<>:"/\\|?*\u0000-\u001f\u007f]/g
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i

export function sanitizeFilename(name: string, maxLength = 80): string {
  let out = (name || '')
    .replace(ILLEGAL, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '')
  if (!out) out = 'untitled'
  if (out.length > maxLength) {
    out = out.slice(0, maxLength).replace(/[. ]+$/, '').trim()
  }
  if (RESERVED.test(out)) out = `_${out}`
  return out
}

/** Kebab-case slug for filename templates: "Why Most Startups Fail!" → "why-most-startups-fail" */
export function slugify(text: string, maxLength = 48): string {
  const slug = (text || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(ILLEGAL, ' ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLength)
    .replace(/-+$/g, '')
  return slug || 'clip'
}

/**
 * Resolve name collisions: returns a path-safe base name, appending " (2)",
 * " (3)"… when `exists` reports the target is taken.
 */
export function uniqueName(base: string, exists: (name: string) => boolean): string {
  if (!exists(base)) return base
  let i = 2
  while (exists(`${base} (${i})`)) i++
  return `${base} (${i})`
}

/** "01_topic-name.mp4" from a template. */
export function formatExportFilename(
  template: string,
  vars: { index: number; slug: string; title: string; date?: string }
): string {
  const t = template && template.includes('{') ? template : '{index}_{slug}'
  let out = t
    .replace('{index}', String(vars.index).padStart(2, '0'))
    .replace('{slug}', vars.slug)
    .replace('{title}', vars.title)
    .replace('{date}', vars.date ?? new Date().toISOString().slice(0, 10))
  out = sanitizeFilename(out, 90)
  if (!out) out = 'clip'
  return out
}
