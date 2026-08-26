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
  originalAmount?: number
  originalCurrency?: string
  exchangeRate?: number
  conversionMethod?: 'rate' | 'actual'
}

export type Transfer = {
  id: string
  amount: number
  fromId: string
  toId: string
}

export type DuesCollection = {
  id: string
  title: string
  amount: number
  receiverId: string
  paidMemberIds: string[]
}

export type CurrencySettings = {
  enabled: boolean
  currency: string
  exchangeRate: string
}

export const defaultCurrencySettings: CurrencySettings = {
  enabled: false,
  currency: 'JPY',
  exchangeRate: '',
}

export type SettlementPayload = {
  members: Member[]
  expenses: Expense[]
  transfers: Transfer[]
  duesCollections: DuesCollection[]
  currencySettings: CurrencySettings
}

export type BalanceRow = {
  memberId: string
  paid: number
  share: number
  transferredOut: number
  transferredIn: number
  net: number
}

export type Settlement = {
  id: string
  fromId: string
  toId: string
  amount: number
}

export type SettlementResult = {
  settlements: Settlement[]
  imbalance: number
}

export type MemberReferences = {
  paidExpenses: number
  participatedExpenses: number
  transfers: number
  receivedDuesCollections: number
  paidDuesCollections: number
  total: number
}

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value)

const readString = (record: Record<string, unknown>, key: string) => {
  const value = record[key]
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${key} must be a non-empty string`)
  return value
}

const readMoney = (record: Record<string, unknown>, key: string) => {
  const value = record[key]
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${key} must be a positive integer`)
  }
  return value
}

const readPositiveNumber = (record: Record<string, unknown>, key: string) => {
  const value = record[key]
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${key} must be a positive number`)
  }
  return value
}

const readForeignExpense = (record: Record<string, unknown>): Pick<Expense, 'originalAmount' | 'originalCurrency' | 'exchangeRate' | 'conversionMethod'> => {
  const keys = ['originalAmount', 'originalCurrency', 'exchangeRate', 'conversionMethod'] as const
  const providedCount = keys.filter((key) => record[key] !== undefined).length
  if (providedCount === 0) return {}
  if (providedCount !== keys.length) throw new Error('foreign expense metadata must be complete')

  const originalCurrency = readString(record, 'originalCurrency').toUpperCase()
  if (!/^[A-Z]{3}$/.test(originalCurrency) || originalCurrency === 'KRW') {
    throw new Error('originalCurrency must be a non-KRW ISO currency code')
  }

  const conversionMethod = record.conversionMethod
  if (conversionMethod !== 'rate' && conversionMethod !== 'actual') {
    throw new Error('conversionMethod must be rate or actual')
  }

  return {
    originalAmount: readPositiveNumber(record, 'originalAmount'),
    originalCurrency,
    exchangeRate: readPositiveNumber(record, 'exchangeRate'),
    conversionMethod,
  }
}

const readStringArray = (record: Record<string, unknown>, key: string) => {
  const value = record[key]
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string' && item.trim())) {
    throw new Error(`${key} must be a string array`)
  }
  return value as string[]
}

const readRecordArray = (record: Record<string, unknown>, key: string, optional = false) => {
  const value = record[key]
  if (optional && value === undefined) return []
  if (!Array.isArray(value) || !value.every(isRecord)) throw new Error(`${key} must be an object array`)
  return value
}

const readCurrencySettings = (record: Record<string, unknown>): CurrencySettings => {
  const value = record.currencySettings
  if (value === undefined) return { ...defaultCurrencySettings }
  if (!isRecord(value)) throw new Error('currencySettings must be an object')

  const currency = readString(value, 'currency').toUpperCase()
  if (!/^[A-Z]{3}$/.test(currency) || currency === 'KRW') {
    throw new Error('currencySettings.currency must be a non-KRW ISO currency code')
  }

  if (typeof value.enabled !== 'boolean') throw new Error('currencySettings.enabled must be a boolean')
  if (typeof value.exchangeRate !== 'string') throw new Error('currencySettings.exchangeRate must be a string')

  return {
    enabled: value.enabled,
    currency,
    exchangeRate: value.exchangeRate,
  }
}

export const parseSettlementPayload = (value: unknown): SettlementPayload => {
  if (!isRecord(value)) throw new Error('payload must be an object')

  const members = readRecordArray(value, 'members').map((member) => ({
    id: readString(member, 'id'),
    name: readString(member, 'name'),
  }))
  const expenses = readRecordArray(value, 'expenses').map((expense) => ({
    id: readString(expense, 'id'),
    title: readString(expense, 'title'),
    amount: readMoney(expense, 'amount'),
    payerId: readString(expense, 'payerId'),
    participantIds: readStringArray(expense, 'participantIds'),
    ...readForeignExpense(expense),
  }))
  const transfers = readRecordArray(value, 'transfers').map((transfer) => {
    const fromId = readString(transfer, 'fromId')
    const toId = readString(transfer, 'toId')
    if (fromId === toId) throw new Error('transfer sender and receiver must differ')
    return {
      id: readString(transfer, 'id'),
      amount: readMoney(transfer, 'amount'),
      fromId,
      toId,
    }
  })
  const duesCollections = readRecordArray(value, 'duesCollections', true).map((duesCollection) => ({
    id: readString(duesCollection, 'id'),
    title: readString(duesCollection, 'title'),
    amount: readMoney(duesCollection, 'amount'),
    receiverId: readString(duesCollection, 'receiverId'),
    paidMemberIds: readStringArray(duesCollection, 'paidMemberIds'),
  }))
  const currencySettings = readCurrencySettings(value)

  return { members, expenses, transfers, duesCollections, currencySettings }
}

const uniqueIds = (ids: string[]) => Array.from(new Set(ids))

export const sanitizeSettlementPayload = (payload: SettlementPayload) => {
  let changed = false
  const seenMemberIds = new Set<string>()
  const members = payload.members.filter((member) => {
    if (seenMemberIds.has(member.id)) {
      changed = true
      return false
    }
    seenMemberIds.add(member.id)
    return true
  })
  const memberIds = new Set(members.map((member) => member.id))

  const seenExpenseIds = new Set<string>()
  const expenses = payload.expenses.flatMap((expense) => {
    if (seenExpenseIds.has(expense.id) || !memberIds.has(expense.payerId)) {
      changed = true
      return []
    }
    seenExpenseIds.add(expense.id)

    const participantIds = uniqueIds(expense.participantIds.filter((id) => memberIds.has(id)))
    if (expense.participantIds.length > 0 && participantIds.length === 0) {
      changed = true
      return []
    }
    if (participantIds.length !== expense.participantIds.length || participantIds.some((id, index) => id !== expense.participantIds[index])) changed = true
    return [{ ...expense, participantIds }]
  })

  const seenTransferIds = new Set<string>()
  const transfers = payload.transfers.filter((transfer) => {
    const isValid = !seenTransferIds.has(transfer.id)
      && memberIds.has(transfer.fromId)
      && memberIds.has(transfer.toId)
      && transfer.fromId !== transfer.toId
    if (!isValid) changed = true
    seenTransferIds.add(transfer.id)
    return isValid
  })

  const seenDuesCollectionIds = new Set<string>()
  const duesCollections = payload.duesCollections.flatMap((duesCollection) => {
    if (seenDuesCollectionIds.has(duesCollection.id) || !memberIds.has(duesCollection.receiverId)) {
      changed = true
      return []
    }
    seenDuesCollectionIds.add(duesCollection.id)

    const paidMemberIds = uniqueIds(duesCollection.paidMemberIds.filter((id) => id !== duesCollection.receiverId && memberIds.has(id)))
    if (paidMemberIds.length !== duesCollection.paidMemberIds.length || paidMemberIds.some((id, index) => id !== duesCollection.paidMemberIds[index])) changed = true
    return [{ ...duesCollection, paidMemberIds }]
  })

  return {
    payload: { members, expenses, transfers, duesCollections, currencySettings: payload.currencySettings },
    changed,
  }
}

const assertMoney = (amount: number) => {
  if (!Number.isSafeInteger(amount) || amount <= 0) throw new Error('All amounts must be positive integer won values')
}

export const convertForeignAmountToWon = (originalAmount: number, exchangeRate: number) => {
  if (!Number.isFinite(originalAmount) || originalAmount <= 0) throw new Error('Foreign amount must be positive')
  if (!Number.isFinite(exchangeRate) || exchangeRate <= 0) throw new Error('Exchange rate must be positive')

  const amount = Math.round(originalAmount * exchangeRate)
  assertMoney(amount)
  return amount
}

export const calculateBalances = (payload: SettlementPayload): BalanceRow[] => {
  const rows = new Map<string, BalanceRow>()
  payload.members.forEach((member) => {
    rows.set(member.id, {
      memberId: member.id,
      paid: 0,
      share: 0,
      transferredOut: 0,
      transferredIn: 0,
      net: 0,
    })
  })

  payload.expenses.forEach((expense) => {
    assertMoney(expense.amount)
    const payer = rows.get(expense.payerId)
    if (!payer) return

    const participants = expense.participantIds.length > 0
      ? uniqueIds(expense.participantIds.filter((participantId) => rows.has(participantId)))
      : [expense.payerId]
    if (participants.length === 0) return

    payer.paid += expense.amount
    const baseShare = Math.floor(expense.amount / participants.length)
    const remainder = expense.amount % participants.length
    participants.forEach((participantId, index) => {
      const participant = rows.get(participantId)
      if (participant) participant.share += baseShare + (index < remainder ? 1 : 0)
    })
  })

  payload.transfers.forEach((transfer) => {
    assertMoney(transfer.amount)
    const sender = rows.get(transfer.fromId)
    const receiver = rows.get(transfer.toId)
    if (!sender || !receiver || transfer.fromId === transfer.toId) return
    sender.transferredOut += transfer.amount
    receiver.transferredIn += transfer.amount
  })

  payload.duesCollections.forEach((duesCollection) => {
    assertMoney(duesCollection.amount)
    uniqueIds(duesCollection.paidMemberIds).forEach((memberId) => {
      if (memberId === duesCollection.receiverId) return
      const payer = rows.get(memberId)
      const receiver = rows.get(duesCollection.receiverId)
      if (!payer || !receiver) return
      payer.transferredOut += duesCollection.amount
      receiver.transferredIn += duesCollection.amount
    })
  })

  return Array.from(rows.values()).map((row) => ({
    ...row,
    net: row.paid - row.share + row.transferredOut - row.transferredIn,
  }))
}

export const calculateSettlements = (balances: BalanceRow[]): SettlementResult => {
  const imbalance = balances.reduce((sum, row) => sum + row.net, 0)
  if (!Number.isSafeInteger(imbalance) || imbalance !== 0) return { settlements: [], imbalance }

  const creditors = balances.filter((row) => row.net > 0).map((row) => ({ memberId: row.memberId, amount: row.net }))
  const debtors = balances.filter((row) => row.net < 0).map((row) => ({ memberId: row.memberId, amount: -row.net }))
  const settlements: Settlement[] = []
  let debtorIndex = 0
  let creditorIndex = 0

  while (debtorIndex < debtors.length && creditorIndex < creditors.length) {
    const debtor = debtors[debtorIndex]
    const creditor = creditors[creditorIndex]
    const amount = Math.min(debtor.amount, creditor.amount)
    settlements.push({
      id: `${debtor.memberId}-${creditor.memberId}`,
      fromId: debtor.memberId,
      toId: creditor.memberId,
      amount,
    })
    debtor.amount -= amount
    creditor.amount -= amount
    if (debtor.amount === 0) debtorIndex += 1
    if (creditor.amount === 0) creditorIndex += 1
  }

  const unsettled = debtors.slice(debtorIndex).reduce((sum, row) => sum + row.amount, 0)
    - creditors.slice(creditorIndex).reduce((sum, row) => sum + row.amount, 0)
  if (unsettled !== 0) return { settlements: [], imbalance: unsettled }

  return { settlements, imbalance: 0 }
}

export const getMemberReferences = (payload: SettlementPayload, memberId: string): MemberReferences => {
  const paidExpenses = payload.expenses.filter((expense) => expense.payerId === memberId).length
  const participatedExpenses = payload.expenses.filter((expense) => expense.participantIds.includes(memberId)).length
  const transfers = payload.transfers.filter((transfer) => transfer.fromId === memberId || transfer.toId === memberId).length
  const receivedDuesCollections = payload.duesCollections.filter((duesCollection) => duesCollection.receiverId === memberId).length
  const paidDuesCollections = payload.duesCollections.filter((duesCollection) => duesCollection.paidMemberIds.includes(memberId)).length

  return {
    paidExpenses,
    participatedExpenses,
    transfers,
    receivedDuesCollections,
    paidDuesCollections,
    total: paidExpenses + participatedExpenses + transfers + receivedDuesCollections + paidDuesCollections,
  }
}
