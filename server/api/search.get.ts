import type { ConversationHit, ConversationSearchResponse } from '../../shared/types'
import { hasTranscript } from '../../shared/agentKind'
import { SEARCH_DEADLINE_MS, SEARCH_MAX_RESULTS } from '../utils/conversationSearch'
import { getState } from '../utils/state'
import { machineOfPane } from '../utils/machines'
import { spaceTitle } from '../../shared/displayTitles'
import { searchTasks } from '../../shared/taskSearch'
import { boardSearchables } from '../utils/tasksBackend'

// The Board's tasks are waited for this long at most; past it, their last list.
const TASKS_DEADLINE_MS = 1500

export default defineApi(async (event): Promise<ConversationSearchResponse> => {
  const query = String(getQuery(event).q || '').trim().slice(0, 100)
  if (query.length < 2) return { hits: [], limited: false }
  // Read once for this search, alongside the conversations.
  const tasks = boardSearchables(TASKS_DEADLINE_MS).then(boards => searchTasks(boards, query).hits, () => [])
  const panes = getState().panes.filter(p => hasTranscript(p.agent) &&
    (!machineOfPane(p.id) || machineOfPane(p.id)?.status === 'online'))
  const deadline = Date.now() + SEARCH_DEADLINE_MS
  const hits: ConversationHit[] = []
  let limited = false
  let next = 0
  async function worker() {
    while (next < panes.length && hits.length < SEARCH_MAX_RESULTS && Date.now() < deadline) {
      const p = panes[next++]!
      const machine = machineOfPane(p.id)
      if (!machine) continue
      try {
        let timer: ReturnType<typeof setTimeout> | undefined
        const result = await Promise.race([
          machine.transcripts.search(p, query, deadline),
          new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), Math.max(0, deadline - Date.now())) }),
        ]).finally(() => clearTimeout(timer))
        if (!result) { limited = true; break }
        limited ||= result.limited
        for (const hit of result.hits) {
          if (hits.length >= SEARCH_MAX_RESULTS) { limited = true; break }
          const title = spaceTitle(p, getState().workspaces.find(w => w.id === p.workspace))
          hits.push({ ...hit, pane: p.id, agent: result.kind || p.agent!, title })
        }
      } catch { limited = true }
    }
  }
  await Promise.all([worker(), worker(), worker()])
  if (next < panes.length) limited = true
  hits.sort((a, b) => Date.parse(b.ts || '') - Date.parse(a.ts || ''))
  return { hits, limited, tasks: await tasks }
})
