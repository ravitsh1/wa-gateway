import { randomUUID } from 'node:crypto'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { WAMessage } from 'baileys'
import type { Config } from './config.js'
import type { Db } from './db.js'
import { hasDownloadableMedia, normalizeMessage } from './normalize.js'
import { isGroupJid } from './phone.js'

export type SessionState = 'starting' | 'qr' | 'connected' | 'disconnected' | 'logged_out'
export type SessionStatus = { state: SessionState; qr: string | null; phone: string | null }
export type GroupInfo = { id: string; name: string; participants: number }

/** What the gateway needs from the WhatsApp connection. */
export interface Transport {
  status(): SessionStatus
  sendText(phone: string, text: string): Promise<string>
  /** The groups the account is a member of. */
  groups(): Promise<GroupInfo[]>
  logout(): Promise<void>
}

type Log = {
  info: (o: object, m?: string) => void
  warn: (o: object, m?: string) => void
  error: (o: object, m?: string) => void
}

export class GatewayError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message)
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export class Gateway {
  transport: Transport | null = null
  /** Called after an event was queued (wakes the webhook worker). */
  onQueued: () => void = () => {}

  private mediaDir: string
  private seen = new Set<string>()
  private sentViaApi = new Set<string>()
  private sendChain: Promise<unknown> = Promise.resolve()
  private lastSendAt = 0
  private lastState: SessionState | null = null

  constructor(
    private cfg: Config,
    private db: Db,
    private log: Log,
  ) {
    this.mediaDir = join(cfg.dataDir, 'media')
    mkdirSync(this.mediaDir, { recursive: true, mode: 0o700 })
  }

  /** Remembers an id; false when it was already there. Bounded, oldest dropped first. */
  private remember(set: Set<string>, id: string, max = 5000): boolean {
    if (set.has(id)) return false
    set.add(id)
    if (set.size > max) set.delete(set.values().next().value!)
    return true
  }

  /**
   * Entry point for every message the connection sees in a 1:1 chat or a group (both directions).
   * A chat is named by its phone, a group by its address; both are tracked in the same list.
   * Messages of chats nobody tracks are dropped here: nothing is stored or logged.
   */
  async onMessage(phone: string, msg: WAMessage, download: () => Promise<Buffer>) {
    const group = isGroupJid(phone)
    const trackers = this.db.trackersOf(phone)
    if (trackers.length === 0) return
    const m = normalizeMessage(msg)
    if (!m) return
    // Only messages from the moment the chat was tracked; older ones (history, backlog) are ignored.
    const recipients = trackers.filter((t) => (m.timestamp + 1) * 1000 > t.trackedAt)
    if (recipients.length === 0) return
    if (!this.remember(this.seen, m.id)) return

    let media: Record<string, unknown> | null = null
    if (m.media) {
      media = { ...m.media, id: null, url: null, error: null }
      if (hasDownloadableMedia(m)) {
        if (group && (m.kind === 'video' || m.kind === 'sticker')) {
          // a group is read for what it announces; its videos and stickers are not fetched
          media.error = 'skipped'
        } else if (m.media.size !== null && m.media.size > this.cfg.maxMediaBytes) {
          media.error = 'too_large'
        } else {
          try {
            const buf = await download()
            if (buf.length > this.cfg.maxMediaBytes) {
              media.error = 'too_large'
            } else {
              const id = randomUUID()
              const path = join(this.mediaDir, id)
              writeFileSync(path, buf, { mode: 0o600 })
              this.db.addMedia({
                id,
                phone,
                path,
                mime: m.media.mime,
                filename: m.media.filename,
                size: buf.length,
                createdAt: Date.now(),
              })
              media.id = id
              media.size = buf.length
              media.url = `${this.cfg.publicUrl}/v1/media/${id}`
            }
          } catch (e) {
            media.error = 'download_failed'
            this.log.warn({ err: e instanceof Error ? e.message : String(e) }, 'media download failed')
          }
        }
      }
    }

    const message = { ...m, media, sentViaApi: m.direction === 'out' && this.sentViaApi.has(m.id) }
    for (const r of recipients) {
      this.db.enqueue(r.clientId, { event: 'message', deliveryId: randomUUID(), chat: group ? { group: phone } : { phone }, message })
    }
    this.onQueued()
  }

  /** Tells admin clients when the session state changes (not on every QR refresh). */
  onSession(status: SessionStatus) {
    if (status.state === this.lastState) return
    this.lastState = status.state
    this.log.info({ state: status.state }, 'session state')
    for (const c of this.cfg.clients.filter((c) => c.admin)) {
      this.db.enqueue(c.id, {
        event: 'session',
        deliveryId: randomUUID(),
        session: { state: status.state, phone: status.phone },
      })
    }
    this.onQueued()
  }

  status(): SessionStatus {
    return this.transport?.status() ?? { state: 'starting', qr: null, phone: null }
  }

  /**
   * Sends a text to a chat the calling client tracks. Sends are serialized
   * with a minimum gap, so a burst from a client never reaches WhatsApp as a burst.
   */
  send(clientId: string, phone: string, text: string): Promise<{ id: string }> {
    if (!this.db.getTracked(clientId, phone)) {
      throw new GatewayError(403, 'chat_not_tracked', 'This chat is not tracked by this client')
    }
    if (!this.transport || this.transport.status().state !== 'connected') {
      throw new GatewayError(503, 'not_connected', 'WhatsApp session is not connected')
    }
    const run = async () => {
      const wait = this.lastSendAt + this.cfg.sendMinIntervalMs - Date.now()
      if (wait > 0) await sleep(wait)
      const transport = this.transport
      if (!transport || transport.status().state !== 'connected') {
        throw new GatewayError(503, 'not_connected', 'WhatsApp session is not connected')
      }
      try {
        const id = await transport.sendText(phone, text)
        this.remember(this.sentViaApi, id)
        return { id }
      } finally {
        this.lastSendAt = Date.now()
      }
    }
    const p = this.sendChain.then(run, run)
    this.sendChain = p.catch(() => {})
    return p
  }

  /** The account's groups, each marked with whether the calling client tracks it. Asked from WhatsApp, not stored. */
  async groups(clientId: string): Promise<(GroupInfo & { tracked: boolean })[]> {
    if (!this.transport || this.transport.status().state !== 'connected') {
      throw new GatewayError(503, 'not_connected', 'WhatsApp session is not connected')
    }
    const tracked = new Set(this.db.listTracked(clientId).map((t) => t.phone))
    return (await this.transport.groups())
      .filter((g) => isGroupJid(g.id))
      .map((g) => ({ ...g, tracked: tracked.has(g.id) }))
      .sort((a, b) => a.name.localeCompare(b.name, 'he'))
  }

  untrack(clientId: string, phone: string): boolean {
    const removed = this.db.untrack(clientId, phone)
    if (removed && !this.db.isTrackedByAnyone(phone)) this.removeFiles(this.db.purgeMediaOf(phone))
    return removed
  }

  /** Drops undelivered events and media older than the retention window. */
  cleanup(now = Date.now()) {
    const cutoff = now - this.cfg.retentionHours * 3_600_000
    const dropped = this.db.purgeOutbox(cutoff)
    if (dropped > 0) this.log.warn({ dropped }, 'expired undelivered webhooks removed')
    this.removeFiles(this.db.purgeMedia(cutoff))
  }

  private removeFiles(paths: string[]) {
    for (const p of paths) rmSync(p, { force: true })
  }
}
