/**
 * Forwards incoming message events to your Lovable frontend webhook.
 * Lovable can then trigger UI updates, run automations, etc.
 */

const WEBHOOK_URL    = process.env.WEBHOOK_URL
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || ''

export async function forwardToWebhook(event, payload) {
  if (!WEBHOOK_URL) return   // Webhook is optional

  try {
    const body = JSON.stringify({ event, payload, ts: Date.now() })

    const res = await fetch(WEBHOOK_URL, {
      method:  'POST',
      headers: {
        'Content-Type':    'application/json',
        'x-webhook-secret': WEBHOOK_SECRET,
      },
      body,
      signal: AbortSignal.timeout(8000),  // 8 s timeout
    })

    if (!res.ok) {
      console.warn(`[webhook] ${res.status} from ${WEBHOOK_URL}`)
    }
  } catch (err) {
    // Never let webhook errors crash the listener
    console.error('[webhook] forward failed:', err.message)
  }
}
