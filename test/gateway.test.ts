import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { WAMessage } from 'baileys'
import { parseClients, type Config } from '../src/config.js'
import { Db } from '../src/db.js'
import { Gateway, type SessionStatus, type Transport } from '../src/gateway.js'
import { normalizeMessage } from '../src/normalize.js'
import { jidToPhone, normalizePhone } from '../src/phone.js'
import { buildServer } from '../src/server.js'
import { backoffMs, sign, verify, WebhookWorker } from '../src/webhooks.js'

const KEY_A = 'a'.repeat(40)
const KEY_B = 'b'.repeat(40)
const SECRET = 's'.repeat(40)
const quiet = { info() {}, warn() {}, error() {} }
const now = () => Math.floor(Date.now() / 1000)

function setup(webhookUrl = 'http://127.0.0.1:9/hook') {
  const dataDir = mkdtempSync(join(tmpdir(), 'wa-gw-'))
  const cfg: Config = {
    host: '127.0.0.1',
    port: 0,
    dataDir,
    publicUrl: 'http://gw.test',
    defaultCountryCode: '972',
    sendMinIntervalMs: 0,
    retentionHours: 72,
    maxMediaBytes: 1024,
    logLevel: 'silent',
    clients: [
      { id: 'mybase', apiKey: KEY_A, webhookUrl, webhookSecret: SECRET, admin: true },
      { id: 'portal', apiKey: KEY_B, webhookUrl, webhookSecret: SECRET, admin: false },
    ],
  }
  const db = new Db(join(dataDir, 'gw.db'))
  const gateway = new Gateway(cfg, db, quiet)
  const sent: { phone: string; text: string }[] = []
  const session: SessionStatus = { state: 'connected', qr: null, phone: '972500000000' }
  const transport: Transport = {
    status: () => session,
    sendText: async (phone, text) => {
      sent.push({ phone, text })
      return `SENT${sent.length}`
    },
    logout: async () => {},
  }
  gateway.transport = transport
  return { cfg, db, gateway, sent, session }
}

const textMsg = (id: string, text: string, opts: { fromMe?: boolean; ts?: number } = {}): WAMessage =>
  ({
    key: { id, remoteJid: '972501234567@s.whatsapp.net', fromMe: opts.fromMe ?? false },
    messageTimestamp: opts.ts ?? now(),
    pushName: 'Dana',
    message: { conversation: text },
  }) as WAMessage

const noDownload = async (): Promise<Buffer> => {
  throw new Error('download must not be called')
}
const events = (db: Db, clientId: string) => {
  const out: any[] = []
  for (let r = db.nextDue(clientId); r; r = db.nextDue(clientId)) {
    out.push(JSON.parse(r.payload))
    db.delivered(r.id)
  }
  return out
}

test('phone normalization', () => {
  assert.equal(normalizePhone('050-123 4567'), '972501234567')
  assert.equal(normalizePhone('+972 50 123 4567'), '972501234567')
  assert.equal(normalizePhone('00972501234567'), '972501234567')
  assert.equal(normalizePhone('123'), null)
  assert.equal(jidToPhone('972501234567:12@s.whatsapp.net'), '972501234567')
  assert.equal(jidToPhone('120363000000000000@g.us'), null)
  assert.equal(jidToPhone('1234567890123@lid'), null)
  assert.equal(jidToPhone('status@broadcast'), null)
})

test('normalizeMessage maps kinds and skips protocol traffic', () => {
  assert.equal(normalizeMessage(textMsg('1', 'שלום'))?.text, 'שלום')
  const voice = normalizeMessage({
    key: { id: '2', remoteJid: 'x', fromMe: false },
    messageTimestamp: 5,
    message: { audioMessage: { mimetype: 'audio/ogg; codecs=opus', ptt: true, seconds: 7, fileLength: 900 } },
  } as unknown as WAMessage)
  assert.deepEqual(voice?.media, { mime: 'audio/ogg', filename: null, size: 900, seconds: 7, voice: true })
  const doc = normalizeMessage({
    key: { id: '3', remoteJid: 'x', fromMe: false },
    message: { documentWithCaptionMessage: { message: { documentMessage: { fileName: 'logo.pdf', caption: 'הלוגו', mimetype: 'application/pdf' } } } },
  } as unknown as WAMessage)
  assert.equal(doc?.kind, 'document')
  assert.equal(doc?.media?.filename, 'logo.pdf')
  assert.equal(doc?.text, 'הלוגו')
  const reaction = { key: { id: '4', remoteJid: 'x' }, message: { reactionMessage: { text: '👍' } } } as unknown as WAMessage
  assert.equal(normalizeMessage(reaction), null)
  assert.equal(normalizeMessage({ key: { id: '5', remoteJid: 'x' } } as WAMessage), null)
})

test('untracked chats leave no trace', async () => {
  const { db, gateway } = setup()
  await gateway.onMessage('972501234567', textMsg('A1', 'private'), noDownload)
  assert.equal(db.pendingCount('mybase'), 0)
  assert.equal(db.pendingCount('portal'), 0)
})

test('tracked chat: delivered only to the tracking client, once, both directions', async () => {
  const { db, gateway } = setup()
  db.track('mybase', '972501234567', 'Dana', Date.now() - 60_000)
  await gateway.onMessage('972501234567', textMsg('B1', 'תעדכני לי את הלוגו'), noDownload)
  await gateway.onMessage('972501234567', textMsg('B1', 'תעדכני לי את הלוגו'), noDownload) // duplicate
  await gateway.onMessage('972501234567', textMsg('B2', 'בסדר', { fromMe: true }), noDownload)
  const ev = events(db, 'mybase')
  assert.equal(ev.length, 2)
  assert.equal(ev[0].event, 'message')
  assert.deepEqual(ev[0].chat, { phone: '972501234567' })
  assert.equal(ev[0].message.direction, 'in')
  assert.equal(ev[0].message.senderName, 'Dana')
  assert.equal(ev[1].message.direction, 'out')
  assert.equal(ev[1].message.sentViaApi, false)
  assert.equal(db.pendingCount('portal'), 0)
})

test('messages older than the tracking moment are ignored', async () => {
  const { db, gateway } = setup()
  db.track('mybase', '972501234567', null)
  await gateway.onMessage('972501234567', textMsg('C1', 'old', { ts: now() - 3600 }), noDownload)
  assert.equal(db.pendingCount('mybase'), 0)
})

test('media is stored, served to the tracking client only, and removed on untrack', async () => {
  const { cfg, db, gateway } = setup()
  db.track('mybase', '972501234567', null, Date.now() - 60_000)
  const img = (id: string, fileLength: number) =>
    ({
      key: { id, remoteJid: 'x', fromMe: false },
      messageTimestamp: now(),
      message: { imageMessage: { mimetype: 'image/png', caption: 'צילום מסך', fileLength } },
    }) as unknown as WAMessage
  await gateway.onMessage('972501234567', img('D1', 4), async () => Buffer.from('PNG!'))
  await gateway.onMessage('972501234567', img('D2', 999_999), noDownload)
  const [ok, big] = events(db, 'mybase')
  assert.equal(ok.message.text, 'צילום מסך')
  assert.equal(ok.message.media.url, `http://gw.test/v1/media/${ok.message.media.id}`)
  assert.equal(big.message.media.error, 'too_large')
  assert.equal(big.message.media.id, null)

  const app = buildServer(cfg, db, gateway)
  const url = `/v1/media/${ok.message.media.id}`
  const mine = await app.inject({ url, headers: { authorization: `Bearer ${KEY_A}` } })
  assert.equal(mine.statusCode, 200)
  assert.equal(mine.headers['content-type'], 'image/png')
  assert.equal(mine.body, 'PNG!')
  assert.equal((await app.inject({ url, headers: { authorization: `Bearer ${KEY_B}` } })).statusCode, 404)
  assert.equal((await app.inject({ url })).statusCode, 401)

  const path = db.getMedia(ok.message.media.id)!.path
  assert.equal(readFileSync(path, 'utf8'), 'PNG!')
  gateway.untrack('mybase', '972501234567')
  assert.equal(existsSync(path), false)
  await app.close()
})

test('HTTP API: auth, tracking, sending only to tracked chats', async () => {
  const { cfg, db, gateway, sent, session } = setup()
  const app = buildServer(cfg, db, gateway)
  const a = { authorization: `Bearer ${KEY_A}` }
  const b = { authorization: `Bearer ${KEY_B}` }

  assert.equal((await app.inject({ url: '/health' })).statusCode, 200)
  assert.equal((await app.inject({ url: '/v1/chats' })).statusCode, 401)
  assert.equal((await app.inject({ url: '/v1/chats', headers: { authorization: 'Bearer wrong' } })).statusCode, 401)
  assert.equal((await app.inject({ url: '/v1/session', headers: b })).statusCode, 403)
  assert.equal((await app.inject({ url: '/v1/session', headers: a })).json().state, 'connected')

  const put = await app.inject({ method: 'PUT', url: '/v1/chats/050-1234567', headers: a, payload: { label: 'Dana' } })
  assert.equal(put.statusCode, 200)
  assert.equal(put.json().phone, '972501234567')
  assert.equal((await app.inject({ method: 'PUT', url: '/v1/chats/12', headers: a })).statusCode, 400)
  assert.equal((await app.inject({ url: '/v1/chats', headers: a })).json().chats.length, 1)
  assert.equal((await app.inject({ url: '/v1/chats', headers: b })).json().chats.length, 0)

  const send = (headers: Record<string, string>, payload: object) => app.inject({ method: 'POST', url: '/v1/messages', headers, payload })
  const ok = await send(a, { phone: '0501234567', text: 'היי' })
  assert.equal(ok.statusCode, 200)
  assert.deepEqual(ok.json(), { phone: '972501234567', id: 'SENT1' })
  assert.deepEqual(sent, [{ phone: '972501234567', text: 'היי' }])
  assert.equal((await send(b, { phone: '0501234567', text: 'x' })).json().error, 'chat_not_tracked')
  assert.equal((await send(a, { phone: '0509999999', text: 'x' })).statusCode, 403)
  assert.equal((await send(a, { phone: '0501234567', text: '  ' })).statusCode, 400)
  assert.equal(sent.length, 1)

  // the echo of an API-sent message is flagged
  await gateway.onMessage('972501234567', textMsg('SENT1', 'היי', { fromMe: true }), noDownload)
  assert.equal(events(db, 'mybase').at(-1).message.sentViaApi, true)

  session.state = 'disconnected'
  assert.equal((await send(a, { phone: '0501234567', text: 'x' })).statusCode, 503)

  assert.equal((await app.inject({ method: 'DELETE', url: '/v1/chats/0501234567', headers: a })).statusCode, 200)
  assert.equal((await app.inject({ method: 'DELETE', url: '/v1/chats/0501234567', headers: a })).statusCode, 404)
  await app.close()
})

test('sends are spaced by the minimum interval', async () => {
  const { cfg, db, gateway, sent } = setup()
  cfg.sendMinIntervalMs = 120
  db.track('mybase', '972501234567', null)
  const t0 = Date.now()
  await Promise.all([1, 2, 3].map((i) => gateway.send('mybase', '972501234567', `m${i}`)))
  assert.deepEqual(sent.map((s) => s.text), ['m1', 'm2', 'm3'])
  assert.ok(Date.now() - t0 >= 240)
})

test('session changes reach admin clients only, once per state', () => {
  const { db, gateway } = setup()
  gateway.onSession({ state: 'qr', qr: 'one', phone: null })
  gateway.onSession({ state: 'qr', qr: 'two', phone: null })
  gateway.onSession({ state: 'connected', qr: null, phone: '972500000000' })
  assert.deepEqual(events(db, 'mybase').map((e) => e.session.state), ['qr', 'connected'])
  assert.equal(db.pendingCount('portal'), 0)
})

test('webhooks: signed, ordered, retried after failure', async () => {
  const received: { body: string; sig: string; ts: string }[] = []
  let failNext = true
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      if (failNext) {
        failNext = false
        res.statusCode = 500
        return res.end()
      }
      received.push({ body, sig: String(req.headers['x-wa-signature']), ts: String(req.headers['x-wa-timestamp']) })
      res.end('ok')
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const { cfg, db } = setup(`http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`)
  const worker = new WebhookWorker(db, [cfg.clients[0]!], quiet)
  db.enqueue('mybase', { n: 1 })
  db.enqueue('mybase', { n: 2 })

  await worker.tick()
  assert.equal(received.length, 0) // first attempt failed and blocks the queue
  assert.equal(db.pendingCount('mybase'), 2)
  assert.equal(db.nextDue('mybase'), null) // backing off
  assert.ok(db.nextDue('mybase', Date.now() + backoffMs(0) + 1000))

  db.failed(1, 0) // make it due again
  await worker.tick()
  assert.deepEqual(received.map((r) => JSON.parse(r.body).n), [1, 2])
  assert.equal(db.pendingCount('mybase'), 0)
  const r = received[0]!
  assert.equal(r.sig, sign(SECRET, r.ts, r.body))
  assert.ok(verify(SECRET, r.ts, r.body, r.sig))
  assert.equal(verify(SECRET, r.ts, r.body + ' ', r.sig), false)
  server.close()
})

test('cleanup drops expired webhooks and media', async () => {
  const { db, gateway } = setup()
  db.enqueue('mybase', { old: true }, Date.now() - 80 * 3_600_000)
  db.enqueue('mybase', { fresh: true })
  gateway.cleanup()
  assert.equal(db.pendingCount('mybase'), 1)
})

test('clients file validation', () => {
  const ok = { id: 'mybase', apiKey: KEY_A, webhookUrl: 'https://x.test/h', webhookSecret: SECRET }
  assert.equal(parseClients([ok])[0]!.admin, false)
  assert.throws(() => parseClients([]))
  assert.throws(() => parseClients([{ ...ok, apiKey: 'short' }]))
  assert.throws(() => parseClients([ok, ok]))
  assert.throws(() => parseClients([{ ...ok, webhookUrl: 'nope' }]))
})
