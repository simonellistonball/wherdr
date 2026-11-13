// Beads named in a reply (a quartermaster coordinator's report): a link to the
// agent at work on one, else to the bead on the Board (ChatView, utils/beadLinks.ts).
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mockNuxtImport, mountSuspended, registerEndpoint } from '@nuxt/test-utils/runtime'
import ChatView from '~/components/ChatView.vue'
import { herdrState } from '~/composables/useHerdr'
import { resetBeadRefs } from '~/composables/useBeadRefs'
import type { ChatItem, Pane } from '#shared/types'
import type { BeadRef } from '#shared/beadsTasks'

const { go } = vi.hoisted(() => ({ go: vi.fn() }))
mockNuxtImport('navigateTo', () => go)

const pane = (id: string, name: string | null): Pane => ({ id, workspace: id.split(':')[0]!, tab: `${id.split(':')[0]}:t1`, tabLabel: null, agent: 'claude', name, label: null, status: 'idle', title: null, cwd: '/home/user/web', agentSession: null })
const coordinator = pane('w1:p1', 'quartermaster')
const worker = pane('w5:p2', 'hub-ozxp-32')
const items: ChatItem[] = [{ role: 'assistant', text: 'Dispatched hub-ozxp.32. `hub-ab` waits for review; self-hosted is not a bead.', ts: null }]
const refs: BeadRef[] = [
  { machine: '', id: 'support/hub-ozxp.32', bead: 'hub-ozxp.32', title: 'PII guard', group: 'working', pane: 'w5:p2' },
  { machine: 'pod', id: 'messages/hub-ab', bead: 'hub-ab', title: 'Retention', group: 'todo', pane: null },
]
let refReads = 0
registerEndpoint('/api/chat', () => ({ available: true, token: 'beads', file: '/home/user/t.jsonl', items }))
registerEndpoint('/api/tasks/bead-refs', () => { refReads++; return { version: 'v1', refs } })

describe('bead links in a conversation', () => {
  afterEach(() => { herdrState.value = { ok: false, workspaces: [], panes: [] }; resetBeadRefs(); go.mockClear() })

  it('links known beads only, and opens the agent at work or the bead on the Board', async () => {
    herdrState.value = { ok: true, workspaces: [], panes: [coordinator, worker] }
    const w = await mountSuspended(ChatView, { props: { pane: coordinator, localQueued: [] } })
    try {
      await expect.poll(() => w.findAll('.md-bead').length).toBe(2)
      const [agent, board] = w.findAll('.md-bead')
      expect(agent!.attributes('data-bead')).toBe('hub-ozxp.32')
      expect(agent!.classes()).toContain('md-bead-agent')
      expect(board!.attributes('data-bead')).toBe('hub-ab')
      expect(board!.find('code').text()).toBe('hub-ab')
      expect(w.find('.msg-ai').text()).toContain('self-hosted is not a bead')
      await agent!.trigger('click')
      expect(go).toHaveBeenLastCalledWith('/a/w5%3Ap2')
      await board!.trigger('keydown', { key: 'Enter' })
      expect(go).toHaveBeenLastCalledWith({ path: '/board', query: { machine: 'pod', task: 'messages/hub-ab' } })
      expect(refReads).toBe(1)
    } finally { w.unmount() }
  })

  it('opens the Board when the bead’s agent is gone', async () => {
    herdrState.value = { ok: true, workspaces: [], panes: [coordinator] }
    const w = await mountSuspended(ChatView, { props: { pane: coordinator, localQueued: [] } })
    try {
      await expect.poll(() => w.findAll('.md-bead').length).toBe(2)
      await w.find('.md-bead').trigger('click')
      expect(go).toHaveBeenLastCalledWith({ path: '/board', query: { machine: '', task: 'support/hub-ozxp.32' } })
    } finally { w.unmount() }
  })
})
