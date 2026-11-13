// The beads conversations can link to: `?since=<version>` replies `{ same: true }`
// when nothing changed. See server/utils/tasksBackend.ts boardBeadRefs.
import { boardBeadRefs } from '../../utils/tasksBackend'

export default defineApi(async (event) => {
  const since = getQuery(event).since
  return boardBeadRefs(typeof since === 'string' ? since.slice(0, 64) : undefined)
})
