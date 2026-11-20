import { createHmac, timingSafeEqual } from 'node:crypto'
import type { Client } from './config.js'
import type { Db } from './db.js'

type Log = { info: (o: object, m?: string) => void; warn: (o: object, m?: string) => void }

/** `sha256=<hex>` over `<timestamp>.<body>`; the timestamp is sent in X-WA-Timestamp (unix seconds). */
export function sign(secret: string, timestamp: string, body: string): string {
  return 'sha256=' + createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')
}

export function verify(secret: string, timestamp: string, body: string, signature: string): boolean {
  const a = Buffer.from(sign(secret, timestamp, body))
  const b = Buffer.from(signature)
  return a.length === b.length && timingSafeEqual(a, b)
}

/** 5s, 10s, 20s ... capped at one hour. */
export const backoffMs = (attempts: number) => Math.min(5000 * 2 ** attempts, 3_600_000)

/**
 * Delivers queued events to each client's webhook, in order.
 * A failed delivery blocks the client's later events until it succeeds or expires.
 */
export class WebhookWorker {
  private timer: NodeJS.Timeout | null = null
  private busy = false

  constructor(
    private db: Db,
    private clients: Client[],
    private log: Log,
    private fetchImpl: typeof fetch = fetch,
  ) {}

  start(intervalMs = 2000) {
    this.timer = setInterval(() => void this.tick(), intervalMs)
    this.timer.unref()
  }

  stop() {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /** Wakes the worker right after an event was queued. */
  kick() {
    void this.tick()
  }

  async tick() {
    if (this.busy) return
    this.busy = true
    try {
      await Promise.all(this.clients.map((c) => this.drain(c)))
    } finally {
      this.busy = false
    }
  }

  private async drain(client: Client) {
    for (;;) {
      const row = this.db.nextDue(client.id)
      if (!row) return
      const timestamp = String(Math.floor(Date.now() / 1000))
      let ok = false
      let detail = ''
      try {
        const res = await this.fetchImpl(client.webhookUrl, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'user-agent': 'wa-gateway',
            'x-wa-timestamp': timestamp,
            'x-wa-signature': sign(client.webhookSecret, timestamp, row.payload),
          },
          body: row.payload,
          signal: AbortSignal.timeout(15_000),
          redirect: 'error',
        })
        ok = res.ok
        detail = `HTTP ${res.status}`
      } catch (e) {
        detail = e instanceof Error ? e.message : String(e)
      }
      if (ok) {
        this.db.delivered(row.id)
        continue
      }
      this.db.failed(row.id, Date.now() + backoffMs(row.attempts))
      this.log.warn({ client: client.id, outboxId: row.id, attempts: row.attempts + 1, detail }, 'webhook delivery failed')
      return
    }
  }
}
