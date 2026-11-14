// One herdr-projects task: `?machine=<key>&id=<repo>/<n>` (`details --json`).
import { boardTaskDetails } from '../../utils/tasksBackend'

export default defineApi(async (event) => {
  const q = getQuery(event)
  return boardTaskDetails(q.machine ?? '', q.id)
})
