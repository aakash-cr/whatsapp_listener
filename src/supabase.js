'use strict'

const { createClient } = require('@supabase/supabase-js')

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
  throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY env vars')
}

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
)

async function saveMessage(msg) {
  const { error } = await supabase.from('whatsapp_messages').insert({
    message_id:   msg.key.id,
    chat_jid:     msg.key.remoteJid,
    from_me:      msg.key.fromMe ?? false,
    push_name:    msg.pushName ?? null,
    message_type: getMessageType(msg),
    content:      extractContent(msg),
    media_url:    null,
    ts:           new Date(Number(msg.messageTimestamp) * 1000).toISOString(),
    raw:          msg,
    status:       'received',
  })

  if (error) {
    if (error.code !== '23505') throw error
  }
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