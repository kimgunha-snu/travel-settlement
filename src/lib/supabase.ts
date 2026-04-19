import { createClient } from '@supabase/supabase-js'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY

export const isSupabaseConfigured = Boolean(supabaseUrl && supabaseAnonKey)

export const supabase = isSupabaseConfigured
  ? createClient(supabaseUrl as string, supabaseAnonKey as string)
  : null

export const getRealtimeDebugInfo = () => {
  if (!supabase) return 'no-supabase'

  const realtime = (supabase as unknown as {
    realtime?: {
      isConnected?: () => boolean
      conn?: { readyState?: number }
    }
  }).realtime

  const connected = realtime?.isConnected?.()
  const readyState = realtime?.conn?.readyState

  return `ws-connected:${String(connected)} readyState:${String(readyState)}`
}
