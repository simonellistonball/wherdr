// Beads named in a conversation (a quartermaster coordinator's report, an
// agent's summary…) become links: to the agent at work on that bead when one
// is, else to the bead on the Board. Only ids the Board knows are linked
// (GET /api/tasks/bead-refs): a hyphenated word that is not a bead stays text.
//
// It runs on the HTML md() made (sanitized, and cached by text alone, so it
// cannot depend on the Board): text outside tags is scanned, never a tag's
// attributes, nor the inside of a link, a button, a code block or a command.
// Inline code that is only a bead id (`hub-ozxp.32`) becomes the link itself.
import type { BeadRef } from '../../shared/beadsTasks'

// Several machines may read the same hub: the one where an agent is at work wins.
export function beadRefMap(refs: readonly BeadRef[]): Map<string, BeadRef> {
  const out = new Map<string, BeadRef>()
  for (const r of refs) {
    const had = out.get(r.bead)
    if (!had || (!had.pane && r.pane)) out.set(r.bead, r)
  }
  return out
}

const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' }[c]!))
// A bead-shaped word: prefix, dash, hash, optional `.n` children. A sentence's
// final dot is not part of it.
const TOKEN = /[A-Za-z][A-Za-z0-9_]{0,30}-[A-Za-z0-9][A-Za-z0-9.]{0,40}/g
const SKIP = new Set(['a', 'button', 'pre', 'script', 'style', 'textarea'])

function linkFor(ref: BeadRef, here: string | null, inner: string, tag = 'span'): string {
  const agent = Boolean(ref.pane && ref.pane !== here)
  const title = agent ? `Open the agent on ${ref.bead}: ${ref.title}` : `Open ${ref.bead} on the Board: ${ref.title}`
  return `<${tag} class="md-bead${agent ? ' md-bead-agent' : ''}" data-bead="${esc(ref.bead)}" role="link" tabindex="0" title="${esc(title)}">${inner}</${tag}>`
}

function linkText(text: string, known: ReadonlyMap<string, BeadRef>, here: string | null): string {
  return text.replace(TOKEN, (raw, at: number, all: string) => {
    const before = at > 0 ? all[at - 1]! : ''
    const id = raw.replace(/\.+$/, '')
    const after = all[at + id.length] ?? ''
    // Part of a longer word, a path or a flag (`a/hub-x`, `--hub-x`, `hub-x-y`).
    if (/[\w./@-]/.test(before) || /[\w-]/.test(after)) return raw
    const ref = known.get(id)
    return ref ? linkFor(ref, here, id) + raw.slice(id.length) : raw
  })
}

// `here`: the pane of this conversation (a bead whose agent is this one links to the Board).
export function linkBeadMentions(html: string, known: ReadonlyMap<string, BeadRef>, here: string | null = null): string {
  if (!known.size || !html) return html
  const parts = html.split(/(<[^>]*>)/)
  let skip = 0
  let code = -1 // index of the open <code> tag while inside one
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]!
    if (p.startsWith('<')) {
      const m = /^<(\/?)([a-zA-Z][\w-]*)/.exec(p)
      if (!m) continue
      const tag = m[2]!.toLowerCase()
      const closing = m[1] === '/'
      if (SKIP.has(tag) || (tag === 'code' && /\bmd-cmd\b/.test(p))) skip += closing ? -1 : 1
      else if (tag === 'code') code = closing ? -1 : i
      if (skip < 0) skip = 0
      continue
    }
    if (skip || !p) continue
    if (code >= 0) {
      // Inline code that is exactly a known id: the code becomes its link.
      const ref = parts[i + 1] === '</code>' ? known.get(p.trim()) : undefined
      if (ref && !/<pre/.test(parts[code - 1] || '')) {
        parts[code] = ''
        parts[i] = linkFor(ref, here, `<code>${p}</code>`)
        parts[i + 1] = ''
      }
      continue
    }
    parts[i] = linkText(p, known, here)
  }
  return parts.join('')
}
