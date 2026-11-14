// Background tasks: Herdr polling (session.snapshot every second), VAPID
// keys, notifications from `herdr notification show`, the phone address
// `tailscale serve` publishes (server/utils/phone.ts), purge of photos and attached files older than 7 days, and of the pasted texts kept for 30 days.
export default defineNitroPlugin((nitroApp) => {
  initVapid()
  startMachines()
  startPolling()
  // The Board read once, so the first one opened after a restart finds it read.
  const warm = setTimeout(warmBoard, 2000)
  warm.unref?.()
  startNotices()
  startPaneSizes()
  onTailnetName(adoptTailnetName)
  startTailnetWatch()
  cleanUploads()
  cleanAttachments()
  purgePastes()
  const purge = setInterval(() => { cleanUploads(); cleanAttachments(); purgePastes() }, 6 * 3600 * 1000)
  log(`herdr-web — socket ${HERDR_SOCK}${HERDR_SESSION ? ` (session ${HERDR_SESSION})` : ''}`)
  nitroApp.hooks.hook('close', () => {
    stopPolling()
    stopNotices()
    stopPaneSizes()
    stopTailnetWatch()
    stopMachines()
    clearInterval(purge)
  })
})
