// Bead mentions in conversations (app/utils/beadLinks.ts): which words become
// links, where they point, and what is never touched.
import { describe, expect, it } from 'vitest'
import { beadRefMap, linkBeadMentions } from '../app/utils/beadLinks'
import type { BeadRef } from '../shared/beadsTasks'

const ref = (bead: string, pane: string | null = null, machine = ''): BeadRef => ({ machine, id: `web/${bead}`, bead, title: `Title of ${bead}`, group: pane ? 'working' : 'todo', pane })
const known = beadRefMap([ref('hub-ab'), ref('hub-ozxp.32', 'w5:p2'), ref('hub-cd')])
const link = (html: string, here: string | null = null) => linkBeadMentions(html, known, here)
const beads = (html: string) => [...html.matchAll(/data-bead="([^"]+)"/g)].map(m => m[1])

describe('bead mentions', () => {
  it('links known ids in prose, to the agent when one works on it, else to the Board', () => {
    const out = link('<p>Dispatched hub-ozxp.32; hub-ab waits. hub-zz is unknown.</p>')
    expect(beads(out)).toEqual(['hub-ozxp.32', 'hub-ab'])
    expect(out).toContain('class="md-bead md-bead-agent" data-bead="hub-ozxp.32"')
    expect(out).toContain('class="md-bead" data-bead="hub-ab"')
    expect(out).toContain('title="Open the agent on hub-ozxp.32: Title of hub-ozxp.32"')
    expect(out).toContain('hub-zz is unknown')
  })
  it('keeps a sentence’s final dot out of the id', () => {
    expect(link('<p>Closed hub-ab.</p>')).toMatch(/>hub-ab<\/span>\.<\/p>$/)
  })
  it('never links part of a longer word, a path, a flag or a branch', () => {
    for (const text of ['xhub-ab', 'hub-ab-7', 'src/hub-ab', '--hub-ab', 'tj/hub-ab-fix', 'a@hub-ab', 'hub-ab_x']) {
      expect(beads(link(`<p>${text}</p>`))).toEqual([])
    }
  })
  it('makes inline code that is only an id the link, and leaves other code alone', () => {
    const out = link('<p><code>hub-cd</code> and <code>bd show hub-cd</code></p>')
    expect(out).toContain('<span class="md-bead" data-bead="hub-cd" role="link" tabindex="0" title="Open hub-cd on the Board: Title of hub-cd"><code>hub-cd</code></span>')
    expect(beads(out)).toEqual(['hub-cd'])
    // A code span wherdr took for a path is a bead link all the same.
    expect(beads(link('<p><code class="md-path" data-k="path">hub-ab</code></p>'))).toEqual(['hub-ab'])
  })
  it('never touches links, buttons, code blocks, commands or attributes', () => {
    for (const html of [
      '<p><a href="https://x/hub-ab">hub-ab</a></p>',
      '<div class="code-block"><pre><code>hub-ab</code></pre></div>',
      '<p><code class="md-cmd" data-cmd="bd close hub-ab">hub-ab</code></p>',
      '<button type="button">hub-ab</button>',
      '<p title="hub-ab">x</p>',
    ]) expect(link(html)).toBe(html)
  })
  it('sends a bead whose agent is this conversation to the Board', () => {
    expect(link('<p>hub-ozxp.32</p>', 'w5:p2')).toContain('class="md-bead" data-bead="hub-ozxp.32"')
  })
  it('prefers the machine where an agent works on it, for a hub read from several', () => {
    const m = beadRefMap([ref('hub-ab', null, ''), ref('hub-ab', 'pod~w1:p1', 'pod'), ref('hub-ab', null, 'other')])
    expect(m.get('hub-ab')).toMatchObject({ machine: 'pod', pane: 'pod~w1:p1' })
  })
  it('changes nothing when no bead is known', () => {
    expect(linkBeadMentions('<p>hub-ab</p>', new Map())).toBe('<p>hub-ab</p>')
  })
})
