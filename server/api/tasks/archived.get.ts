// A machine's archived herdr-projects tasks: `?machine=<key>` (`list --json --archived`).
import { boardArchived } from '../../utils/tasksBackend'

export default defineApi(async (event) => {
  const q = getQuery(event)
  return boardArchived(q.machine ?? '')
})
