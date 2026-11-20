import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { pino } from 'pino'
import { loadConfig } from './config.js'
import { Db } from './db.js'
import { Gateway } from './gateway.js'
import { buildServer } from './server.js'
import { WhatsApp } from './wa.js'
import { WebhookWorker } from './webhooks.js'

try {
  process.loadEnvFile()
} catch {
  // no .env file: configuration comes from the environment
}

const cfg = loadConfig()
const log = pino({ level: cfg.logLevel })
mkdirSync(cfg.dataDir, { recursive: true, mode: 0o700 })

const db = new Db(join(cfg.dataDir, 'gateway.db'))
const gateway = new Gateway(cfg, db, log)
const worker = new WebhookWorker(db, cfg.clients, log)
gateway.onQueued = () => worker.kick()

const wa = new WhatsApp(cfg.dataDir, gateway, log)
gateway.transport = wa

const app = buildServer(cfg, db, gateway, { level: cfg.logLevel === 'debug' ? 'info' : 'warn' })
await app.listen({ host: cfg.host, port: cfg.port })
log.info({ host: cfg.host, port: cfg.port, clients: cfg.clients.map((c) => c.id) }, 'wa-gateway listening')

worker.start()
gateway.cleanup()
setInterval(() => gateway.cleanup(), 3_600_000).unref()
await wa.start()

let closing = false
const shutdown = async (signal: string) => {
  if (closing) return
  closing = true
  log.info({ signal }, 'shutting down')
  worker.stop()
  await wa.stop()
  await app.close()
  db.close()
  process.exit(0)
}
process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('SIGTERM', () => void shutdown('SIGTERM'))
