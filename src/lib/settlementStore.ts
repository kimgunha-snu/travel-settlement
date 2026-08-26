import { supabase, isSupabaseConfigured } from './supabase'
import type { DuesCollection, Expense, Member, SettlementPayload, Transfer } from './settlement'

export type { DuesCollection, Expense, Member, SettlementPayload, Transfer } from './settlement'

export type SettlementRecord = {
  id: string
  title: string | null
  share_token: string
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
  original_amount: number | string | null
  original_currency: string | null
  exchange_rate: number | string | null
  conversion_method: 'rate' | 'actual' | null
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
const settlementTitleMetaPrefix = '__travel_settlement_meta_v1__:'

const emptyPayload = (): SettlementPayload => ({ members: [], expenses: [], transfers: [], duesCollections: [] })

const parseTitleMetadata = (title: string | null) => {
  if (!title?.startsWith(settlementTitleMetaPrefix)) {
    return { title, duesCollections: [] as DuesCollection[] }
  }

  try {
    const parsed = JSON.parse(title.slice(settlementTitleMetaPrefix.length)) as {
      title?: string | null
      duesCollections?: DuesCollection[]
    }

    return {
      title: parsed.title ?? '공유 정산',
      duesCollections: Array.isArray(parsed.duesCollections) ? parsed.duesCollections : [],
    }
  } catch {
    return { title: '공유 정산', duesCollections: [] as DuesCollection[] }
  }
}

const encodeTitleMetadata = (title: string | null | undefined, payload: SettlementPayload) => {
  if (payload.duesCollections.length === 0) return title ?? '공유 정산'

  return `${settlementTitleMetaPrefix}${JSON.stringify({
    title: title ?? '공유 정산',
    duesCollections: payload.duesCollections,
  })}`
}

const mapPayloadFromRows = (
  members: MemberRow[],
  expenses: ExpenseRow[],
  transfers: TransferRow[],
  duesCollections: DuesCollection[],
): SettlementPayload => ({
  members: members.map((member) => ({ id: member.id, name: member.name })),
  expenses: expenses.map((expense) => ({
    id: expense.id,
    title: expense.title,
    amount: Number(expense.amount),
    payerId: expense.payer_member_id,
    participantIds: expense.participant_member_ids ?? [],
    ...(expense.original_amount !== null
      && expense.original_currency
      && expense.exchange_rate !== null
      && expense.conversion_method
      ? {
          originalAmount: Number(expense.original_amount),
          originalCurrency: expense.original_currency,
          exchangeRate: Number(expense.exchange_rate),
          conversionMethod: expense.conversion_method,
        }
      : {}),
  })),
  transfers: transfers.map((transfer) => ({
    id: transfer.id,
    amount: Number(transfer.amount),
    fromId: transfer.from_member_id,
    toId: transfer.to_member_id,
  })),
  duesCollections,
})

const getSettlementBaseById = async (id: string) => {
  if (!supabase) throw new Error('Supabase is not configured')
  const { data, error } = await supabase
    .from(settlementsTable)
    .select('id, title, share_token, created_at, updated_at')
    .eq('id', id)
    .single()

  if (error) throw error
  return data as Omit<SettlementRecord, 'data'>
}

export const createSettlement = async (title = '공유 정산', payload?: SettlementPayload) => {
  if (!supabase) throw new Error('Supabase is not configured')

  const { data, error } = await supabase
    .from(settlementsTable)
    .insert({ title })
    .select('id, title, share_token, created_at, updated_at')
    .single()

  if (error) throw error

  const recordBase = data as Omit<SettlementRecord, 'data'>
  if (payload) {
    return updateSettlement(recordBase.id, payload)
  }

  return { ...recordBase, data: emptyPayload() }
}

export const getSettlementById = async (id: string) => {
  const settlement = await getSettlementBaseById(id)
  return getSettlementData(settlement)
}

export const getSettlementByToken = async (shareToken: string) => {
  if (!supabase) throw new Error('Supabase is not configured')
  const { data, error } = await supabase
    .from(settlementsTable)
    .select('id, title, share_token, created_at, updated_at')
    .eq('share_token', shareToken)
    .single()

  if (error) throw error
  return getSettlementData(data as Omit<SettlementRecord, 'data'>)
}

const getSettlementData = async (settlement: Omit<SettlementRecord, 'data'>) => {
  if (!supabase) throw new Error('Supabase is not configured')
  const id = settlement.id
  const titleMetadata = parseTitleMetadata(settlement.title)

  const [{ data: members, error: membersError }, { data: expenses, error: expensesError }, { data: transfers, error: transfersError }] = await Promise.all([
    supabase.from(membersTable).select('id, settlement_id, name').eq('settlement_id', id).order('created_at', { ascending: true }),
    supabase.from(expensesTable).select('id, settlement_id, title, amount, payer_member_id, participant_member_ids, original_amount, original_currency, exchange_rate, conversion_method').eq('settlement_id', id).order('created_at', { ascending: true }),
    supabase.from(transfersTable).select('id, settlement_id, amount, from_member_id, to_member_id').eq('settlement_id', id).order('created_at', { ascending: true }),
  ])

  if (membersError) throw membersError
  if (expensesError) throw expensesError
  if (transfersError) throw transfersError

  return {
    ...settlement,
    title: titleMetadata.title,
    data: mapPayloadFromRows(
      members as MemberRow[],
      expenses as ExpenseRow[],
      transfers as TransferRow[],
      titleMetadata.duesCollections,
    ),
  }
}

const replaceSettlementContent = async (id: string, payload: SettlementPayload, encodedTitle: string) => {
  if (!supabase) throw new Error('Supabase is not configured')

  const { error } = await supabase.rpc('replace_settlement_content_atomic', {
    p_settlement_id: id,
    p_encoded_title: encodedTitle,
    p_members: payload.members.map((member) => ({ id: member.id, name: member.name })),
    p_expenses: payload.expenses.map((expense) => ({
      id: expense.id,
      title: expense.title,
      amount: expense.amount,
      payer_member_id: expense.payerId,
      participant_member_ids: expense.participantIds,
      original_amount: expense.originalAmount ?? null,
      original_currency: expense.originalCurrency ?? null,
      exchange_rate: expense.exchangeRate ?? null,
      conversion_method: expense.conversionMethod ?? null,
    })),
    p_transfers: payload.transfers.map((transfer) => ({
      id: transfer.id,
      amount: transfer.amount,
      from_member_id: transfer.fromId,
      to_member_id: transfer.toId,
    })),
  })

  if (error) throw error
}

export const addRemoteMember = async (settlementId: string, member: Member) => {
  if (!supabase) throw new Error('Supabase is not configured')
  const { error } = await supabase.from(membersTable).insert({ id: member.id, settlement_id: settlementId, name: member.name })
  if (error) throw error
}

export const updateRemoteMember = async (member: Member) => {
  if (!supabase) throw new Error('Supabase is not configured')
  const { error } = await supabase.from(membersTable).update({ name: member.name }).eq('id', member.id)
  if (error) throw error
}

export const deleteRemoteMember = async (memberId: string) => {
  if (!supabase) throw new Error('Supabase is not configured')
  const { error } = await supabase.from(membersTable).delete().eq('id', memberId)
  if (error) throw error
}

export const addRemoteExpense = async (settlementId: string, expense: Expense) => {
  if (!supabase) throw new Error('Supabase is not configured')
  const { error } = await supabase.from(expensesTable).insert({
    id: expense.id,
    settlement_id: settlementId,
    title: expense.title,
    amount: expense.amount,
    payer_member_id: expense.payerId,
    participant_member_ids: expense.participantIds,
    original_amount: expense.originalAmount ?? null,
    original_currency: expense.originalCurrency ?? null,
    exchange_rate: expense.exchangeRate ?? null,
    conversion_method: expense.conversionMethod ?? null,
  })
  if (error) throw error
}

export const updateRemoteExpense = async (expense: Expense) => {
  if (!supabase) throw new Error('Supabase is not configured')
  const { error } = await supabase.from(expensesTable).update({
    title: expense.title,
    amount: expense.amount,
    payer_member_id: expense.payerId,
    participant_member_ids: expense.participantIds,
    original_amount: expense.originalAmount ?? null,
    original_currency: expense.originalCurrency ?? null,
    exchange_rate: expense.exchangeRate ?? null,
    conversion_method: expense.conversionMethod ?? null,
  }).eq('id', expense.id)
  if (error) throw error
}

export const updateRemoteDuesCollections = async (settlementId: string, duesCollections: DuesCollection[]) => {
  if (!supabase) throw new Error('Supabase is not configured')

  const current = await getSettlementBaseById(settlementId)
  const currentTitle = parseTitleMetadata(current.title).title
  const encodedTitle = encodeTitleMetadata(currentTitle, {
    ...emptyPayload(),
    duesCollections,
  })

  const { error } = await supabase.from(settlementsTable).update({ title: encodedTitle }).eq('id', settlementId)
  if (error) throw error
}

export const deleteRemoteExpense = async (expenseId: string) => {
  if (!supabase) throw new Error('Supabase is not configured')
  const { error } = await supabase.from(expensesTable).delete().eq('id', expenseId)
  if (error) throw error
}

export const addRemoteTransfer = async (settlementId: string, transfer: Transfer) => {
  if (!supabase) throw new Error('Supabase is not configured')
  const { error } = await supabase.from(transfersTable).insert({
    id: transfer.id,
    settlement_id: settlementId,
    amount: transfer.amount,
    from_member_id: transfer.fromId,
    to_member_id: transfer.toId,
  })
  if (error) throw error
}

export const updateRemoteTransfer = async (transfer: Transfer) => {
  if (!supabase) throw new Error('Supabase is not configured')
  const { error } = await supabase.from(transfersTable).update({
    amount: transfer.amount,
    from_member_id: transfer.fromId,
    to_member_id: transfer.toId,
  }).eq('id', transfer.id)
  if (error) throw error
}

export const deleteRemoteTransfer = async (transferId: string) => {
  if (!supabase) throw new Error('Supabase is not configured')
  const { error } = await supabase.from(transfersTable).delete().eq('id', transferId)
  if (error) throw error
}

export const subscribeSettlement = (
  id: string,
  onData: (record: SettlementRecord) => void,
  onDebug?: (status: string) => void,
) => {
  if (!supabase) throw new Error('Supabase is not configured')

  const client = supabase
  const emit = async (source: string) => {
    onDebug?.(`realtime-event:${source}`)
    onData(await getSettlementById(id))
  }

  const channel = client
    .channel(`settlement-rows:${id}`)
    .on('postgres_changes', { event: '*', schema: 'public', table: membersTable }, async (payload) => {
      onDebug?.(`raw-event:members:${String((payload.new as { settlement_id?: string })?.settlement_id ?? (payload.old as { settlement_id?: string })?.settlement_id ?? 'unknown')}`)
      const settlementId = String((payload.new as { settlement_id?: string })?.settlement_id ?? (payload.old as { settlement_id?: string })?.settlement_id ?? '')
      if (settlementId !== id) return
      await emit('members')
    })
    .on('postgres_changes', { event: '*', schema: 'public', table: expensesTable }, async (payload) => {
      onDebug?.(`raw-event:expenses:${String((payload.new as { settlement_id?: string })?.settlement_id ?? (payload.old as { settlement_id?: string })?.settlement_id ?? 'unknown')}`)
      const settlementId = String((payload.new as { settlement_id?: string })?.settlement_id ?? (payload.old as { settlement_id?: string })?.settlement_id ?? '')
      if (settlementId !== id) return
      await emit('expenses')
    })
    .on('postgres_changes', { event: '*', schema: 'public', table: transfersTable }, async (payload) => {
      onDebug?.(`raw-event:transfers:${String((payload.new as { settlement_id?: string })?.settlement_id ?? (payload.old as { settlement_id?: string })?.settlement_id ?? 'unknown')}`)
      const settlementId = String((payload.new as { settlement_id?: string })?.settlement_id ?? (payload.old as { settlement_id?: string })?.settlement_id ?? '')
      if (settlementId !== id) return
      await emit('transfers')
    })
    .subscribe((status) => {
      onDebug?.(`channel:${status}`)
    })

  return () => {
    void client.removeChannel(channel)
  }
}

export const updateSettlement = async (id: string, payload: SettlementPayload, title?: string) => {
  if (!supabase) throw new Error('Supabase is not configured')

  const current = await getSettlementBaseById(id)
  const currentTitle = parseTitleMetadata(current.title).title
  const encodedTitle = encodeTitleMetadata(title ?? currentTitle, payload)

  await replaceSettlementContent(id, payload, encodedTitle)
  return getSettlementById(id)
}

export const canUseRemoteStore = () => isSupabaseConfigured
