/// <reference path="../pb_data/types.d.ts" />
// Keep PocketBase's public address (used in emails and OAuth2 redirects) in step with
// PB_APP_URL, e.g. https://layerlift.example.com/pb, since browsers reach it through LayerLift.
onBootstrap((e) => {
  e.next()
  const url = $os.getenv("PB_APP_URL")
  if (!url) return
  const settings = e.app.settings()
  if (settings.meta.appURL !== url) {
    settings.meta.appURL = url
    e.app.save(settings)
  }
})
