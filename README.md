# WhatsApp Listener — Baileys + Supabase

Persistent WhatsApp session that bridges Baileys → Supabase Realtime → Lovable UI.

## Project Structure
```
src/
  index.js          ← Main Baileys listener (entry point)
  authState.js      ← Supabase-backed session persistence
  supabase.js       ← DB helpers (saveMessage, upsertSession, etc.)
  webhook.js        ← Optional webhook to Lovable backend
supabase-migration.sql  ← Run once in Supabase SQL editor
lovable-integration.js  ← Paste into your Lovable project
```

---

## Step 1 — Supabase Setup

1. Open your Supabase project → **SQL Editor**
2. Paste and run `supabase-migration.sql`
3. Go to **Project Settings → API** and copy:
   - `Project URL` → `SUPABASE_URL`
   - `service_role` key → `SUPABASE_SERVICE_KEY` (keep secret!)
   - `anon` key → for your Lovable frontend (`VITE_SUPABASE_ANON_KEY`)

---

## Step 2 — Deploy to Railway

1. Push this folder to a GitHub repo
2. Go to [railway.app](https://railway.app) → **New Project → Deploy from GitHub**
3. Select your repo
4. Add environment variables in Railway dashboard:

```
SUPABASE_URL=https://xxxx.supabase.co
SUPABASE_SERVICE_KEY=eyJ...
SESSION_ID=main-session
WEBHOOK_URL=https://your-app.lovable.app/api/webhook   # optional
WEBHOOK_SECRET=some-random-string                       # optional
PORT=3000
```

5. Railway auto-detects `package.json` and runs `npm start`

### Railway config (optional — already works without this)
Create `railway.toml` if you need custom settings:
```toml
[build]
builder = "nixpacks"

[deploy]
startCommand = "node src/index.js"
restartPolicyType = "on_failure"
restartPolicyMaxRetries = 5
```

---

## Step 3 — Deploy to Render (alternative)

1. Go to [render.com](https://render.com) → **New Web Service**
2. Connect your GitHub repo
3. Settings:
   - **Build Command:** `npm install`
   - **Start Command:** `node src/index.js`
   - **Environment:** Node
4. Add the same env vars as above
5. Under **Health Check Path** set: `/health`

> ⚠️ On Render free tier, services sleep after 15 min of inactivity.
> Use Railway or Render paid tier to keep the session alive 24/7.

---

## Step 4 — First-time QR Scan

1. After deploying, watch the service logs
2. A QR code will appear in the logs — **scan it with WhatsApp** on your phone
3. Or call `GET https://your-service.railway.app/qr` to get the QR as JSON
4. Once scanned, the session is saved to Supabase — restarts won't require re-scanning

---

## Step 5 — Connect Lovable UI

Copy `lovable-integration.js` into your Lovable project, then:

```jsx
// In your chat component
import { useEffect, useState } from 'react'
import { subscribeToMessages, getMessages } from './whatsapp'

export function ChatWindow({ jid }) {
  const [messages, setMessages] = useState([])

  useEffect(() => {
    getMessages(jid).then(setMessages)
    return subscribeToMessages(jid, (msg) =>
      setMessages(prev => [...prev, msg])
    )
  }, [jid])

  return messages.map(m => <div key={m.id}>{m.content}</div>)
}
```

---

## Health Check Endpoints

| Endpoint  | Returns |
|-----------|---------|
| `GET /health` | `{ status, session, qr, time }` |
| `GET /qr`     | `{ qr: "..." }` or 404 |

---

## How messages flow

```
WhatsApp
  ↓ (Baileys WebSocket)
Railway/Render (index.js)
  ↓ saveMessage()
Supabase whatsapp_messages table
  ↓ Realtime INSERT event
Lovable UI (subscribeToMessages hook)
  ↓
React state update → UI renders new message
```
