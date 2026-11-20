import { DatabaseSync } from 'node:sqlite'

export type TrackedChat = { phone: string; label: string | null; trackedAt: number }
export type OutboxRow = { id: number; clientId: string; payload: string; attempts: number; createdAt: number }
export type MediaRow = {
  id: string
  phone: string
  path: string
  mime: string
  filename: string | null
  size: number
  createdAt: number
}

/**
 * The gateway is a relay, not an archive: it keeps the list of tracked chats,
 * webhooks that were not delivered yet, and media files until they expire.
 */
export class Db {
  private db: DatabaseSync

  constructor(file: string) {
    this.db = new DatabaseSync(file)
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS tracked_chats (
        client_id TEXT NOT NULL,
        phone TEXT NOT NULL,
        label TEXT,
        tracked_at INTEGER NOT NULL,
        PRIMARY KEY (client_id, phone)
      );
      CREATE INDEX IF NOT EXISTS tracked_phone ON tracked_chats (phone);
      CREATE TABLE IF NOT EXISTS outbox (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        client_id TEXT NOT NULL,
        payload TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS media (
        id TEXT PRIMARY KEY,
        phone TEXT NOT NULL,
        path TEXT NOT NULL,
        mime TEXT NOT NULL,
        filename TEXT,
        size INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );
    `)
  }

  close() {
    this.db.close()
  }

  // --- tracked chats ---

  /** Keeps the original tracked_at when the chat is already tracked. */
  track(clientId: string, phone: string, label: string | null, now = Date.now()): TrackedChat {
    this.db
      .prepare(
        `INSERT INTO tracked_chats (client_id, phone, label, tracked_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (client_id, phone) DO UPDATE SET label = excluded.label`,
      )
      .run(clientId, phone, label, now)
    return this.getTracked(clientId, phone)!
  }

  untrack(clientId: string, phone: string): boolean {
    return this.db.prepare('DELETE FROM tracked_chats WHERE client_id = ? AND phone = ?').run(clientId, phone).changes > 0
  }

  getTracked(clientId: string, phone: string): TrackedChat | null {
    const r = this.db
      .prepare('SELECT phone, label, tracked_at AS trackedAt FROM tracked_chats WHERE client_id = ? AND phone = ?')
      .get(clientId, phone)
    return (r as TrackedChat | undefined) ?? null
  }

  listTracked(clientId: string): TrackedChat[] {
    return this.db
      .prepare('SELECT phone, label, tracked_at AS trackedAt FROM tracked_chats WHERE client_id = ? ORDER BY tracked_at')
      .all(clientId) as TrackedChat[]
  }

  /** Clients tracking this phone, with the moment each one started. */
  trackersOf(phone: string): { clientId: string; trackedAt: number }[] {
    return this.db
      .prepare('SELECT client_id AS clientId, tracked_at AS trackedAt FROM tracked_chats WHERE phone = ?')
      .all(phone) as { clientId: string; trackedAt: number }[]
  }

  isTrackedByAnyone(phone: string): boolean {
    return this.db.prepare('SELECT 1 FROM tracked_chats WHERE phone = ? LIMIT 1').get(phone) !== undefined
  }

  // --- outbox ---

  enqueue(clientId: string, payload: unknown, now = Date.now()) {
    this.db
      .prepare('INSERT INTO outbox (client_id, payload, next_attempt_at, created_at) VALUES (?, ?, ?, ?)')
      .run(clientId, JSON.stringify(payload), now, now)
  }

  /** Oldest pending row of the client, only if it is due (keeps per-client order). */
  nextDue(clientId: string, now = Date.now()): OutboxRow | null {
    const r = this.db
      .prepare(
        `SELECT id, client_id AS clientId, payload, attempts, created_at AS createdAt, next_attempt_at AS nextAttemptAt
         FROM outbox WHERE client_id = ? ORDER BY id LIMIT 1`,
      )
      .get(clientId) as (OutboxRow & { nextAttemptAt: number }) | undefined
    return r && r.nextAttemptAt <= now ? r : null
  }

  delivered(id: number) {
    this.db.prepare('DELETE FROM outbox WHERE id = ?').run(id)
  }

  failed(id: number, nextAttemptAt: number) {
    this.db.prepare('UPDATE outbox SET attempts = attempts + 1, next_attempt_at = ? WHERE id = ?').run(nextAttemptAt, id)
  }

  pendingCount(clientId: string): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM outbox WHERE client_id = ?').get(clientId) as { n: number }).n
  }

  purgeOutbox(olderThan: number): number {
    return Number(this.db.prepare('DELETE FROM outbox WHERE created_at < ?').run(olderThan).changes)
  }

  // --- media ---

  addMedia(m: MediaRow) {
    this.db
      .prepare('INSERT INTO media (id, phone, path, mime, filename, size, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(m.id, m.phone, m.path, m.mime, m.filename, m.size, m.createdAt)
  }

  getMedia(id: string): MediaRow | null {
    const r = this.db
      .prepare('SELECT id, phone, path, mime, filename, size, created_at AS createdAt FROM media WHERE id = ?')
      .get(id)
    return (r as MediaRow | undefined) ?? null
  }

  /** Removes expired rows and returns their file paths for deletion. */
  purgeMedia(olderThan: number): string[] {
    const rows = this.db.prepare('SELECT path FROM media WHERE created_at < ?').all(olderThan) as { path: string }[]
    this.db.prepare('DELETE FROM media WHERE created_at < ?').run(olderThan)
    return rows.map((r) => r.path)
  }

  /** Media of a phone nobody tracks any more. */
  purgeMediaOf(phone: string): string[] {
    const rows = this.db.prepare('SELECT path FROM media WHERE phone = ?').all(phone) as { path: string }[]
    this.db.prepare('DELETE FROM media WHERE phone = ?').run(phone)
    return rows.map((r) => r.path)
  }
}
