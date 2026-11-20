import { getContentType, normalizeMessageContent, type WAMessage } from 'baileys'

export type MessageKind = 'text' | 'audio' | 'image' | 'video' | 'document' | 'sticker' | 'location' | 'contact' | 'other'

export type MediaInfo = {
  mime: string
  filename: string | null
  /** Size announced by the sender, before download. */
  size: number | null
  /** Audio / video length in seconds. */
  seconds: number | null
  /** True for a voice note (as opposed to a forwarded audio file). */
  voice: boolean
}

export type NormalizedMessage = {
  id: string
  direction: 'in' | 'out'
  /** Unix seconds, as reported by WhatsApp. */
  timestamp: number
  kind: MessageKind
  /** Message text or media caption. */
  text: string | null
  senderName: string | null
  media: MediaInfo | null
  location: { latitude: number; longitude: number; name: string | null } | null
  contact: { name: string | null; vcard: string | null } | null
}

const toNum = (v: unknown): number | null => {
  if (v === null || v === undefined) return null
  const n = typeof v === 'number' ? v : Number(String(v))
  return Number.isFinite(n) ? n : null
}

const DOWNLOADABLE = new Set<MessageKind>(['audio', 'image', 'video', 'document', 'sticker'])
export const hasDownloadableMedia = (m: NormalizedMessage) => DOWNLOADABLE.has(m.kind) && m.media !== null

/**
 * Reduces a Baileys message to the fields clients need.
 * Returns null for things that are not a chat message (reactions, edits,
 * deletions, receipts and other protocol traffic).
 */
export function normalizeMessage(msg: WAMessage): NormalizedMessage | null {
  const id = msg.key?.id
  const content = normalizeMessageContent(msg.message)
  if (!id || !content) return null
  const type = getContentType(content)
  if (!type || type === 'protocolMessage' || type === 'reactionMessage' || type === 'senderKeyDistributionMessage') {
    return null
  }

  const base: NormalizedMessage = {
    id,
    direction: msg.key.fromMe ? 'out' : 'in',
    timestamp: toNum(msg.messageTimestamp) ?? Math.floor(Date.now() / 1000),
    kind: 'other',
    text: null,
    senderName: msg.key.fromMe ? null : msg.pushName || null,
    media: null,
    location: null,
    contact: null,
  }
  const media = (
    m: { mimetype?: string | null; fileLength?: unknown; seconds?: number | null },
    fallbackMime: string,
    extra: Partial<MediaInfo> = {},
  ): MediaInfo => ({
    mime: (m.mimetype || fallbackMime).split(';')[0]!.trim(),
    filename: null,
    size: toNum(m.fileLength),
    seconds: m.seconds ?? null,
    voice: false,
    ...extra,
  })

  switch (type) {
    case 'conversation':
      return { ...base, kind: 'text', text: content.conversation || '' }
    case 'extendedTextMessage':
      return { ...base, kind: 'text', text: content.extendedTextMessage?.text || '' }
    case 'audioMessage': {
      const m = content.audioMessage!
      return { ...base, kind: 'audio', media: media(m, 'audio/ogg', { voice: m.ptt === true }) }
    }
    case 'imageMessage': {
      const m = content.imageMessage!
      return { ...base, kind: 'image', text: m.caption || null, media: media(m, 'image/jpeg') }
    }
    case 'videoMessage': {
      const m = content.videoMessage!
      return { ...base, kind: 'video', text: m.caption || null, media: media(m, 'video/mp4') }
    }
    case 'documentMessage': {
      const m = content.documentMessage!
      return {
        ...base,
        kind: 'document',
        text: m.caption || null,
        media: media(m, 'application/octet-stream', { filename: m.fileName || m.title || null }),
      }
    }
    case 'stickerMessage':
      return { ...base, kind: 'sticker', media: media(content.stickerMessage!, 'image/webp') }
    case 'locationMessage': {
      const m = content.locationMessage!
      return {
        ...base,
        kind: 'location',
        location: { latitude: m.degreesLatitude ?? 0, longitude: m.degreesLongitude ?? 0, name: m.name || m.address || null },
      }
    }
    case 'contactMessage': {
      const m = content.contactMessage!
      return { ...base, kind: 'contact', contact: { name: m.displayName || null, vcard: m.vcard || null } }
    }
    default:
      return base
  }
}
