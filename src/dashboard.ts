// Live browser dashboard: one small local HTTP server per project directory.
//
//   GET /           → dashboard.html (read on every request, so edits show on reload)
//   GET /log.jsonl  → the raw .auto/log.jsonl (404 until the first autoresearch_init)
//   GET /events     → Server-Sent Events:
//                       event "log"    → the log changed, re-fetch /log.jsonl
//                       event "status" → {running, command?, startedAt?}, sent on connect + on change
//
// Only listens on 127.0.0.1 and rejects any Host header other than
// 127.0.0.1:<port> / localhost:<port> (DNS-rebinding guard). Log changes are picked up by polling the file
// (fs.watchFile), so edits made outside this plugin show up too.

import { spawn } from "node:child_process"
import { readFile, stat } from "node:fs/promises"
import { unwatchFile, watchFile } from "node:fs"
import { createServer, type Server, type ServerResponse } from "node:http"
import { logPath } from "./state.ts"

export interface RunStatus {
  running: boolean
  command?: string
  startedAt?: number
}

interface Entry {
  server: Server
  url: string
  clients: Set<ServerResponse>
}

export class Dashboards {
  private servers = new Map<string, Entry>()
  /** Kept even without a server, so a dashboard opened mid-run shows "running" right away. */
  private statuses = new Map<string, RunStatus>()

  constructor(private readonly htmlPath: string) {}

  /** Start (or reuse) the dashboard for a directory and return its URL. */
  async open(directory: string): Promise<string> {
    const existing = this.servers.get(directory)
    if (existing) return existing.url

    const clients = new Set<ServerResponse>()
    let allowedHosts = new Set<string>()
    const server = createServer(async (req, res) => {
      // DNS-rebinding guard: a hostile page can point its own domain at 127.0.0.1,
      // but the browser still sends that domain in Host, so only accept our own names.
      if (!allowedHosts.has((req.headers.host ?? "").toLowerCase())) {
        res.writeHead(403).end()
        return
      }
      const path = new URL(req.url ?? "/", "http://127.0.0.1").pathname
      try {
        if (path === "/") {
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" })
          res.end(await readFile(this.htmlPath))
        } else if (path === "/log.jsonl") {
          const body = await readFile(logPath(directory)).catch(() => null)
          if (body === null) {
            res.writeHead(404).end()
            return
          }
          res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" })
          res.end(body)
        } else if (path === "/events") {
          res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
          })
          res.write("retry: 1000\n\n")
          send(res, "status", this.statuses.get(directory) ?? { running: false })
          clients.add(res)
          req.on("close", () => clients.delete(res))
        } else {
          res.writeHead(404).end()
        }
      } catch (err) {
        res.writeHead(500).end(String(err))
      }
    })

    const port = await new Promise<number>((resolve, reject) => {
      server.once("error", reject)
      server.listen(0, "127.0.0.1", () => {
        const address = server.address()
        if (address && typeof address === "object") resolve(address.port)
        else reject(new Error("dashboard server did not get a port"))
      })
    })
    allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`])

    // Poll the log once a second; the callback also fires when the file is first created.
    watchFile(logPath(directory), { interval: 1000 }, (curr, prev) => {
      if (curr.mtimeMs !== prev.mtimeMs || curr.size !== prev.size) {
        for (const c of clients) send(c, "log", Date.now())
      }
    })

    const entry: Entry = { server, url: `http://127.0.0.1:${port}/`, clients }
    this.servers.set(directory, entry)
    return entry.url
  }

  /** Tell open dashboards whether an experiment is running right now. */
  setStatus(directory: string, status: RunStatus): void {
    this.statuses.set(directory, status)
    const entry = this.servers.get(directory)
    if (entry) for (const c of entry.clients) send(c, "status", status)
  }

  /** URL of the open dashboard for a directory, or null if none is open. */
  isOpen(directory: string): string | null {
    return this.servers.get(directory)?.url ?? null
  }

  /** Stop one directory's dashboard. Returns false if none was open. */
  close(directory: string): boolean {
    const entry = this.servers.get(directory)
    if (!entry) return false
    this.servers.delete(directory)
    unwatchFile(logPath(directory))
    for (const c of entry.clients) c.end()
    entry.clients.clear()
    entry.server.close()
    // Drop idle keep-alive sockets too, so the port stops accepting right away.
    entry.server.closeAllConnections?.()
    return true
  }

  closeAll(): void {
    for (const directory of [...this.servers.keys()]) this.close(directory)
  }
}

function send(res: ServerResponse, event: string, data: unknown) {
  try {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
  } catch {
    // Client went away; its close handler removes it.
  }
}

/** Best effort: open the URL in the default browser on this machine. */
export function openInBrowser(url: string): void {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open"
  const child = spawn(cmd, [url], { detached: true, stdio: "ignore" })
  child.on("error", () => {}) // e.g. no xdg-open; the URL is still shown in the chat
  child.unref()
}

export async function logExists(directory: string): Promise<boolean> {
  return stat(logPath(directory)).then(
    () => true,
    () => false,
  )
}
