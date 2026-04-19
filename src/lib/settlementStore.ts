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

type MemberRow = {
  id: string
  settlement_id: string
  name: string
}

type ExpenseRow = {
  id: string
  settlement_id: string
  title: string
  amount: number
  payer_member_id: string
  participant_member_ids: string[]
}

type TransferRow = {
  id: string
  settlement_id: string
  amount: number
  from_member_id: string
  to_member_id: string
}

const settlementsTable = 'settlements'
const membersTable = 'settlement_members'
const expensesTable = 'settlement_expenses'
const transfersTable = 'settlement_transfers'

const mapPayloadFromRows = (members: MemberRow[], expenses: ExpenseRow[], transfers: TransferRow[]): SettlementPayload => ({
  members: members.map((member) => ({ id: member.id, name: member.name })),
  expenses: expenses.map((expense) => ({
    id: expense.id,
    title: expense.title,
    amount: Number(expense.amount),
    payerId: expense.payer_member_id,
    participantIds: expense.participant_member_ids ?? [],
  })),
  transfers: transfers.map((transfer) => ({
    id: transfer.id,
    amount: Number(transfer.amount),
    fromId: transfer.from_member_id,
    toId: transfer.to_member_id,
  })),
})

export const createSettlement = async (title = '공유 정산', payload?: SettlementPayload) => {
  if (!supabase) throw new Error('Supabase is not configured')

  const { data, error } = await supabase
    .from(settlementsTable)
    .insert({ title })
    .select('id, title, created_at, updated_at')
    .single()

  if (error) throw error

  const recordBase = data as Omit<SettlementRecord, 'data'>
  const record = payload
    ? await getSettlement(recordBase.id)
    : { ...recordBase, data: { members: [], expenses: [], transfers: [] } }

  return record
}

export const getSettlement = async (id: string) => {
  if (!supabase) throw new Error('Supabase is not configured')

  const [{ data: settlement, error: settlementError }, { data: members, error: membersError }, { data: expenses, error: expensesError }, { data: transfers, error: transfersError }] = await Promise.all([
    supabase.from(settlementsTable).select('id, title, created_at, updated_at').eq('id', id).single(),
    supabase.from(membersTable).select('id, settlement_id, name').eq('settlement_id', id).order('created_at', { ascending: true }),
    supabase.from(expensesTable).select('id, settlement_id, title, amount, payer_member_id, participant_member_ids').eq('settlement_id', id).order('created_at', { ascending: true }),
    supabase.from(transfersTable).select('id, settlement_id, amount, from_member_id, to_member_id').eq('settlement_id', id).order('created_at', { ascending: true }),
  ])

  if (settlementError) throw settlementError
  if (membersError) throw membersError
  if (expensesError) throw expensesError
  if (transfersError) throw transfersError

  return {
    ...(settlement as SettlementRecord),
    data: mapPayloadFromRows(members as MemberRow[], expenses as ExpenseRow[], transfers as TransferRow[]),
  }
}

export const replaceSettlementContent = async (id: string, payload: SettlementPayload) => {
  if (!supabase) throw new Error('Supabase is not configured')

  await supabase.from(expensesTable).delete().eq('settlement_id', id)
  await supabase.from(transfersTable).delete().eq('settlement_id', id)
  await supabase.from(membersTable).delete().eq('settlement_id', id)

  if (payload.members.length > 0) {
    const { error } = await supabase.from(membersTable).insert(
      payload.members.map((member) => ({ id: member.id, settlement_id: id, name: member.name })),
    )
    if (error) throw error
  }

  if (payload.expenses.length > 0) {
    const { error } = await supabase.from(expensesTable).insert(
      payload.expenses.map((expense) => ({
        id: expense.id,
        settlement_id: id,
        title: expense.title,
        amount: expense.amount,
        payer_member_id: expense.payerId,
        participant_member_ids: expense.participantIds,
      })),
    )
    if (error) throw error
  }

  if (payload.transfers.length > 0) {
    const { error } = await supabase.from(transfersTable).insert(
      payload.transfers.map((transfer) => ({
        id: transfer.id,
        settlement_id: id,
        amount: transfer.amount,
        from_member_id: transfer.fromId,
        to_member_id: transfer.toId,
      })),
    )
    if (error) throw error
  }
}

export const subscribeSettlement = (id: string, onData: (record: SettlementRecord) => void) => {
  if (!supabase) throw new Error('Supabase is not configured')

  const client = supabase
  const channel = client
    .channel(`settlement-rows:${id}`)
    .on('postgres_changes', { event: '*', schema: 'public', table: membersTable, filter: `settlement_id=eq.${id}` }, async () => {
      onData(await getSettlement(id))
    })
    .on('postgres_changes', { event: '*', schema: 'public', table: expensesTable, filter: `settlement_id=eq.${id}` }, async () => {
      onData(await getSettlement(id))
    })
    .on('postgres_changes', { event: '*', schema: 'public', table: transfersTable, filter: `settlement_id=eq.${id}` }, async () => {
      onData(await getSettlement(id))
    })
    .subscribe()

  return () => {
    void client.removeChannel(channel)
  }
}

export const updateSettlement = async (id: string, payload: SettlementPayload, title?: string) => {
  if (!supabase) throw new Error('Supabase is not configured')

  if (title !== undefined) {
    const { error } = await supabase.from(settlementsTable).update({ title }).eq('id', id)
    if (error) throw error
  }

  await replaceSettlementContent(id, payload)
  return getSettlement(id)
}

export const canUseRemoteStore = () => isSupabaseConfigured
