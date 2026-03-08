import 'dotenv/config'
import http from 'http'
import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  isJidBroadcast,
} from '@whiskeysockets/baileys'
import { Boom } from '@hapi/boom'
import qrcode from 'qrcode-terminal'
import pino from 'pino'

import { useSupabaseAuthState }        from './authState.js'
import { saveMessage, upsertSession, upsertContact } from './supabase.js'
import { forwardToWebhook }            from './webhook.js'

const SESSION_ID = process.env.SESSION_ID || 'main-session'
const PORT       = parseInt(process.env.PORT || '3000')
const logger     = pino({ level: 'silent' })   // silence noisy Baileys logs

let sock         = null
let qrString     = null
let sessionStatus = 'disconnected'

// ─── Health check server (required by Railway/Render) ────────────────────────
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

  // QR code endpoint — poll this from your Lovable UI to show the QR
  if (req.url === '/qr') {
    if (qrString) {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ qr: qrString }))
    } else {
      res.writeHead(404, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'No QR available — session may already be active' }))
    }
    return
  }

  res.writeHead(404)
  res.end()
})

server.listen(PORT, () => {
  console.log(`[server] Health check listening on :${PORT}`)
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
    printQRInTerminal: false,   // We handle QR ourselves
    markOnlineOnConnect: false,
    syncFullHistory: false,
  })

  // ── Credentials updated → persist to Supabase ───────────────────────────
  sock.ev.on('creds.update', saveCreds)

  // ── Connection lifecycle ──────────────────────────────────────────────────
  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      qrString     = qr
      sessionStatus = 'qr'
      qrcode.generate(qr, { small: true })
      console.log('[baileys] Scan the QR code above  ↑  (or GET /qr)')
      await upsertSession(SESSION_ID, 'qr')
      await forwardToWebhook('qr', { qr })
    }

    if (connection === 'open') {
      qrString      = null
      sessionStatus = 'connected'
      const phone   = sock.user?.id?.split(':')[0] ?? null
      console.log(`[baileys] Connected  ✓  (${phone})`)
      await upsertSession(SESSION_ID, 'connected', phone)
      await forwardToWebhook('connected', { phone })
    }

    if (connection === 'close') {
      const reason = new Boom(lastDisconnect?.error)?.output?.statusCode
      sessionStatus = 'disconnected'
      await upsertSession(SESSION_ID, 'disconnected')

      if (reason === DisconnectReason.loggedOut) {
        console.log('[baileys] Logged out — delete auth keys and re-scan QR')
        await forwardToWebhook('logged_out', {})
        // Don't reconnect — user must re-authenticate
      } else {
        const delay = reason === DisconnectReason.restartRequired ? 1_000 : 5_000
        console.log(`[baileys] Disconnected (reason: ${reason}) — reconnecting in ${delay}ms`)
        setTimeout(connect, delay)
      }
    }
  })

  // ── Incoming messages ────────────────────────────────────────────────────
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return   // ignore history sync

    for (const msg of messages) {
      try {
        // Skip broadcast/status messages
        if (isJidBroadcast(msg.key.remoteJid)) continue
        if (msg.key.remoteJid === 'status@broadcast') continue

        console.log(`[msg] ${msg.key.fromMe ? '→' : '←'} ${msg.key.remoteJid}`)

        // 1. Persist to Supabase (triggers Realtime → your Lovable UI)
        await saveMessage(msg)

        // 2. Keep contacts table fresh
        await upsertContact(msg.key.remoteJid, msg.pushName)

        // 3. Notify Lovable webhook (optional, for instant push)
        await forwardToWebhook('message', {
          id:        msg.key.id,
          remoteJid: msg.key.remoteJid,
          fromMe:    msg.key.fromMe,
          pushName:  msg.pushName,
          timestamp: msg.messageTimestamp,
        })
      } catch (err) {
        console.error('[msg] processing error:', err)
      }
    }
  })

  // ── Message status updates (read receipts, delivery) ─────────────────────
  sock.ev.on('message-receipt.update', async (updates) => {
    for (const { key, receipt } of updates) {
      try {
        // Update message status in Supabase if needed
        await forwardToWebhook('receipt', { key, receipt })
      } catch (err) {
        console.error('[receipt] error:', err)
      }
    }
  })
}

connect().catch(console.error)

// ── Graceful shutdown ────────────────────────────────────────────────────────
process.on('SIGTERM', () => {
  console.log('[server] SIGTERM received — shutting down')
  sock?.end()
  server.close()
  process.exit(0)
})
