import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import {
  Browsers,
  DisconnectReason,
  downloadMediaMessage,
  makeCacheableSignalKeyStore,
  makeWASocket,
  useMultiFileAuthState,
  type WAMessage,
  type WASocket,
} from 'baileys'
import { pino } from 'pino'
import type { Gateway, GroupInfo, SessionState, SessionStatus, Transport } from './gateway.js'
import { isGroupJid, isLidJid, jidToPhone, keyToPhone, phoneToJid } from './phone.js'

type Log = { info: (o: object, m?: string) => void; warn: (o: object, m?: string) => void }

/**
 * Holds the linked-device connection (the same mechanism as WhatsApp Web).
 * History sync is switched off and the account is not marked online, so the
 * phone keeps getting its notifications as usual.
 */
export class WhatsApp implements Transport {
  private sock: WASocket | null = null
  private state: SessionState = 'starting'
  private qr: string | null = null
  private phone: string | null = null
  private stopped = false
  private retry = 0
  private authDir: string
  // Library logs can include message metadata; keep only errors.
  private libLog = pino({ level: 'error' })
  private groupList: { at: number; groups: GroupInfo[] } | null = null

  constructor(
    dataDir: string,
    private gateway: Gateway,
    private log: Log,
  ) {
    this.authDir = join(dataDir, 'auth')
  }

  status(): SessionStatus {
    return { state: this.state, qr: this.qr, phone: this.phone }
  }

  private set(state: SessionState, qr: string | null = null) {
    this.state = state
    this.qr = qr
    this.gateway.onSession(this.status())
  }

  async start() {
    if (this.stopped) return
    mkdirSync(this.authDir, { recursive: true, mode: 0o700 })
    const { state, saveCreds } = await useMultiFileAuthState(this.authDir)
    const sock = makeWASocket({
      auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, this.libLog) },
      logger: this.libLog,
      browser: Browsers.ubuntu('Chrome'),
      markOnlineOnConnect: false,
      syncFullHistory: false,
      shouldSyncHistoryMessage: () => false,
      generateHighQualityLinkPreview: false,
    })
    this.sock = sock

    sock.ev.on('creds.update', saveCreds)

    sock.ev.on('connection.update', (u) => {
      if (u.qr) this.set('qr', u.qr)
      if (u.connection === 'open') {
        this.retry = 0
        this.phone = jidToPhone(sock.user?.id) ?? null
        this.set('connected')
      }
      if (u.connection === 'close') {
        if (this.sock !== sock) return
        this.sock = null
        const code = (u.lastDisconnect?.error as { output?: { statusCode?: number } } | undefined)?.output?.statusCode
        if (code === DisconnectReason.loggedOut) {
          // Unlinked from the phone: the stored keys are useless, start over with a new QR.
          rmSync(this.authDir, { recursive: true, force: true })
          this.phone = null
          this.set('logged_out')
        } else if (this.state !== 'qr') {
          this.set('disconnected')
        }
        if (this.stopped) return
        const delay = code === DisconnectReason.restartRequired ? 0 : Math.min(2000 * 2 ** this.retry++, 60_000)
        this.log.info({ code, delayMs: delay }, 'connection closed, reconnecting')
        setTimeout(() => void this.start().catch((e) => this.log.warn({ err: String(e) }, 'reconnect failed')), delay)
      }
    })

    sock.ev.on('messages.upsert', ({ messages }) => {
      for (const msg of messages) {
        void this.handle(sock, msg).catch((e) =>
          this.log.warn({ err: e instanceof Error ? e.message : String(e) }, 'message handling failed'),
        )
      }
    })
  }

  /** Resolves the chat to a phone number, or to the group's address; a status update, a channel or a broadcast list resolves to null and is ignored. */
  private async chatPhone(sock: WASocket, msg: WAMessage): Promise<string | null> {
    // a group is named by its own address; whether anyone tracks it is decided by the gateway
    if (isGroupJid(msg.key?.remoteJid)) return msg.key.remoteJid
    const direct = keyToPhone(msg.key)
    if (direct) return direct
    const jid = msg.key?.remoteJid
    if (isLidJid(jid)) return jidToPhone(await sock.signalRepository.lidMapping.getPNForLID(jid!))
    return null
  }

  private async handle(sock: WASocket, msg: WAMessage) {
    const phone = await this.chatPhone(sock, msg)
    if (!phone) return
    await this.gateway.onMessage(phone, msg, () =>
      downloadMediaMessage(msg, 'buffer', {}, { logger: this.libLog, reuploadRequest: sock.updateMediaMessage }),
    )
  }

  async sendText(phone: string, text: string): Promise<string> {
    if (!this.sock) throw new Error('not connected')
    const sent = await this.sock.sendMessage(phoneToJid(phone), { text })
    const id = sent?.key?.id
    if (!id) throw new Error('message was not sent')
    return id
  }

  /** Asked from WhatsApp each time, at most once a minute: the list is only needed when the owner picks groups to follow. */
  async groups(): Promise<GroupInfo[]> {
    if (!this.sock) throw new Error('not connected')
    if (this.groupList && Date.now() - this.groupList.at < 60_000) return this.groupList.groups
    const all = await this.sock.groupFetchAllParticipating()
    const groups = Object.values(all).map((g) => ({ id: g.id, name: g.subject || '', participants: g.participants?.length ?? 0 }))
    this.groupList = { at: Date.now(), groups }
    return groups
  }

  async logout() {
    if (this.sock) await this.sock.logout()
  }

  async stop() {
    this.stopped = true
    this.sock?.end(undefined)
    this.sock = null
  }
}
