import { createHash, timingSafeEqual } from 'node:crypto'
import { createReadStream, existsSync } from 'node:fs'
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify'
import QRCode from 'qrcode'
import type { Client, Config } from './config.js'
import type { Db } from './db.js'
import { GatewayError, type Gateway } from './gateway.js'
import { isGroupJid, normalizePhone } from './phone.js'

const digest = (s: string) => createHash('sha256').update(s).digest()

export function buildServer(cfg: Config, db: Db, gateway: Gateway, logger: boolean | object = false): FastifyInstance {
  const app = Fastify({ logger, bodyLimit: 64 * 1024 })
  const keys = cfg.clients.map((c) => ({ client: c, hash: digest(c.apiKey) }))
  const clientOf = new WeakMap<FastifyRequest, Client>()

  const authenticate = (req: FastifyRequest): Client | null => {
    const m = /^Bearer (.+)$/.exec(req.headers.authorization || '')
    if (!m) return null
    const given = digest(m[1]!)
    let found: Client | null = null
    for (const k of keys) if (timingSafeEqual(k.hash, given)) found = k.client
    return found
  }

  const fail = (status: number, code: string, message: string) => new GatewayError(status, code, message)

  app.setErrorHandler((err: Error & { statusCode?: number }, req, reply) => {
    if (err instanceof GatewayError) return reply.code(err.status).send({ error: err.code, message: err.message })
    const status = err.statusCode && err.statusCode < 500 ? err.statusCode : 500
    if (status === 500) req.log.error(err)
    return reply.code(status).send({ error: status === 500 ? 'internal' : 'bad_request', message: status === 500 ? 'Internal error' : err.message })
  })

  app.get('/health', async () => ({ ok: true, session: gateway.status().state }))

  app.register(async (v1) => {
    v1.addHook('onRequest', async (req) => {
      const client = authenticate(req)
      if (!client) throw fail(401, 'unauthorized', 'Missing or invalid API key')
      clientOf.set(req, client)
    })
    const client = (req: FastifyRequest) => clientOf.get(req)!
    const admin = (req: FastifyRequest) => {
      if (!client(req).admin) throw fail(403, 'forbidden', 'This client may not manage the session')
    }
    const phoneParam = (req: FastifyRequest) => {
      const phone = normalizePhone((req.params as { phone: string }).phone, cfg.defaultCountryCode)
      if (!phone) throw fail(400, 'invalid_phone', 'Phone number is not valid')
      return phone
    }

    // --- session (pairing) ---

    v1.get('/session', async (req) => {
      admin(req)
      const s = gateway.status()
      return {
        state: s.state,
        phone: s.phone,
        qr: s.qr,
        qrImage: s.qr ? await QRCode.toDataURL(s.qr, { margin: 2, width: 320 }) : null,
        pendingWebhooks: db.pendingCount(client(req).id),
      }
    })

    v1.post('/session/logout', async (req) => {
      admin(req)
      await gateway.transport?.logout()
      return { ok: true }
    })

    // --- tracked chats ---

    v1.get('/chats', async (req) => ({ chats: db.listTracked(client(req).id).filter((c) => !isGroupJid(c.phone)) }))

    v1.put('/chats/:phone', async (req) => {
      const phone = phoneParam(req)
      const label = (req.body as { label?: unknown } | null)?.label
      if (label !== undefined && label !== null && (typeof label !== 'string' || label.length > 200)) {
        throw fail(400, 'invalid_label', 'label must be a string of up to 200 characters')
      }
      return db.track(client(req).id, phone, typeof label === 'string' && label ? label : null)
    })

    v1.delete('/chats/:phone', async (req) => {
      if (!gateway.untrack(client(req).id, phoneParam(req))) throw fail(404, 'not_found', 'Chat is not tracked')
      return { ok: true }
    })

    // --- groups: read only. The list of the account's groups is private, so it is for admin clients. ---

    const groupParam = (req: FastifyRequest) => {
      const id = (req.params as { id: string }).id
      if (!isGroupJid(id)) throw fail(400, 'invalid_group', 'Group id is not valid')
      return id
    }

    v1.get('/groups', async (req) => {
      admin(req)
      return { groups: await gateway.groups(client(req).id) }
    })

    v1.put('/groups/:id', async (req) => {
      admin(req)
      const id = groupParam(req)
      const label = (req.body as { label?: unknown } | null)?.label
      if (label !== undefined && label !== null && (typeof label !== 'string' || label.length > 200)) {
        throw fail(400, 'invalid_label', 'label must be a string of up to 200 characters')
      }
      const t = db.track(client(req).id, id, typeof label === 'string' && label ? label : null)
      return { id: t.phone, label: t.label, trackedAt: t.trackedAt }
    })

    v1.delete('/groups/:id', async (req) => {
      admin(req)
      if (!gateway.untrack(client(req).id, groupParam(req))) throw fail(404, 'not_found', 'Group is not tracked')
      return { ok: true }
    })

    // --- sending ---

    v1.post('/messages', async (req) => {
      const body = (req.body ?? {}) as { phone?: unknown; text?: unknown }
      if (typeof body.phone !== 'string') throw fail(400, 'invalid_phone', 'phone is required')
      const phone = normalizePhone(body.phone, cfg.defaultCountryCode)
      if (!phone) throw fail(400, 'invalid_phone', 'Phone number is not valid')
      if (typeof body.text !== 'string' || !body.text.trim() || body.text.length > 4096) {
        throw fail(400, 'invalid_text', 'text is required (up to 4096 characters)')
      }
      return { phone, ...(await gateway.send(client(req).id, phone, body.text)) }
    })

    // --- media ---

    v1.get('/media/:id', async (req, reply) => {
      const row = db.getMedia((req.params as { id: string }).id)
      if (!row || !db.getTracked(client(req).id, row.phone) || !existsSync(row.path)) {
        throw fail(404, 'not_found', 'Media not found or expired')
      }
      reply.header('content-type', row.mime).header('content-length', row.size).header('cache-control', 'private, no-store')
      if (row.filename) {
        reply.header('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(row.filename)}`)
      }
      return reply.send(createReadStream(row.path))
    })
  }, { prefix: '/v1' })

  return app
}
