/**
 * Supabase-backed auth state for Baileys.
 * Stores creds + keys in the `whatsapp_auth_keys` table so the session
 * survives Railway/Render container restarts.
 */

import { supabase } from './supabase.js'
import {
  initAuthCreds,
  BufferJSON,
  proto,
} from '@whiskeysockets/baileys'

const TABLE = 'whatsapp_auth_keys'

export async function useSupabaseAuthState(sessionId) {
  // ── Read all keys for this session ────────────────────────────────────────
  async function readData(id) {
    const { data } = await supabase
      .from(TABLE)
      .select('value')
      .eq('session_id', sessionId)
      .eq('key_id', id)
      .single()

    if (!data) return null
    try {
      return JSON.parse(data.value, BufferJSON.reviver)
    } catch {
      return null
    }
  }

  async function writeData(id, value) {
    await supabase.from(TABLE).upsert(
      {
        session_id: sessionId,
        key_id:     id,
        value:      JSON.stringify(value, BufferJSON.replacer),
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'session_id,key_id' }
    )
  }

  async function removeData(id) {
    await supabase
      .from(TABLE)
      .delete()
      .eq('session_id', sessionId)
      .eq('key_id', id)
  }

  // ── Load or create creds ───────────────────────────────────────────────────
  const creds = (await readData('creds')) || initAuthCreds()

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const data = {}
          await Promise.all(
            ids.map(async (id) => {
              let value = await readData(`${type}-${id}`)
              if (type === 'app-state-sync-key' && value) {
                value = proto.Message.AppStateSyncKeyData.fromObject(value)
              }
              data[id] = value
            })
          )
          return data
        },
        set: async (data) => {
          const tasks = []
          for (const category of Object.keys(data)) {
            for (const id of Object.keys(data[category])) {
              const value = data[category][id]
              const keyId = `${category}-${id}`
              tasks.push(value ? writeData(keyId, value) : removeData(keyId))
            }
          }
          await Promise.all(tasks)
        },
      },
    },
    saveCreds: () => writeData('creds', creds),
  }
}
