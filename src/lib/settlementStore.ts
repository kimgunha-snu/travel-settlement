import { supabase, isSupabaseConfigured } from './supabase'

export type Member = {
  id: string
  name: string
}

export type Expense = {
  id: string
  title: string
  amount: number
  payerId: string
  participantIds: string[]
}

export type Transfer = {
  id: string
  amount: number
  fromId: string
  toId: string
}

export type SettlementPayload = {
  members: Member[]
  expenses: Expense[]
  transfers: Transfer[]
}

export type SettlementRecord = {
  id: string
  title: string | null
  data: SettlementPayload
  created_at?: string
  updated_at?: string
}

const table = 'settlements'

export const createSettlement = async (title = '공유 정산', payload?: SettlementPayload) => {
  if (!supabase) throw new Error('Supabase is not configured')

  const { data, error } = await supabase
    .from(table)
    .insert({ title, data: payload ?? { members: [], expenses: [], transfers: [] } })
    .select('id, title, data, created_at, updated_at')
    .single()

  if (error) throw error
  return data as SettlementRecord
}

export const getSettlement = async (id: string) => {
  if (!supabase) throw new Error('Supabase is not configured')

  const { data, error } = await supabase
    .from(table)
    .select('id, title, data, created_at, updated_at')
    .eq('id', id)
    .single()

  if (error) throw error
  return data as SettlementRecord
}

export const updateSettlement = async (id: string, payload: SettlementPayload, title?: string) => {
  if (!supabase) throw new Error('Supabase is not configured')

  const updateBody: { data: SettlementPayload; title?: string } = { data: payload }
  if (title !== undefined) updateBody.title = title

  const { data, error } = await supabase
    .from(table)
    .update(updateBody)
    .eq('id', id)
    .select('id, title, data, created_at, updated_at')
    .single()

  if (error) throw error
  return data as SettlementRecord
}

export const subscribeSettlement = (id: string, onData: (record: SettlementRecord) => void) => {
  if (!supabase) throw new Error('Supabase is not configured')

  const client = supabase
  const channel = client
    .channel(`settlement:${id}`)
    .on(
      'postgres_changes',
      { event: 'UPDATE', schema: 'public', table, filter: `id=eq.${id}` },
      (payload) => {
        onData(payload.new as SettlementRecord)
      },
    )
    .subscribe()

  return () => {
    void client.removeChannel(channel)
  }
}

export const canUseRemoteStore = () => isSupabaseConfigured
