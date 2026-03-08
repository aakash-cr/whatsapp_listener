'use strict'

const WEBHOOK_URL    = process.env.WEBHOOK_URL
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || ''

async function forwardToWebhook(event, payload) {
  if (!WEBHOOK_URL) return

  try {
    const body = JSON.stringify({ event, payload, ts: Date.now() })
    const res = await fetch(WEBHOOK_URL, {
      method:  'POST',
      headers: {
        'Content-Type':     'application/json',
        'x-webhook-secret': WEBHOOK_SECRET,
      },
      body,
      signal: AbortSignal.timeout(8000),
    })
    if (!res.ok) console.warn(`[webhook] ${res.status} from ${WEBHOOK_URL}`)
  } catch (err) {
    console.error('[webhook] forward failed:', err.message)
  }
}

module.exports = { forwardToWebhook }