// The page's side of the geometry worker: one worker, requests matched to replies by id.
import type { RequestBody, Response } from './protocol'

type Pending = { resolve: (r: Response) => void; reject: (e: Error) => void }

let worker: Worker | null = null
const pending = new Map<number, Pending>()
let nextId = 1

function getWorker(): Worker {
  if (worker) return worker
  worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })
  worker.onmessage = (e: MessageEvent<Response>) => {
    const p = pending.get(e.data.id)
    if (!p) return
    pending.delete(e.data.id)
    if (e.data.kind === 'error') p.reject(new Error(e.data.message))
    else p.resolve(e.data)
  }
  worker.onerror = (e) => {
    for (const p of pending.values()) p.reject(new Error(e.message || 'The geometry worker failed to start.'))
    pending.clear()
    worker?.terminate()
    worker = null
  }
  return worker
}

export function request(body: RequestBody): Promise<Response> {
  const id = nextId++
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    getWorker().postMessage({ ...body, id })
  })
}

/** Offer bytes as a download. */
export function saveFile(name: string, data: Uint8Array, type = 'application/octet-stream') {
  const url = URL.createObjectURL(new Blob([data as BlobPart], { type }))
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}
