// Start-up data the server writes into index.html (same response as the page, so never stale).
// Absent under the Vite dev server, which serves its own index.html; callers then use the API.

interface Bootstrap {
  version: string
  turnstile_site_key: string | null
}

function read(): Bootstrap | null {
  try {
    const el = document.getElementById('ll-bootstrap')
    return el?.textContent ? (JSON.parse(el.textContent) as Bootstrap) : null
  } catch {
    return null
  }
}

export const boot = read()
