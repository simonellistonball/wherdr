// The beads conversations link to (app/utils/beadLinks.ts): GET
// /api/tasks/bead-refs, shared by every open conversation, read again at most
// every REFS_MS while one asks (the server answers `same` when nothing
// changed). With no beads board anywhere (`none`), asked again only after NONE_MS.
import type { BeadRef, BeadRefsReply } from '#shared/beadsTasks'
import { beadRefMap } from '~/utils/beadLinks'

const REFS_MS = 15_000
const NONE_MS = 5 * 60_000
export const beadRefs = shallowRef<Map<string, BeadRef>>(new Map())
let version = ''
let at = 0
let wait = REFS_MS
let reading: Promise<void> | null = null

export function loadBeadRefs(): Promise<void> {
  if (reading) return reading
  if (Date.now() - at < wait || offlineView.value) return Promise.resolve()
  reading = (async () => {
    try {
      const r = await api<BeadRefsReply>(`/api/tasks/bead-refs${version ? `?since=${encodeURIComponent(version)}` : ''}`)
      version = r.version
      if (!('same' in r)) {
        beadRefs.value = beadRefMap(r.refs)
        wait = r.none ? NONE_MS : REFS_MS
      }
    } catch { /* no links this time; the text stays as it is */ }
    finally { at = Date.now(); reading = null }
  })()
  return reading
}
// Tests start from nothing known.
export function resetBeadRefs() { beadRefs.value = new Map(); version = ''; at = 0; wait = REFS_MS; reading = null }
