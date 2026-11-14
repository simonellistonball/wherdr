// A beads task's labels and notes: `{ machine, id, add?: string[], remove?: string[], note?: string }`.
// See server/utils/beadsTasks.ts editBead.
import { boardEditBead } from '../../utils/tasksBackend'

export default defineApi((_event, b) => boardEditBead(b.machine ?? '', b.id, { add: b.add, remove: b.remove, note: b.note }))
