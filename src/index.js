'use strict'

// Polyfill crypto for Node.js 18
if (!globalThis.crypto) {
  globalThis.crypto = require('crypto').webcrypto
}

require('dotenv').config()

const http    = require('http')
const baileys = require('@whiskeysockets/baileys')
const {
  default: makeWASocket,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  isJidBroadcast,
} = baileys
const { Boom }  = require('@hapi/boom')
const qrcode    = require('qrcode-terminal')
const pino      = require('pino')

const { useSupabaseAuthState }                   = require('./authState')
const { saveMessage, upsertSession, upsertContact, getAnonymousId } = require('./supabase')
const { forwardToWebhook }                       = require('./webhook')

const SESSION_ID    = process.env.SESSION_ID || 'main-session'
const PORT          = parseInt(process.env.PORT || '3000')
const logger        = pino({ level: 'silent' })

let sock            = null
let qrString        = null
let sessionStatus   = 'disconnected'

// ─── Health check server ──────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      status:  sessionStatus,
      session: SESSION_ID,
      qr:      sessionStatus === 'qr' ? qrString : null,
      time:    new Date().toISOString(),
    }))
    return
  }

  if (req.url === '/qr') {
    if (qrString) {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ qr: qrString }))
    } else {
      res.writeHead(404, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'No QR available — already connected?' }))
    }
    return
  }

  res.writeHead(404)
  res.end()
})

server.listen(PORT, () => {
  console.log(`[server] Health check on :${PORT}`)
})

// ─── Connect ──────────────────────────────────────────────────────────────────
async function connect() {
  console.log(`[baileys] Starting session: ${SESSION_ID}`)

  const { version } = await fetchLatestBaileysVersion()
  const { state, saveCreds } = await useSupabaseAuthState(SESSION_ID)

  sock = makeWASocket({
    version,
    logger,
    auth: {
      creds: state.creds,
      keys:  makeCacheableSignalKeyStore(state.keys, logger),
    },
    printQRInTerminal: false,
    markOnlineOnConnect: false,
    syncFullHistory: false,
  })

  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      qrString      = qr
      sessionStatus = 'qr'
      qrcode.generate(qr, { small: true })
      console.log('[baileys] Scan the QR code above ↑  (or GET /qr)')
      await upsertSession(SESSION_ID, 'qr')
      await forwardToWebhook('qr', { qr })
    }

    if (connection === 'open') {
      qrString      = null
      sessionStatus = 'connected'
      const phone   = sock.user?.id?.split(':')[0] ?? null
      console.log(`[baileys] Connected ✓  (${phone})`)
      await upsertSession(SESSION_ID, 'connected', phone)
      await forwardToWebhook('connected', { phone })
    }

    if (connection === 'close') {
      const boomErr = new Boom(lastDisconnect?.error)
      const reason  = boomErr?.output?.statusCode
      console.log(`[baileys] Disconnect detail:`, JSON.stringify(lastDisconnect?.error?.message), `| statusCode: ${reason}`, `| data:`, JSON.stringify(boomErr?.data))
      sessionStatus = 'disconnected'
      await upsertSession(SESSION_ID, 'disconnected')

      if (reason === DisconnectReason.loggedOut) {
        console.log('[baileys] Logged out — re-scan QR to reconnect')
        await forwardToWebhook('logged_out', {})
      } else {
        const delay = reason === DisconnectReason.restartRequired ? 1_000 : 5_000
        console.log(`[baileys] Disconnected (${reason}) — reconnecting in ${delay}ms`)
        setTimeout(connect, delay)
      }
    }
  })

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return

    for (const msg of messages) {
      try {
        if (isJidBroadcast(msg.key.remoteJid)) continue
        if (msg.key.remoteJid === 'status@broadcast') continue

        console.log(`[msg] ${msg.key.fromMe ? '→' : '←'} ${msg.key.remoteJid}`)

        await saveMessage(msg, sock)
        const senderJid = msg.key.from || msg.key.participant || null
        const anonymousId = getAnonymousId(senderJid)
        await upsertContact(msg.key.remoteJid, anonymousId)
        await forwardToWebhook('message', {
          id:        msg.key.id,
          remoteJid: msg.key.remoteJid,
          fromMe:    msg.key.fromMe,
          pushName:  anonymousId,
          timestamp: msg.messageTimestamp,
        })
      } catch (err) {
        console.error('[msg] processing error:', err)
      }
    }
  })

  sock.ev.on('message-receipt.update', async (updates) => {
    for (const { key, receipt } of updates) {
      await forwardToWebhook('receipt', { key, receipt }).catch(() => {})
    }
  })
}

connect().catch(console.error)

process.on('SIGTERM', () => {
  console.log('[server] Shutting down')
  sock?.end()
  server.close()
  process.exit(0)
})