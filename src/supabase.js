'use strict'

const { createClient } = require('@supabase/supabase-js')

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
  throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY env vars')
}

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
)

const ALLOWED_GROUPS = [
  "ISB Co'27 Notice Board 📌",
  "Doubts and Queries",
  "ISB Co'27 - General",
]

// Normalize any apostrophe variant to plain single quote for comparison
function normalize(str) {
  return str.replace(/[\u2018\u2019\u02BC']/g, "'")
}

const ALLOWED_NORMALIZED = ALLOWED_GROUPS.map(normalize)

const jidGroupCache = {}

async function getGroupName(sock, jid) {
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

  if (!jid.endsWith('@g.us')) return false

  const groupName = await getGroupName(sock, jid)

  if (!groupName) {
    console.log(`[filter] Could not get group name for ${jid} — skipping`)
    return false
  }

  if (!ALLOWED_NORMALIZED.includes(normalize(groupName))) {
    console.log(`[filter] Skipping non-allowed group: ${groupName}`)
    return false
  }

  console.log(`[msg] Saving message from: ${groupName}`)

  const content = extractContent(msg)
  const ts = new Date(Number(msg.messageTimestamp) * 1000).toISOString()

  const { error } = await supabase.from('whatsapp_messages').insert({
    message_id:        msg.key.id,
    chat_jid:          jid,
    from_me:           msg.key.fromMe ?? false,
    push_name:         msg.pushName ?? null,
    message_type:      getMessageType(msg),
    content:           content,
    media_url:         null,
    ts:                ts,
    raw:               msg,
    status:            'received',
    group_name:        groupName,
    sender_name:       msg.pushName ?? null,
    message_text:      content,
    message_timestamp: ts,
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