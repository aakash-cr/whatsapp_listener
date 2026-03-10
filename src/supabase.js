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

// Anonymize sender names using a hash-based ID for privacy
function getAnonymousId(senderJid) {
  if (!senderJid) return null
  const crypto = require('crypto')
  const hash = crypto.createHash('md5').update(senderJid).digest('hex').slice(0, 6)
  return `User_${hash}`
}

// Sanitize message object to remove personal identifiers recursively
function sanitizeMessage(msg) {
  const sanitized = JSON.parse(JSON.stringify(msg))
  
  // Remove top-level name fields
  if (sanitized.pushName) delete sanitized.pushName
  if (sanitized.notifyName) delete sanitized.notifyName
  if (sanitized.verifiedName) delete sanitized.verifiedName
  if (sanitized.senderName) delete sanitized.senderName
  if (sanitized.senderJid) delete sanitized.senderJid
  
  // Obfuscate JID numbers
  if (sanitized.key) {
    if (sanitized.key.from) sanitized.key.from = sanitized.key.from.replace(/\d+/g, '0')
    if (sanitized.key.participant) sanitized.key.participant = sanitized.key.participant.replace(/\d+/g, '0')
  }
  
  // Deep sanitization of all text content in message
  const deepSanitize = (obj, key) => {
    // List of fields to completely remove (contain contact info)
    const fieldsToRemove = ['displayName', 'vcard', 'name', 'phoneNumber', 'fullName', 'firstName', 'lastName', 'contactName']
    
    if (typeof obj === 'string') {
      return sanitizeContent(obj)
    }
    if (Array.isArray(obj)) {
      return obj.map((item, idx) => deepSanitize(item, idx))
    }
    if (obj !== null && typeof obj === 'object') {
      const result = {}
      for (const [k, value] of Object.entries(obj)) {
        // Remove any key that looks like it contains contact information
        if (fieldsToRemove.includes(k) || k.toLowerCase().includes('name') || k.toLowerCase().includes('contact')) {
          // Skip these fields entirely
          continue
        } else {
          result[k] = deepSanitize(value, k)
        }
      }
      return result
    }
    return obj
  }
  
  // Apply deep sanitization to the message content
  if (sanitized.message) {
    sanitized.message = deepSanitize(sanitized.message)
  }
  
  return sanitized
}

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

  const content = extractContent(msg)
  const ts = new Date(Number(msg.messageTimestamp) * 1000).toISOString()
  const senderJid = msg.key.from || msg.key.participant || null
  const anonymousId = getAnonymousId(senderJid)
  const sanitizedMsg = sanitizeMessage(msg)

  const { error } = await supabase.from('whatsapp_messages').insert({
    message_id:        msg.key.id,
    chat_jid:          jid,
    from_me:           msg.key.fromMe ?? false,
    push_name:         anonymousId,
    message_type:      getMessageType(msg),
    content:           content,
    media_url:         null,
    ts:                ts,
    raw:               sanitizedMsg,
    status:            'received',
    group_name:        groupName,
    sender_name:       anonymousId,
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

// Sanitize content to remove phone numbers and personal contact information
function sanitizeContent(text) {
  if (!text || typeof text !== 'string') return text
  
  let sanitized = text
  
  // Remove phone numbers (various formats)
  sanitized = sanitized
    .replace(/\b\d{10}\b/g, '[REDACTED]')                        // 10 digits
    .replace(/\b\d{3}[-.\s]?\d{3}[-.\s]?\d{4}\b/g, '[REDACTED]') // XXX-XXX-XXXX format
    .replace(/\+?1?\s?\(?[0-9]{3}\)?[-.\s]?[0-9]{3}[-.\s]?[0-9]{4}/g, '[REDACTED]') // +1 or 1-xxx-xxx-xxxx
    .replace(/\+91\s?\d{10}/g, '[REDACTED]')                     // Indian format +91
    .replace(/\b[6-9]\d{9}\b/g, '[REDACTED]')                    // Indian 10-digit starting with 6-9
  
  // Remove email addresses
  sanitized = sanitized.replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, '[REDACTED]')
  
  // Remove User_XXXX pattern specifically
  sanitized = sanitized.replace(/User_[a-zA-Z0-9]+/g, '[REDACTED]')
  
  // Remove any "ISB [Name/Surname]" patterns
  sanitized = sanitized.replace(/ISB\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*/g, '[REDACTED]')
  
  // Remove any multiple capitalized words (FirstName LastName, etc.)
  sanitized = sanitized.replace(/\b[A-Z][a-z]+\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?\b/g, '[REDACTED]')
  
  // Remove single capitalized words that appear after other text (likely names)
  // Matches: space/comma + CapitalizedWord + comma/period/space/end
  sanitized = sanitized.replace(/(?:\s|,)\b([A-Z][a-z]+)(?=[\s,.\n]|$)/g, ' [REDACTED]')
  
  // Remove mentions with @ symbol
  sanitized = sanitized.replace(/@[A-Za-z]+/g, '[REDACTED]')
  
  // Remove standalone single capitalized words that look like names (between punctuation)
  sanitized = sanitized.replace(/[,\s]([A-Z][a-z]{3,})[,\s]/g, ' [REDACTED] ')
  
  return sanitized
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
  const rawContent = (
    m.conversation ??
    m.extendedTextMessage?.text ??
    m.imageMessage?.caption ??
    m.videoMessage?.caption ??
    m.documentMessage?.fileName ??
    null
  )
  return sanitizeContent(rawContent)
}

module.exports = { supabase, saveMessage, upsertSession, upsertContact, getAnonymousId, sanitizeMessage }