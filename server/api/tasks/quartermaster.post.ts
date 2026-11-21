// quartermaster's Resume and Resolve on a hub bead:
// `{ machine, id, action: 'resume' | 'resolve', force?: true }` (force: Resolve only).
// See server/utils/beadsTasks.ts beadQuartermaster.
import { boardQuartermaster } from '../../utils/tasksBackend'

export default defineApi((_event, b) => boardQuartermaster(b.machine ?? '', b.id, b.action, b.force))
