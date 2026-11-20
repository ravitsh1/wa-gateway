/**
 * Phones are stored as international digits without "+" (e.g. 972501234567),
 * which is also the user part of a WhatsApp phone JID.
 */
export function normalizePhone(input: string, defaultCountryCode = '972'): string | null {
  let d = input.replace(/[^\d]/g, '')
  if (d.startsWith('00')) d = d.slice(2)
  else if (d.startsWith('0')) d = defaultCountryCode + d.slice(1)
  return d.length >= 8 && d.length <= 15 ? d : null
}

export const phoneToJid = (phone: string) => `${phone}@s.whatsapp.net`

/** Phone of a 1:1 phone-number JID; null for groups, LIDs, broadcasts, newsletters. */
export function jidToPhone(jid: string | null | undefined): string | null {
  if (!jid) return null
  const m = /^(\d{8,15})(?::\d+)?@s\.whatsapp\.net$/.exec(jid)
  return m ? m[1]! : null
}

export const isLidJid = (jid: string | null | undefined) => !!jid && /@lid$/.test(jid)
