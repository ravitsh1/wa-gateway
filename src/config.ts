import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

export type Client = {
  id: string
  apiKey: string
  webhookUrl: string
  webhookSecret: string
  /** May pair / log out the WhatsApp session and receives session events. */
  admin: boolean
}

export type Config = {
  host: string
  port: number
  dataDir: string
  publicUrl: string
  defaultCountryCode: string
  sendMinIntervalMs: number
  retentionHours: number
  maxMediaBytes: number
  logLevel: string
  clients: Client[]
}

const num = (v: string | undefined, fallback: number) => {
  const n = Number(v)
  return v !== undefined && v !== '' && Number.isFinite(n) ? n : fallback
}

export function parseClients(raw: unknown): Client[] {
  if (!Array.isArray(raw) || raw.length === 0) throw new Error('clients file must be a non-empty array')
  const seen = new Set<string>()
  return raw.map((c, i) => {
    const o = c as Record<string, unknown>
    for (const k of ['id', 'apiKey', 'webhookUrl', 'webhookSecret']) {
      if (typeof o[k] !== 'string' || !o[k]) throw new Error(`clients[${i}].${k} is required`)
    }
    const id = o.id as string
    if (!/^[a-z0-9_-]+$/.test(id)) throw new Error(`clients[${i}].id must match [a-z0-9_-]+`)
    if (seen.has(id)) throw new Error(`duplicate client id "${id}"`)
    seen.add(id)
    if ((o.apiKey as string).length < 32) throw new Error(`clients[${i}].apiKey must be at least 32 characters`)
    if ((o.webhookSecret as string).length < 32) {
      throw new Error(`clients[${i}].webhookSecret must be at least 32 characters`)
    }
    new URL(o.webhookUrl as string)
    return {
      id,
      apiKey: o.apiKey as string,
      webhookUrl: o.webhookUrl as string,
      webhookSecret: o.webhookSecret as string,
      admin: o.admin === true,
    }
  })
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const clientsFile = resolve(env.CLIENTS_FILE || './clients.json')
  const clients = parseClients(JSON.parse(readFileSync(clientsFile, 'utf8')))
  const port = num(env.PORT, 3040)
  return {
    host: env.HOST || '127.0.0.1',
    port,
    dataDir: resolve(env.DATA_DIR || './data'),
    publicUrl: (env.PUBLIC_URL || `http://127.0.0.1:${port}`).replace(/\/+$/, ''),
    defaultCountryCode: env.DEFAULT_COUNTRY_CODE || '972',
    sendMinIntervalMs: num(env.SEND_MIN_INTERVAL_MS, 3000),
    retentionHours: num(env.RETENTION_HOURS, 72),
    maxMediaBytes: num(env.MAX_MEDIA_MB, 50) * 1024 * 1024,
    logLevel: env.LOG_LEVEL || 'info',
    clients,
  }
}
