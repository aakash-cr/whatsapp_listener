'use strict'

const { createClient } = require('@supabase/supabase-js')

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
  throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY env vars')
}

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
)

// Only save messages from these WhatsApp groups
const ALLOWED_GROUPS = [
  'ISB Co\'27 Notice Board 📌',
  'ISB Co\'27 - Mohali Campus',
  'Doubts and Queries',
  'ISB Co\'27 - General',
  'ISB Co\'27 - Delhi NCR',
  'ISB Co\'27 - Mumbai',
  'Case preppers!',
]

// Cache of jid → group name to avoid repeated lookups
const jidGroupCache = {}

async function getGroupName(sock, jid) {
  // Only process group JIDs (end with @g.us)
  if (!jid.endsWith('@g.us')) return null

  if (jidGroupCache[jid]) return jidGroupCache[jid]

  try {
    const meta = await sock.groupMetadata(jid)
    const name = meta?.subject ?? null
    if (name) jidGroupCache[jid] = name
    return name
  } catch {
    return null
  }
}

async function saveMessage(msg, sock) {
  const jid = msg.key.remoteJid

  // Only handle group messages
  if (!jid.endsWith('@g.us')) return false

  const groupName = await getGroupName(sock, jid)

  if (!groupName) {
    console.log(`[filter] Could not get group name for ${jid} — skipping`)
    return false
  }

  if (!ALLOWED_GROUPS.includes(groupName)) {
    console.log(`[filter] Skipping non-allowed group: ${groupName}`)
    return false
  }

  console.log(`[msg] Saving message from allowed group: ${groupName}`)

  const { error } = await supabase.from('whatsapp_messages').insert({
    message_id:   msg.key.id,
    chat_jid:     jid,
    from_me:      msg.key.fromMe ?? false,
    push_name:    msg.pushName ?? null,
    message_type: getMessageType(msg),
    content:      extractContent(msg),
    media_url:    null,
    ts:           new Date(Number(msg.messageTimestamp) * 1000).toISOString(),
    raw:          msg,
    status:       'received',
    group_name:   groupName,
    sender_name:  msg.pushName ?? null,
    message_text: extractContent(msg),
    message_timestamp: new Date(Number(msg.messageTimestamp) * 1000).toISOString(),
  })

  if (error) {
    if (error.code !== '23505') throw error
  }

  return true
}

async function upsertSession(sessionId, status, phoneNumber = null) {
  const { error } = await supabase.from('whatsapp_sessions').upsert({
    session_id:   sessionId,
    status,
    phone_number: phoneNumber,
    last_seen:    new Date().toISOString(),
  }, { onConflict: 'session_id' })

  if (error) console.error('[supabase] upsertSession error:', error)
}

async function upsertContact(jid, pushName) {
  if (!pushName) return
  const { error } = await supabase.from('whatsapp_contacts').upsert({
    jid,
    push_name:  pushName,
    updated_at: new Date().toISOString(),
  }, { onConflict: 'jid' })

  if (error) console.error('[supabase] upsertContact error:', error)
}

function getMessageType(msg) {
  const m = msg.message
  if (!m) return 'unknown'
  if (m.conversation || m.extendedTextMessage)   return 'text'
  if (m.imageMessage)                             return 'image'
  if (m.videoMessage)                             return 'video'
  if (m.audioMessage)                             return 'audio'
  if (m.documentMessage)                          return 'document'
  if (m.stickerMessage)                           return 'sticker'
  if (m.locationMessage)                          return 'location'
  if (m.contactMessage)                           return 'contact'
  if (m.reactionMessage)                          return 'reaction'
  return Object.keys(m)[0] ?? 'unknown'
}

function extractContent(msg) {
  const m = msg.message
  if (!m) return null
  return (
    m.conversation ??
    m.extendedTextMessage?.text ??
    m.imageMessage?.caption ??
    m.videoMessage?.caption ??
    m.documentMessage?.fileName ??
    null
  )
}

module.exports = { supabase, saveMessage, upsertSession, upsertContact }