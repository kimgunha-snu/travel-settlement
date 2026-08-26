import { useEffect, useMemo, useRef, useState } from 'react'
import './App.css'
import {
  addRemoteExpense,
  addRemoteMember,
  addRemoteTransfer,
  canUseRemoteStore,
  createSettlement,
  deleteRemoteExpense,
  deleteRemoteMember,
  deleteRemoteTransfer,
  getSettlementById,
  getSettlementByToken,
  subscribeSettlement,
  updateRemoteDuesCollections,
  updateRemoteExpense,
  updateRemoteMember,
  updateRemoteTransfer,
  updateSettlement,
} from './lib/settlementStore'
import {
  calculateBalances,
  calculateSettlements,
  convertForeignAmountToWon,
  getMemberReferences,
  parseSettlementPayload,
  sanitizeSettlementPayload,
  type DuesCollection,
  type Expense,
  type Member,
  type SettlementPayload,
  type Transfer,
} from './lib/settlement'

type SavedSettlementLink = {
  id: string
  token: string
  title: string
  url: string
  savedAt: string
}

type ImportPayload = SettlementPayload

type ForeignCurrencySettings = {
  enabled: boolean
  currency: string
  exchangeRate: string
}

type ExpenseMoneyDraft = {
  amount: string
  currency: string
  exchangeRate: string
}

type ExpenseFormState = ExpenseMoneyDraft & {
  title: string
  payerId: string
  participantIds: string[]
}

const currency = new Intl.NumberFormat('ko-KR', {
  style: 'currency',
  currency: 'KRW',
  maximumFractionDigits: 0,
})

const storageKey = 'travel-settlement-app-data'
const cloneStorageKeyPrefix = 'travel-settlement-app-clone-'
const savedLinksStorageKey = 'travel-settlement-app-saved-links'
const foreignCurrencySettingsStorageKey = 'travel-settlement-app-foreign-currency-settings'
const supportedForeignCurrencies = [
  { code: 'JPY', label: '일본 엔 (JPY)' },
  { code: 'USD', label: '미국 달러 (USD)' },
  { code: 'EUR', label: '유로 (EUR)' },
  { code: 'THB', label: '태국 바트 (THB)' },
  { code: 'VND', label: '베트남 동 (VND)' },
  { code: 'CNY', label: '중국 위안 (CNY)' },
  { code: 'TWD', label: '대만 달러 (TWD)' },
  { code: 'HKD', label: '홍콩 달러 (HKD)' },
  { code: 'SGD', label: '싱가포르 달러 (SGD)' },
  { code: 'PHP', label: '필리핀 페소 (PHP)' },
  { code: 'MYR', label: '말레이시아 링깃 (MYR)' },
  { code: 'IDR', label: '인도네시아 루피아 (IDR)' },
  { code: 'AUD', label: '호주 달러 (AUD)' },
  { code: 'GBP', label: '영국 파운드 (GBP)' },
  { code: 'CAD', label: '캐나다 달러 (CAD)' },
] as const
const defaultForeignCurrencySettings: ForeignCurrencySettings = {
  enabled: false,
  currency: 'JPY',
  exchangeRate: '',
}
const createId = () => Math.random().toString(36).slice(2, 10)
const createUuid = () => 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (char) => {
  const random = Math.random() * 16 | 0
  const value = char === 'x' ? random : (random & 0x3) | 0x8
  return value.toString(16)
})

const emptyPayload = (): ImportPayload => ({ members: [], expenses: [], transfers: [], duesCollections: [] })

const repairRemoteReferences = async (
  settlementId: string,
  current: SettlementPayload,
  cleaned: SettlementPayload,
) => {
  const cleanedExpenses = new Map(cleaned.expenses.map((expense) => [expense.id, expense]))
  const cleanedTransfers = new Set(cleaned.transfers.map((transfer) => transfer.id))
  const repairs: Promise<void>[] = []

  current.expenses.forEach((expense) => {
    const cleanedExpense = cleanedExpenses.get(expense.id)
    if (!cleanedExpense) {
      repairs.push(deleteRemoteExpense(expense.id))
    } else if (JSON.stringify(expense) !== JSON.stringify(cleanedExpense)) {
      repairs.push(updateRemoteExpense(cleanedExpense))
    }
  })

  current.transfers.forEach((transfer) => {
    if (!cleanedTransfers.has(transfer.id)) repairs.push(deleteRemoteTransfer(transfer.id))
  })

  if (JSON.stringify(current.duesCollections) !== JSON.stringify(cleaned.duesCollections)) {
    repairs.push(updateRemoteDuesCollections(settlementId, cleaned.duesCollections))
  }

  await Promise.all(repairs)
}

const savedDateFormatter = new Intl.DateTimeFormat('ko-KR', {
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
})

const evaluateAmountInput = (value: string) => {
  const sanitized = value.replace(/,/g, '').trim()
  if (!sanitized) return null
  if (!/^[0-9+\-*/().\s]+$/.test(sanitized)) return null

  try {
    const result = Function(`"use strict"; return (${sanitized})`)()
    if (typeof result !== 'number' || !Number.isSafeInteger(result)) return null
    return result
  } catch {
    return null
  }
}

const evaluatePositiveNumberInput = (value: string) => {
  const sanitized = value.replace(/,/g, '').trim()
  if (!sanitized) return null
  if (!/^[0-9+\-*/().\s]+$/.test(sanitized)) return null

  try {
    const result = Function(`"use strict"; return (${sanitized})`)()
    if (typeof result !== 'number' || !Number.isFinite(result) || result <= 0 || result > Number.MAX_SAFE_INTEGER) return null
    return result
  } catch {
    return null
  }
}

const readForeignCurrencySettings = (): ForeignCurrencySettings => {
  try {
    const raw = window.localStorage.getItem(foreignCurrencySettingsStorageKey)
    if (!raw) return defaultForeignCurrencySettings
    const parsed = JSON.parse(raw) as Partial<ForeignCurrencySettings>
    const currency = supportedForeignCurrencies.some((item) => item.code === parsed.currency)
      ? parsed.currency as string
      : defaultForeignCurrencySettings.currency
    const exchangeRate = typeof parsed.exchangeRate === 'string' && (parsed.exchangeRate === '' || evaluatePositiveNumberInput(parsed.exchangeRate) !== null)
      ? parsed.exchangeRate
      : ''
    return { enabled: parsed.enabled === true, currency, exchangeRate }
  } catch {
    return defaultForeignCurrencySettings
  }
}

const resolveExpenseMoney = (draft: ExpenseMoneyDraft): Pick<Expense, 'amount' | 'originalAmount' | 'originalCurrency' | 'exchangeRate' | 'conversionMethod'> | null => {
  if (draft.currency === 'KRW') {
    const amount = evaluateAmountInput(draft.amount)
    return amount !== null && amount > 0 ? { amount } : null
  }

  const originalAmount = evaluatePositiveNumberInput(draft.amount)
  if (originalAmount === null) return null

  const exchangeRate = evaluatePositiveNumberInput(draft.exchangeRate)
  if (exchangeRate === null) return null
  let amount: number
  try {
    amount = convertForeignAmountToWon(originalAmount, exchangeRate)
  } catch {
    return null
  }
  return {
    amount,
    originalAmount,
    originalCurrency: draft.currency,
    exchangeRate,
    conversionMethod: 'rate',
  }
}

const formatForeignCurrency = (amount: number, currencyCode: string) => new Intl.NumberFormat('ko-KR', {
  style: 'currency',
  currency: currencyCode,
  maximumFractionDigits: 4,
}).format(amount)

const rateFormatter = new Intl.NumberFormat('ko-KR', { maximumFractionDigits: 6 })

const readStoredData = (): ImportPayload => {
  const cloneId = getCloneIdFromUrl()
  if (cloneId) {
    try {
      const raw = window.localStorage.getItem(`${cloneStorageKeyPrefix}${cloneId}`)
      if (raw) {
        return sanitizeSettlementPayload(parseSettlementPayload(JSON.parse(raw))).payload
      }
    } catch {
      return emptyPayload()
    }
  }

  if (shouldStartFreshFromUrl()) return emptyPayload()

  try {
    const raw = window.localStorage.getItem(storageKey)
    if (!raw) return emptyPayload()
    return sanitizeSettlementPayload(parseSettlementPayload(JSON.parse(raw))).payload
  } catch {
    return emptyPayload()
  }
}

const readSavedSettlementLinks = (): SavedSettlementLink[] => {
  try {
    const raw = window.localStorage.getItem(savedLinksStorageKey)
    if (!raw) return []
    const parsed = JSON.parse(raw) as Partial<SavedSettlementLink>[]
    if (!Array.isArray(parsed)) return []

    return parsed
      .filter((item): item is SavedSettlementLink => Boolean(item.id && item.token && item.url && item.title && item.savedAt))
      .slice(0, 20)
  } catch {
    return []
  }
}

const getUrl = () => new URL(window.location.href)
const getSettlementIdFromUrl = () => getUrl().searchParams.get('settlement') ?? ''
const getSettlementTokenFromUrl = () => getUrl().searchParams.get('token') ?? ''
const getShareTokenFromUrl = () => getUrl().searchParams.get('share') ?? ''
const getCloneIdFromUrl = () => getUrl().searchParams.get('clone') ?? ''

const shouldStartFreshFromUrl = () => getUrl().searchParams.get('fresh') === '1'

const createShareUrl = (shareToken: string) => {
  const url = getUrl()
  url.searchParams.delete('settlement')
  url.searchParams.delete('token')
  url.searchParams.delete('fresh')
  url.searchParams.set('share', shareToken)
  return url.toString()
}

const createFreshSettlementUrl = (cloneId?: string) => {
  const url = getUrl()
  url.searchParams.delete('settlement')
  url.searchParams.delete('token')
  url.searchParams.delete('share')
  url.searchParams.delete('clone')
  if (cloneId) url.searchParams.set('clone', cloneId)
  url.searchParams.set('fresh', '1')
  return url.toString()
}

const getSavedSettlementTitle = (payload: SettlementPayload, fallback = '공유 정산') => {
  const names = payload.members.map((member) => member.name.trim()).filter(Boolean)
  if (names.length === 0) return fallback
  if (names.length === 1) return `${names[0]} 정산`
  return `${names[0]} 외 ${names.length - 1}명 정산`
}

const hasBatchim = (name: string) => {
  const last = name.trim().at(-1)
  if (!last) return false
  const code = last.charCodeAt(0)
  if (code < 0xac00 || code > 0xd7a3) return false
  return (code - 0xac00) % 28 !== 0
}

const withSubjectParticle = (name: string) => `${name}${hasBatchim(name) ? '이' : '가'}`
const withObjectParticle = (name: string) => `${name}${hasBatchim(name) ? '을' : '를'}`

const normalizePayloadForRemote = (payload: SettlementPayload) => {
  const memberIdMap = new Map<string, string>()

  const members = payload.members.map((member) => {
    const nextId = createUuid()
    memberIdMap.set(member.id, nextId)
    return { ...member, id: nextId }
  })

  const expenses = payload.expenses.map((expense) => ({
    ...expense,
    id: createUuid(),
    payerId: memberIdMap.get(expense.payerId) ?? expense.payerId,
    participantIds: expense.participantIds.map((id) => memberIdMap.get(id) ?? id),
  }))

  const transfers = payload.transfers.map((transfer) => ({
    ...transfer,
    id: createUuid(),
    fromId: memberIdMap.get(transfer.fromId) ?? transfer.fromId,
    toId: memberIdMap.get(transfer.toId) ?? transfer.toId,
  }))

  const duesCollections = payload.duesCollections.map((duesCollection) => ({
    ...duesCollection,
    id: createUuid(),
    receiverId: memberIdMap.get(duesCollection.receiverId) ?? duesCollection.receiverId,
    paidMemberIds: duesCollection.paidMemberIds.map((id) => memberIdMap.get(id) ?? id),
  }))

  return {
    payload: { members, expenses, transfers, duesCollections },
    memberIdMap,
  }
}

function App() {
  const [foreignCurrencySettings, setForeignCurrencySettings] = useState<ForeignCurrencySettings>(() => readForeignCurrencySettings())
  const [members, setMembers] = useState<Member[]>(() => readStoredData().members)
  const [expenses, setExpenses] = useState<Expense[]>(() => readStoredData().expenses)
  const [transfers, setTransfers] = useState<Transfer[]>(() => readStoredData().transfers)
  const [duesCollections, setDuesCollections] = useState<DuesCollection[]>(() => readStoredData().duesCollections)
  const [newMemberName, setNewMemberName] = useState('')
  const [expenseForm, setExpenseForm] = useState<ExpenseFormState>(() => ({
    title: '',
    amount: '',
    payerId: '',
    participantIds: [] as string[],
    currency: foreignCurrencySettings.enabled ? foreignCurrencySettings.currency : 'KRW',
    exchangeRate: foreignCurrencySettings.exchangeRate,
  }))
  const [transferForm, setTransferForm] = useState({
    amount: '',
    fromId: '',
    toId: '',
  })
  const [isCollectDuesModalOpen, setIsCollectDuesModalOpen] = useState(false)
  const [collectDuesForm, setCollectDuesForm] = useState({
    title: '',
    amount: '',
    receiverId: '',
  })
  const [isImportModalOpen, setIsImportModalOpen] = useState(false)
  const [importText, setImportText] = useState('')
  const [importMessage, setImportMessage] = useState('내보낸 데이터(JSON)를 붙여넣으면 지금 상태를 그대로 복구할 수 있어요.')
  const [exportMessage, setExportMessage] = useState('')
  const [isSummaryModalOpen, setIsSummaryModalOpen] = useState(false)
  const [summaryText, setSummaryText] = useState('')
  const [remoteStatus, setRemoteStatus] = useState(() => {
    const settlementToken = getShareTokenFromUrl() || getSettlementTokenFromUrl()
    if (settlementToken && !canUseRemoteStore()) {
      return 'URL에 공유 정산 ID가 있지만 Supabase 환경변수가 없어요.'
    }
    return canUseRemoteStore() ? '공유 기능 사용 가능' : 'Supabase 환경변수 미설정'
  })
  const [sharedSettlementId, setSharedSettlementId] = useState(() => getSettlementIdFromUrl())
  const [sharedSettlementToken, setSharedSettlementToken] = useState(() => getShareTokenFromUrl() || getSettlementTokenFromUrl())
  const [savedSettlementLinks, setSavedSettlementLinks] = useState<SavedSettlementLink[]>(() => readSavedSettlementLinks())
  const [isShareModalOpen, setIsShareModalOpen] = useState(false)
  const [shareUrl, setShareUrl] = useState('')
  const [editingExpenseId, setEditingExpenseId] = useState<string | null>(null)
  const [editingTransferId, setEditingTransferId] = useState<string | null>(null)
  const [editingDuesCollectionId, setEditingDuesCollectionId] = useState<string | null>(null)
  const [isMembersModalOpen, setIsMembersModalOpen] = useState(false)
  const [expenseEditForm, setExpenseEditForm] = useState<ExpenseFormState>({
    title: '',
    amount: '',
    payerId: '',
    participantIds: [],
    currency: 'KRW',
    exchangeRate: '',
  })
  const [transferEditForm, setTransferEditForm] = useState({ amount: '', fromId: '', toId: '' })
  const [duesEditForm, setDuesEditForm] = useState({ title: '', amount: '', receiverId: '', paidMemberIds: [] as string[] })
  const lastRemoteJsonRef = useRef('')
  const suppressNextRemoteSaveRef = useRef(false)

  const currentPayload: SettlementPayload = useMemo(() => ({ members, expenses, transfers, duesCollections }), [duesCollections, expenses, members, transfers])
  const currentPayloadJson = useMemo(() => JSON.stringify(currentPayload), [currentPayload])
  const currentShareUrl = useMemo(() => {
    if (!sharedSettlementId || !sharedSettlementToken) return shareUrl
    return createShareUrl(sharedSettlementToken)
  }, [shareUrl, sharedSettlementId, sharedSettlementToken])

  const saveSettlementLink = (link: Omit<SavedSettlementLink, 'savedAt'>) => {
    setSavedSettlementLinks((current) => {
      const nextLink = { ...link, savedAt: new Date().toISOString() }
      const next = [nextLink, ...current.filter((item) => item.token !== link.token && item.id !== link.id)].slice(0, 20)
      window.localStorage.setItem(savedLinksStorageKey, JSON.stringify(next))
      return next
    })
  }

  const removeSavedSettlementLink = (token: string) => {
    setSavedSettlementLinks((current) => {
      const next = current.filter((item) => item.token !== token)
      window.localStorage.setItem(savedLinksStorageKey, JSON.stringify(next))
      return next
    })
  }

  const openSavedSettlementLink = (url: string) => {
    window.location.assign(url)
  }

  useEffect(() => {
    window.localStorage.setItem(storageKey, currentPayloadJson)

    const url = getUrl()
    const cloneId = url.searchParams.get('clone')
    const shouldClearFresh = url.searchParams.get('fresh') === '1'
    if (cloneId) {
      window.localStorage.removeItem(`${cloneStorageKeyPrefix}${cloneId}`)
      url.searchParams.delete('clone')
    }
    if (shouldClearFresh) {
      url.searchParams.delete('fresh')
    }
    if (cloneId || shouldClearFresh) {
      window.history.replaceState({}, '', url.toString())
    }
  }, [currentPayloadJson])

  useEffect(() => {
    window.localStorage.setItem(foreignCurrencySettingsStorageKey, JSON.stringify(foreignCurrencySettings))
  }, [foreignCurrencySettings])

  useEffect(() => {
    getSettlementIdFromUrl()
    const settlementToken = getShareTokenFromUrl() || getSettlementTokenFromUrl()
    if (!settlementToken) return
    if (!canUseRemoteStore()) {
      return
    }

    let isCancelled = false

    const load = async () => {
      setRemoteStatus('공유 정산 연결 중...')
      try {
        const record = await getSettlementByToken(settlementToken)
        if (isCancelled) return
        const cleaned = sanitizeSettlementPayload(parseSettlementPayload(record.data))
        suppressNextRemoteSaveRef.current = true
        lastRemoteJsonRef.current = JSON.stringify(cleaned.payload)
        setSharedSettlementId(record.id)
        setSharedSettlementToken(record.share_token)
        setMembers(cleaned.payload.members)
        setExpenses(cleaned.payload.expenses)
        setTransfers(cleaned.payload.transfers)
        setDuesCollections(cleaned.payload.duesCollections)
        setRemoteStatus(cleaned.changed ? '삭제된 참가자의 연결 데이터를 정리하고 있어요.' : `공유 정산 연결됨: ${record.id}`)
        const nextShareUrl = createShareUrl(record.share_token)
        setShareUrl(nextShareUrl)
        saveSettlementLink({
          id: record.id,
          token: record.share_token,
          title: getSavedSettlementTitle(cleaned.payload, record.title ?? '공유 정산'),
          url: nextShareUrl,
        })
        if (cleaned.changed) {
          void repairRemoteReferences(record.id, record.data, cleaned.payload)
            .then(() => setRemoteStatus('삭제된 참가자가 남긴 지출·송금·회비 참조를 정리했어요.'))
            .catch(() => setRemoteStatus('삭제된 참가자 참조를 정리하지 못했어요. 다시 시도해 주세요.'))
        }
      } catch {
        if (isCancelled) return
        setRemoteStatus('공유 정산을 불러오지 못했어요. URL을 확인해 주세요.')
      }
    }

    void load()

    return () => {
      isCancelled = true
    }
  }, [])

  useEffect(() => {
    if (!sharedSettlementId || !canUseRemoteStore()) return

    const applyRemoteRecord = (record: { id: string; data: SettlementPayload }) => {
      const cleaned = sanitizeSettlementPayload(parseSettlementPayload(record.data))
      const nextJson = JSON.stringify(cleaned.payload)
      if (nextJson === lastRemoteJsonRef.current) {
        return
      }
      suppressNextRemoteSaveRef.current = true
      lastRemoteJsonRef.current = nextJson
      setMembers(cleaned.payload.members)
      setExpenses(cleaned.payload.expenses)
      setTransfers(cleaned.payload.transfers)
      setDuesCollections(cleaned.payload.duesCollections)
      setRemoteStatus(cleaned.changed ? '삭제된 참가자의 연결 데이터를 정리하고 있어요.' : `다른 사람이 수정한 내용을 반영했어요: ${record.id}`)
      if (cleaned.changed) {
        void repairRemoteReferences(record.id, record.data, cleaned.payload)
          .then(() => setRemoteStatus('삭제된 참가자가 남긴 지출·송금·회비 참조를 정리했어요.'))
          .catch(() => setRemoteStatus('삭제된 참가자 참조를 정리하지 못했어요. 다시 시도해 주세요.'))
      }
    }

    const unsubscribe = subscribeSettlement(sharedSettlementId, applyRemoteRecord)

    const interval = window.setInterval(async () => {
      try {
        const record = await getSettlementById(sharedSettlementId)
        applyRemoteRecord(record)
      } catch {
        // noop
      }
    }, 2500)

    return () => {
      unsubscribe()
      window.clearInterval(interval)
    }
  }, [sharedSettlementId])

  useEffect(() => {
    if (!sharedSettlementId || !canUseRemoteStore()) return
    if (suppressNextRemoteSaveRef.current) {
      suppressNextRemoteSaveRef.current = false
      return
    }

    lastRemoteJsonRef.current = currentPayloadJson
  }, [sharedSettlementId, currentPayloadJson])

  const memberMap = useMemo(() => Object.fromEntries(members.map((member) => [member.id, member])), [members])
  const balances = useMemo(() => calculateBalances(currentPayload), [currentPayload])
  const settlementResult = useMemo(() => calculateSettlements(balances), [balances])
  const settlements = settlementResult.settlements
  const referenceRateExpenseCount = expenses.filter((expense) => expense.conversionMethod === 'rate').length
  const settlementError = settlementResult.imbalance === 0
    ? ''
    : `정산 합계가 ${currency.format(Math.abs(settlementResult.imbalance))}만큼 맞지 않아 자동 정산을 중단했어요. 데이터를 확인해 주세요.`

  const allMembersSelected = members.length > 0 && expenseForm.participantIds.length === members.length

  const addMember = async () => {
    const name = newMemberName.trim()
    if (!name) return

    const member = { id: sharedSettlementId ? createUuid() : createId(), name }

    if (sharedSettlementId && canUseRemoteStore()) {
      try {
        await addRemoteMember(sharedSettlementId, member)
        setMembers((current) => [...current, member])
      } catch (error) {
        const message = error instanceof Error ? error.message : typeof error === 'object' ? JSON.stringify(error) : String(error)
        setRemoteStatus(`참가자 추가 실패: ${message}`)
        return
      }
    } else {
      setMembers((current) => [...current, member])
    }

    setExpenseForm((current) => ({
      ...current,
      payerId: current.payerId || member.id,
      participantIds: current.participantIds.length === 0 ? [member.id] : [...current.participantIds, member.id],
    }))
    setTransferForm((current) => ({
      ...current,
      fromId: current.fromId || member.id,
      toId: current.toId || member.id,
    }))
    setNewMemberName('')
  }

  const updateMemberName = (memberId: string, name: string) => {
    const trimmed = name.trim()
    if (!trimmed) return

    if (sharedSettlementId && canUseRemoteStore()) {
      setMembers((current) => current.map((member) => member.id === memberId ? { ...member, name: trimmed } : member))
      void updateRemoteMember({ id: memberId, name: trimmed }).catch(() => setRemoteStatus('참가자 이름 수정에 실패했어요.'))
      return
    }

    setMembers((current) => current.map((member) => member.id === memberId ? { ...member, name: trimmed } : member))
  }

  const removeMember = (memberId: string) => {
    const memberName = memberMap[memberId]?.name ?? '이 참가자'
    const references = getMemberReferences(currentPayload, memberId)
    if (references.total > 0) {
      const details = [
        references.paidExpenses > 0 ? `결제 지출 ${references.paidExpenses}건` : '',
        references.participatedExpenses > 0 ? `참여 지출 ${references.participatedExpenses}건` : '',
        references.transfers > 0 ? `송금 ${references.transfers}건` : '',
        references.receivedDuesCollections > 0 ? `받은 회비 ${references.receivedDuesCollections}건` : '',
        references.paidDuesCollections > 0 ? `납부 회비 ${references.paidDuesCollections}건` : '',
      ].filter(Boolean).join(', ')
      setRemoteStatus(`${withSubjectParticle(memberName)} ${details}에 연결돼 있어 삭제할 수 없어요. 관련 내역을 먼저 수정하거나 삭제해 주세요.`)
      return
    }

    const shouldDelete = window.confirm(`${withObjectParticle(memberName)} 참가자 목록에서 삭제할까요?`)
    if (!shouldDelete) return

    const nextPayload = sanitizeSettlementPayload({
      members: members.filter((member) => member.id !== memberId),
      expenses,
      transfers,
      duesCollections,
    }).payload

    if (sharedSettlementId && canUseRemoteStore()) {
      suppressNextRemoteSaveRef.current = true
      lastRemoteJsonRef.current = JSON.stringify(nextPayload)
      setMembers(nextPayload.members)
      setExpenses(nextPayload.expenses)
      setTransfers(nextPayload.transfers)
      setDuesCollections(nextPayload.duesCollections)
      void (async () => {
        try {
          await repairRemoteReferences(sharedSettlementId, currentPayload, nextPayload)
          await deleteRemoteMember(memberId)
          setRemoteStatus(`${withSubjectParticle(memberName)} 삭제하고 관련 데이터를 정리했어요.`)
        } catch {
          setRemoteStatus('참가자 삭제 또는 관련 데이터 정리에 실패했어요.')
        }
      })()
    } else {
      setMembers(nextPayload.members)
      setExpenses(nextPayload.expenses)
      setTransfers(nextPayload.transfers)
      setDuesCollections(nextPayload.duesCollections)
    }
    setExpenseForm((current) => ({
      ...current,
      payerId: current.payerId === memberId ? '' : current.payerId,
      participantIds: current.participantIds.filter((id) => id !== memberId),
    }))
    setTransferForm((current) => ({
      ...current,
      fromId: current.fromId === memberId ? '' : current.fromId,
      toId: current.toId === memberId ? '' : current.toId,
    }))
    setCollectDuesForm((current) => ({
      ...current,
      receiverId: current.receiverId === memberId ? '' : current.receiverId,
    }))
  }

  const toggleExpenseParticipant = (memberId: string) => {
    setExpenseForm((current) => ({
      ...current,
      participantIds: current.participantIds.includes(memberId)
        ? current.participantIds.filter((id) => id !== memberId)
        : [...current.participantIds, memberId],
    }))
  }

  const toggleAllExpenseParticipants = () => {
    setExpenseForm((current) => ({
      ...current,
      participantIds: allMembersSelected ? [] : members.map((member) => member.id),
    }))
  }

  const setForeignCurrencyEnabled = (enabled: boolean) => {
    setForeignCurrencySettings((current) => ({ ...current, enabled }))
    setExpenseForm((current) => ({
      ...current,
      amount: '',
      currency: enabled ? foreignCurrencySettings.currency : 'KRW',
      exchangeRate: enabled ? foreignCurrencySettings.exchangeRate : '',
    }))
  }

  const setDefaultForeignCurrency = (nextCurrency: string) => {
    const previousCurrency = foreignCurrencySettings.currency
    setForeignCurrencySettings((current) => ({ ...current, currency: nextCurrency, exchangeRate: '' }))
    setExpenseForm((current) => current.currency === previousCurrency
      ? { ...current, amount: '', currency: nextCurrency, exchangeRate: '' }
      : current)
    setExpenseEditForm((current) => current.currency === previousCurrency
      ? { ...current, amount: '', currency: nextCurrency, exchangeRate: '' }
      : current)
  }

  const setDefaultExchangeRate = (nextExchangeRate: string) => {
    setForeignCurrencySettings((current) => ({ ...current, exchangeRate: nextExchangeRate }))
    setExpenseForm((current) => current.currency === foreignCurrencySettings.currency
      ? { ...current, exchangeRate: nextExchangeRate }
      : current)
    setExpenseEditForm((current) => current.currency === foreignCurrencySettings.currency
      ? { ...current, exchangeRate: nextExchangeRate }
      : current)
  }

  const setExpenseCurrency = (nextCurrency: string) => {
    setExpenseForm((current) => ({
      ...current,
      amount: '',
      currency: nextCurrency,
      exchangeRate: nextCurrency === 'KRW' ? '' : foreignCurrencySettings.exchangeRate,
    }))
  }

  const addExpense = async () => {
    const expenseMoney = resolveExpenseMoney(expenseForm)
    if (!expenseForm.title.trim()) {
      setRemoteStatus('지출 항목명을 입력해 주세요.')
      return
    }
    if (!expenseForm.payerId) {
      setRemoteStatus('지출 결제자를 선택해 주세요.')
      return
    }
    if (!expenseMoney) {
      setRemoteStatus(expenseForm.currency === 'KRW'
        ? '지출 금액을 올바르게 입력해 주세요.'
        : '외화 금액을 입력하고 설정에서 기준 환율을 올바르게 입력해 주세요.')
      return
    }

    const expense = {
      id: sharedSettlementId ? createUuid() : createId(),
      title: expenseForm.title.trim(),
      ...expenseMoney,
      payerId: expenseForm.payerId,
      participantIds: expenseForm.participantIds.length > 0 ? expenseForm.participantIds : [expenseForm.payerId],
    }

    if (sharedSettlementId && canUseRemoteStore()) {
      try {
        await addRemoteExpense(sharedSettlementId, expense)
        setExpenses((current) => [...current, expense])
      } catch (error) {
        const message = error instanceof Error ? error.message : typeof error === 'object' ? JSON.stringify(error) : String(error)
        setRemoteStatus(`지출 추가 실패: ${message}`)
        return
      }
    } else {
      setExpenses((current) => [...current, expense])
    }

    setExpenseForm((current) => ({ ...current, title: '', amount: '' }))
  }

  const addTransfer = async () => {
    const amount = evaluateAmountInput(transferForm.amount)
    if (!transferForm.fromId || !transferForm.toId) {
      setRemoteStatus('송금 보낸 사람과 받는 사람을 선택해 주세요.')
      return
    }
    if (transferForm.fromId === transferForm.toId) {
      setRemoteStatus('송금 보낸 사람과 받는 사람은 달라야 해요.')
      return
    }
    if (amount === null || amount <= 0) {
      setRemoteStatus('송금 금액을 올바르게 입력해 주세요.')
      return
    }

    const transfer = { id: sharedSettlementId ? createUuid() : createId(), amount, fromId: transferForm.fromId, toId: transferForm.toId }

    if (sharedSettlementId && canUseRemoteStore()) {
      try {
        await addRemoteTransfer(sharedSettlementId, transfer)
        setTransfers((current) => [...current, transfer])
      } catch (error) {
        const message = error instanceof Error ? error.message : typeof error === 'object' ? JSON.stringify(error) : String(error)
        setRemoteStatus(`송금 추가 실패: ${message}`)
        return
      }
    } else {
      setTransfers((current) => [...current, transfer])
    }

    setTransferForm((current) => ({ ...current, amount: '' }))
  }

  const openCollectDuesModal = () => {
    setCollectDuesForm((current) => ({
      ...current,
      title: current.title || `회비 ${duesCollections.length + 1}회차`,
      receiverId: current.receiverId || transferForm.toId || members[0]?.id || '',
    }))
    setIsCollectDuesModalOpen(true)
  }

  const syncDuesCollections = (nextDuesCollections: DuesCollection[], message?: string) => {
    setDuesCollections(nextDuesCollections)
    if (message) setExportMessage(message)

    if (!sharedSettlementId || !canUseRemoteStore()) return

    const nextPayload = { members, expenses, transfers, duesCollections: nextDuesCollections }
    lastRemoteJsonRef.current = JSON.stringify(nextPayload)
    void updateRemoteDuesCollections(sharedSettlementId, nextDuesCollections).catch((error) => {
      const message = error instanceof Error ? error.message : typeof error === 'object' ? JSON.stringify(error) : String(error)
      setRemoteStatus(`회비 저장 실패: ${message}`)
    })
  }

  const collectDues = () => {
    const amount = evaluateAmountInput(collectDuesForm.amount)
    const title = collectDuesForm.title.trim() || `회비 ${duesCollections.length + 1}회차`
    if (!collectDuesForm.receiverId) {
      setRemoteStatus('회비를 받을 총무를 선택해 주세요.')
      return
    }
    if (amount === null || amount <= 0) {
      setRemoteStatus('회비 금액을 올바르게 입력해 주세요.')
      return
    }

    const payerCount = members.filter((member) => member.id !== collectDuesForm.receiverId).length
    if (payerCount === 0) {
      setRemoteStatus('회비를 보낼 참가자가 없어요.')
      return
    }

    const duesCollection: DuesCollection = {
      id: sharedSettlementId ? createUuid() : createId(),
      title,
      amount,
      receiverId: collectDuesForm.receiverId,
      paidMemberIds: [],
    }

    syncDuesCollections([...duesCollections, duesCollection], `${title} 회비 회차를 만들었어요.`)
    setCollectDuesForm((current) => ({ ...current, title: '', amount: '' }))
    setIsCollectDuesModalOpen(false)
  }

  const exportData = () => {
    const payload: ImportPayload = { members, expenses, transfers, duesCollections }
    const text = JSON.stringify(payload, null, 2)
    const blob = new Blob([text], { type: 'application/json;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `trip-expense-split-export-${new Date().toISOString().slice(0, 10)}.json`
    document.body.appendChild(anchor)
    anchor.click()
    document.body.removeChild(anchor)
    URL.revokeObjectURL(url)
    setExportMessage('현재 정산 데이터를 JSON 파일로 다운로드했어요.')
  }

  const copySettlementSummary = async () => {
    if (settlementError) {
      setExportMessage(settlementError)
      return
    }
    if (settlements.length === 0) {
      setExportMessage('복사할 자동 정산 결과가 없어요.')
      return
    }

    const summary = settlements
      .map((item) => `${memberMap[item.fromId]?.name} → ${memberMap[item.toId]?.name} ${currency.format(item.amount)}`)
      .join('\n')

    setSummaryText(summary)
    setIsSummaryModalOpen(true)

    try {
      await navigator.clipboard.writeText(summary)
      setExportMessage('자동 정산 결과를 복사했어요.')
    } catch {
      setExportMessage('클립보드 복사가 안 돼서 결과 창을 열어뒀어요. 직접 복사해 주세요.')
    }
  }

  const resetCurrentSettlement = async () => {
    const shouldReset = window.confirm('현재 정산 내용을 전부 비울까요? 이 작업은 되돌리기 어려워요.')
    if (!shouldReset) return

    const nextPayload = emptyPayload()
    if (sharedSettlementId && canUseRemoteStore()) {
      setRemoteStatus('공유 정산을 초기화하고 있어요...')
      try {
        await updateSettlement(sharedSettlementId, nextPayload)
        suppressNextRemoteSaveRef.current = true
        lastRemoteJsonRef.current = JSON.stringify(nextPayload)
      } catch (error) {
        const message = error instanceof Error ? error.message : typeof error === 'object' ? JSON.stringify(error) : String(error)
        setRemoteStatus(`공유 정산 초기화 실패: ${message}`)
        return
      }
    }

    setMembers(nextPayload.members)
    setExpenses(nextPayload.expenses)
    setTransfers(nextPayload.transfers)
    setDuesCollections(nextPayload.duesCollections)
    setNewMemberName('')
    setExpenseForm({
      title: '',
      amount: '',
      payerId: '',
      participantIds: [],
      currency: foreignCurrencySettings.enabled ? foreignCurrencySettings.currency : 'KRW',
      exchangeRate: foreignCurrencySettings.exchangeRate,
    })
    setTransferForm({ amount: '', fromId: '', toId: '' })
    setCollectDuesForm({ title: '', amount: '', receiverId: '' })
    if (sharedSettlementId) setRemoteStatus('공유 정산을 초기화했어요.')
    setExportMessage('현재 정산을 비웠어요.')
  }

  const duplicateCurrentSettlement = () => {
    const cloneId = createId()
    window.localStorage.setItem(`${cloneStorageKeyPrefix}${cloneId}`, JSON.stringify(currentPayload))

    const nextWindow = window.open(createFreshSettlementUrl(cloneId), '_blank')
    if (!nextWindow) {
      window.localStorage.removeItem(`${cloneStorageKeyPrefix}${cloneId}`)
      setExportMessage('새 창을 열지 못했어요. 팝업 차단을 확인해 주세요.')
      return
    }

    setExportMessage('현재 정산을 새 창으로 복제했어요.')
  }

  const openNewSettlementWindow = () => {
    const nextWindow = window.open(createFreshSettlementUrl(), '_blank')
    if (!nextWindow) {
      setExportMessage('새 창을 열지 못했어요. 팝업 차단을 확인해 주세요.')
    }
  }

  const shareSettlement = async () => {
    if (!canUseRemoteStore()) {
      setRemoteStatus('Supabase 환경변수가 없어서 공유 링크를 만들 수 없어요.')
      return
    }

    try {
      let settlementId = sharedSettlementId
      let savedPayload = currentPayload

      if (!settlementId) {
        const record = await createSettlement('공유 정산')
        settlementId = record.id
        setSharedSettlementToken(record.share_token)
        const { payload: normalizedPayload, memberIdMap } = normalizePayloadForRemote(currentPayload)
        savedPayload = normalizedPayload
        setSharedSettlementId(settlementId)
        setMembers(normalizedPayload.members)
        setExpenses(normalizedPayload.expenses)
        setTransfers(normalizedPayload.transfers)
        setDuesCollections(normalizedPayload.duesCollections)
        setExpenseForm((current) => ({
          ...current,
          payerId: memberIdMap.get(current.payerId) ?? current.payerId,
          participantIds: current.participantIds.map((id) => memberIdMap.get(id) ?? id),
        }))
        setTransferForm((current) => ({
          ...current,
          fromId: memberIdMap.get(current.fromId) ?? current.fromId,
          toId: memberIdMap.get(current.toId) ?? current.toId,
        }))
        setExpenseEditForm((current) => ({
          ...current,
          payerId: memberIdMap.get(current.payerId) ?? current.payerId,
          participantIds: current.participantIds.map((id) => memberIdMap.get(id) ?? id),
        }))
        setTransferEditForm((current) => ({
          ...current,
          fromId: memberIdMap.get(current.fromId) ?? current.fromId,
          toId: memberIdMap.get(current.toId) ?? current.toId,
        }))
        setCollectDuesForm((current) => ({
          ...current,
          receiverId: memberIdMap.get(current.receiverId) ?? current.receiverId,
        }))
        setDuesEditForm((current) => ({
          ...current,
          receiverId: memberIdMap.get(current.receiverId) ?? current.receiverId,
          paidMemberIds: current.paidMemberIds.map((id) => memberIdMap.get(id) ?? id),
        }))
        await updateSettlement(settlementId, normalizedPayload)
      } else {
        await updateSettlement(settlementId, currentPayload)
      }

      const url = new URL(window.location.href)

      let token = sharedSettlementToken
      if (!token) {
        const latestRecord = await getSettlementById(settlementId)
        token = latestRecord.share_token
        setSharedSettlementToken(token)
      }

      url.searchParams.delete('settlement')
      url.searchParams.delete('token')
      url.searchParams.delete('fresh')
      url.searchParams.set('share', token)
      window.history.replaceState({}, '', url.toString())
      lastRemoteJsonRef.current = currentPayloadJson
      setShareUrl(url.toString())
      saveSettlementLink({
        id: settlementId,
        token,
        title: getSavedSettlementTitle(savedPayload),
        url: url.toString(),
      })
      setIsShareModalOpen(true)
      setRemoteStatus(`공유 링크를 만들었어요: ${settlementId}`)
    } catch (error) {
      let message = '알 수 없는 오류'
      if (error instanceof Error) {
        message = error.message
      } else if (error && typeof error === 'object') {
        const maybeError = error as { message?: string; details?: string; hint?: string; code?: string }
        message = [maybeError.message, maybeError.details, maybeError.hint, maybeError.code].filter(Boolean).join(' / ') || JSON.stringify(error)
      } else {
        message = String(error)
      }
      setRemoteStatus(`공유 링크 생성 실패: ${message}`)
    }
  }

  const importData = async () => {
    try {
      const cleaned = sanitizeSettlementPayload(parseSettlementPayload(JSON.parse(importText)))
      let importedPayload = cleaned.payload
      if (sharedSettlementId && canUseRemoteStore()) {
        const shouldOverwrite = window.confirm('가져온 데이터로 현재 공유 정산을 덮어쓸까요?')
        if (!shouldOverwrite) return
        importedPayload = normalizePayloadForRemote(cleaned.payload).payload
        setRemoteStatus('가져온 데이터를 공유 정산에 저장하고 있어요...')
        await updateSettlement(sharedSettlementId, importedPayload)
        suppressNextRemoteSaveRef.current = true
        lastRemoteJsonRef.current = JSON.stringify(importedPayload)
        setRemoteStatus('가져온 데이터를 공유 정산에 저장했어요.')
      }
      setMembers(importedPayload.members)
      setExpenses(importedPayload.expenses)
      setTransfers(importedPayload.transfers)
      setDuesCollections(importedPayload.duesCollections)
      setExpenseForm({
        title: '',
        amount: '',
        payerId: importedPayload.members[0]?.id ?? '',
        participantIds: importedPayload.members.map((member) => member.id),
        currency: foreignCurrencySettings.enabled ? foreignCurrencySettings.currency : 'KRW',
        exchangeRate: foreignCurrencySettings.exchangeRate,
      })
      setTransferForm({ amount: '', fromId: importedPayload.members[0]?.id ?? '', toId: importedPayload.members[1]?.id ?? importedPayload.members[0]?.id ?? '' })
      setCollectDuesForm({ title: '', amount: '', receiverId: importedPayload.members[0]?.id ?? '' })
      setImportMessage(cleaned.changed
        ? '가져오기에 성공했고, 삭제된 참가자가 남긴 연결 데이터도 정리했어요.'
        : '가져오기에 성공했어요. 이전 상태를 그대로 복구했습니다.')
      setIsImportModalOpen(false)
      setImportText('')
    } catch (error) {
      const message = error instanceof Error ? error.message : typeof error === 'object' ? JSON.stringify(error) : String(error)
      setImportMessage(`가져오기에 실패했어요: ${message}`)
    }
  }

  const openExpenseEdit = (expense: Expense) => {
    setEditingExpenseId(expense.id)
    setExpenseEditForm({
      title: expense.title,
      amount: String(expense.originalAmount ?? expense.amount),
      payerId: expense.payerId,
      participantIds: [...expense.participantIds],
      currency: expense.originalCurrency ?? 'KRW',
      exchangeRate: expense.originalCurrency === foreignCurrencySettings.currency
        ? foreignCurrencySettings.exchangeRate
        : expense.exchangeRate ? String(expense.exchangeRate) : '',
    })
  }

  const openTransferEdit = (transfer: Transfer) => {
    setEditingTransferId(transfer.id)
    setTransferEditForm({
      amount: String(transfer.amount),
      fromId: transfer.fromId,
      toId: transfer.toId,
    })
  }

  const openDuesCollectionEdit = (duesCollection: DuesCollection) => {
    setEditingDuesCollectionId(duesCollection.id)
    setDuesEditForm({
      title: duesCollection.title,
      amount: String(duesCollection.amount),
      receiverId: duesCollection.receiverId,
      paidMemberIds: [...duesCollection.paidMemberIds],
    })
  }

  const saveExpenseEdit = () => {
    if (!editingExpenseId) return
    const expenseMoney = resolveExpenseMoney(expenseEditForm)
    if (!expenseEditForm.title.trim() || !expenseEditForm.payerId || !expenseMoney) {
      setRemoteStatus('지출 수정 내용을 올바르게 입력해 주세요.')
      return
    }

    const nextExpense = {
      id: editingExpenseId,
      title: expenseEditForm.title.trim(),
      ...expenseMoney,
      payerId: expenseEditForm.payerId,
      participantIds: expenseEditForm.participantIds.length > 0 ? expenseEditForm.participantIds : [expenseEditForm.payerId],
    }

    if (sharedSettlementId && canUseRemoteStore()) {
      setExpenses((current) => current.map((expense) => expense.id !== editingExpenseId ? expense : nextExpense))
      void updateRemoteExpense(nextExpense).catch((error) => {
        const message = error instanceof Error ? error.message : '지출 수정에 실패했어요.'
        setRemoteStatus(message)
      })
    } else {
      setExpenses((current) => current.map((expense) => expense.id !== editingExpenseId ? expense : nextExpense))
    }
    setEditingExpenseId(null)
  }

  const saveTransferEdit = () => {
    if (!editingTransferId) return
    const amount = evaluateAmountInput(transferEditForm.amount)
    if (!transferEditForm.fromId || !transferEditForm.toId || transferEditForm.fromId === transferEditForm.toId) return
    if (amount === null || amount <= 0) return

    const nextTransfer = {
      id: editingTransferId,
      amount,
      fromId: transferEditForm.fromId,
      toId: transferEditForm.toId,
    }

    if (sharedSettlementId && canUseRemoteStore()) {
      setTransfers((current) => current.map((transfer) => transfer.id !== editingTransferId ? transfer : nextTransfer))
      void updateRemoteTransfer(nextTransfer).catch(() => setRemoteStatus('송금 수정에 실패했어요.'))
    } else {
      setTransfers((current) => current.map((transfer) => transfer.id !== editingTransferId ? transfer : nextTransfer))
    }
    setEditingTransferId(null)
  }

  const saveDuesCollectionEdit = () => {
    if (!editingDuesCollectionId) return
    const amount = evaluateAmountInput(duesEditForm.amount)
    const title = duesEditForm.title.trim()
    if (!title || !duesEditForm.receiverId || amount === null || amount <= 0) return

    const nextDuesCollections = duesCollections.map((duesCollection) => {
      if (duesCollection.id !== editingDuesCollectionId) return duesCollection

      return {
        ...duesCollection,
        title,
        amount,
        receiverId: duesEditForm.receiverId,
        paidMemberIds: duesEditForm.paidMemberIds.filter((id) => id !== duesEditForm.receiverId),
      }
    })

    syncDuesCollections(nextDuesCollections, `${title} 회비 회차를 수정했어요.`)
    setEditingDuesCollectionId(null)
  }

  const toggleExpenseEditParticipant = (memberId: string) => {
    setExpenseEditForm((current) => ({
      ...current,
      participantIds: current.participantIds.includes(memberId)
        ? current.participantIds.filter((id) => id !== memberId)
        : [...current.participantIds, memberId],
    }))
  }

  const toggleDuesPayment = (duesCollectionId: string, memberId: string) => {
    const nextDuesCollections = duesCollections.map((duesCollection) => {
      if (duesCollection.id !== duesCollectionId) return duesCollection

      return {
        ...duesCollection,
        paidMemberIds: duesCollection.paidMemberIds.includes(memberId)
          ? duesCollection.paidMemberIds.filter((id) => id !== memberId)
          : [...duesCollection.paidMemberIds, memberId],
      }
    })

    syncDuesCollections(nextDuesCollections)
  }

  const toggleDuesEditPayment = (memberId: string) => {
    setDuesEditForm((current) => ({
      ...current,
      paidMemberIds: current.paidMemberIds.includes(memberId)
        ? current.paidMemberIds.filter((id) => id !== memberId)
        : [...current.paidMemberIds, memberId],
    }))
  }

  const removeDuesCollection = (id: string) => {
    const duesCollection = duesCollections.find((item) => item.id === id)
    const title = duesCollection?.title ?? '이 회비 회차'
    const shouldDelete = window.confirm(`${title}를 삭제할까요? 납부 체크 내역도 함께 삭제돼요.`)
    if (!shouldDelete) return

    syncDuesCollections(duesCollections.filter((item) => item.id !== id), `${title}를 삭제했어요.`)
  }

  const removeExpense = (id: string) => {
    if (sharedSettlementId && canUseRemoteStore()) {
      setExpenses((current) => current.filter((expense) => expense.id !== id))
      void deleteRemoteExpense(id).catch(() => setRemoteStatus('지출 삭제에 실패했어요.'))
      return
    }
    setExpenses((current) => current.filter((expense) => expense.id !== id))
  }

  const removeTransfer = (id: string) => {
    if (sharedSettlementId && canUseRemoteStore()) {
      setTransfers((current) => current.filter((transfer) => transfer.id !== id))
      void deleteRemoteTransfer(id).catch(() => setRemoteStatus('송금 삭제에 실패했어요.'))
      return
    }
    setTransfers((current) => current.filter((transfer) => transfer.id !== id))
  }

  return (
    <div className="app-shell">
      <header className="hero">
        <div>
          <p className="eyebrow">여행 정산 앱</p>
          <h1>여행 경비 정산, 깔끔하게 끝내기</h1>
          <p className="subtitle">여행 중 사용한 돈, 송금 내역, 같이 쓴 사람만 넣으면 자동으로 정산 결과를 계산해줘요.</p>
        </div>
        <div className="hero-actions">
          <button onClick={openNewSettlementWindow}>새 정산</button>
          <button onClick={shareSettlement}>공유하기</button>
        </div>
        {(exportMessage || remoteStatus) && <p className="helper export-message compact-status">{remoteStatus}{exportMessage ? ` · ${exportMessage}` : ''}</p>}
      </header>

      <main className="layout">
        <section className="panel">
          <div className="section-header-with-actions">
            <h2>참가자</h2>
            <button onClick={() => setIsMembersModalOpen(true)}>참가자 관리</button>
          </div>
          <div className="chips">
            {members.length === 0 ? (
              <div className="empty">아직 참가자가 없어요.</div>
            ) : (
              members.map((member) => (
                <span key={member.id} className="chip">
                  {member.name}
                </span>
              ))
            )}
          </div>
        </section>

        <section className="panel two-column">
          <div className="form-section">
            <div className="expense-section-heading">
              <h2>지출 추가</h2>
              {foreignCurrencySettings.enabled && (
                <div className="foreign-mode-status">
                  해외 통화 사용 중 · 기본 {foreignCurrencySettings.currency}
                  <a href="#currency-settings">설정 변경</a>
                </div>
              )}
            </div>
            <div className="form-grid">
              <input value={expenseForm.title} onChange={(event) => setExpenseForm((current) => ({ ...current, title: event.target.value }))} placeholder="항목명" />
              {foreignCurrencySettings.enabled && (
                <select aria-label="결제 통화" value={expenseForm.currency} onChange={(event) => setExpenseCurrency(event.target.value)}>
                  <option value="KRW">대한민국 원 (KRW)</option>
                  <option value={foreignCurrencySettings.currency}>
                    {supportedForeignCurrencies.find((item) => item.code === foreignCurrencySettings.currency)?.label ?? foreignCurrencySettings.currency}
                  </option>
                </select>
              )}
              <input
                value={expenseForm.amount}
                onChange={(event) => setExpenseForm((current) => ({ ...current, amount: event.target.value }))}
                placeholder={expenseForm.currency === 'KRW' ? '금액 (예: 12000+8000)' : `${expenseForm.currency} 결제 금액`}
                inputMode={expenseForm.currency === 'KRW' ? 'text' : 'decimal'}
              />
              <select value={expenseForm.payerId} onChange={(event) => setExpenseForm((current) => ({ ...current, payerId: event.target.value }))}>
                <option value="">결제자 선택</option>
                {members.map((member) => (
                  <option key={member.id} value={member.id}>{withSubjectParticle(member.name)} 결제</option>
                ))}
              </select>
            </div>
            <div className="participant-box">
              <p className="helper">누가 같이 썼는지 선택</p>
              <div className="checkbox-list">
                {members.length > 0 && (
                  <label>
                    <input type="checkbox" checked={allMembersSelected} onChange={toggleAllExpenseParticipants} />
                    전원(모두)
                  </label>
                )}
                {members.map((member) => (
                  <label key={member.id}>
                    <input type="checkbox" checked={expenseForm.participantIds.includes(member.id)} onChange={() => toggleExpenseParticipant(member.id)} />
                    {member.name}
                  </label>
                ))}
              </div>
            </div>
            <button onClick={addExpense}>지출 저장</button>
          </div>

          <div className="form-section">
            <h2>송금 기록</h2>
            <div className="form-grid">
              <input value={transferForm.amount} onChange={(event) => setTransferForm((current) => ({ ...current, amount: event.target.value }))} placeholder="송금 금액 (예: 5000+2500)" inputMode="text" />
              <select value={transferForm.fromId} onChange={(event) => setTransferForm((current) => ({ ...current, fromId: event.target.value }))}>
                <option value="">보내는 사람 선택</option>
                {members.map((member) => (
                  <option key={member.id} value={member.id}>{withSubjectParticle(member.name)} 보냄</option>
                ))}
              </select>
              <select value={transferForm.toId} onChange={(event) => setTransferForm((current) => ({ ...current, toId: event.target.value }))}>
                <option value="">받는 사람 선택</option>
                {members.map((member) => (
                  <option key={member.id} value={member.id}>{withSubjectParticle(member.name)} 받음</option>
                ))}
              </select>
            </div>
            <button onClick={addTransfer}>송금 저장</button>
          </div>
        </section>

        <section className="panel">
          <div className="section-header-with-actions">
            <div>
              <h2>회비 걷기</h2>
              <p className="helper">회차별로 금액, 총무, 납부 여부를 관리해요. 납부 체크된 내역만 정산에 반영됩니다.</p>
            </div>
            <button onClick={openCollectDuesModal}>회비 회차 추가</button>
          </div>
          <div className="dues-list">
            {duesCollections.length === 0 ? (
              <div className="empty">아직 회비 회차가 없어요.</div>
            ) : (
              duesCollections.map((duesCollection) => {
                const payerIds = members.map((member) => member.id).filter((id) => id !== duesCollection.receiverId)
                const paidCount = duesCollection.paidMemberIds.filter((id) => payerIds.includes(id)).length

                return (
                  <div key={duesCollection.id} className="dues-card">
                    <div className="dues-card-header">
                      <div>
                        <strong>{duesCollection.title}</strong>
                        <p>{memberMap[duesCollection.receiverId]?.name ?? '총무 미선택'} 받음 · {currency.format(duesCollection.amount)} · {paidCount}/{payerIds.length}명 납부</p>
                      </div>
                      <div className="history-side">
                        <button onClick={() => openDuesCollectionEdit(duesCollection)}>수정</button>
                        <button onClick={() => removeDuesCollection(duesCollection.id)}>삭제</button>
                      </div>
                    </div>
                    <div className="checkbox-list dues-checkbox-list">
                      {members.length <= 1 ? (
                        <div className="empty">납부 체크할 참가자가 없어요.</div>
                      ) : (
                        members.map((member) => (
                          <label key={member.id} className={member.id === duesCollection.receiverId ? 'disabled-checkbox-label' : ''}>
                            <input
                              type="checkbox"
                              checked={duesCollection.paidMemberIds.includes(member.id)}
                              disabled={member.id === duesCollection.receiverId}
                              onChange={() => toggleDuesPayment(duesCollection.id, member.id)}
                            />
                            {member.name}{member.id === duesCollection.receiverId ? ' (총무)' : ''}
                          </label>
                        ))
                      )}
                    </div>
                  </div>
                )
              })
            )}
          </div>
        </section>

        <section className="panel">
          <div className="section-header-with-actions">
            <div>
              <h2>자동 정산 결과</h2>
              {referenceRateExpenseCount > 0 && (
                <p className="foreign-settlement-warning">
                  설정 기준 환율로 계산된 외화 지출 {referenceRateExpenseCount}건이 정산에 반영됐어요.
                </p>
              )}
            </div>
            <button onClick={copySettlementSummary}>정산 결과 복사</button>
          </div>
          <div className="settlement-list">
            {settlementError ? (
              <div className="empty">{settlementError}</div>
            ) : settlements.length === 0 ? (
              <div className="empty">현재 추가 송금 없이도 거의 정산이 맞아떨어져요.</div>
            ) : (
              settlements.map((settlement, index) => (
                <div key={`${settlement.fromId}-${settlement.toId}-${index}`} className="settlement-item">
                  <strong>{memberMap[settlement.fromId]?.name}</strong>
                  <span>→</span>
                  <strong>{memberMap[settlement.toId]?.name}</strong>
                  <em>{currency.format(settlement.amount)}</em>
                </div>
              ))
            )}
          </div>
        </section>

        <section className="panel two-column">
          <div>
            <h2>정산표</h2>
            <div className="table-wrap desktop-only">
              <table>
                <thead>
                  <tr>
                    <th>이름</th>
                    <th>결제</th>
                    <th>분담</th>
                    <th>정산 차액</th>
                  </tr>
                </thead>
                <tbody>
                  {balances.map((row) => (
                    <tr key={row.memberId}>
                      <td>{memberMap[row.memberId]?.name}</td>
                      <td>{currency.format(row.paid)}</td>
                      <td>{currency.format(row.share)}</td>
                      <td className={row.net >= 0 ? 'positive' : 'negative'}>{row.net >= 0 ? '+' : '-'}{currency.format(Math.abs(row.net))}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="mobile-balance-list mobile-only">
              {balances.map((row) => (
                <div key={row.memberId} className="mobile-balance-card">
                  <strong>{memberMap[row.memberId]?.name}</strong>
                  <div><span>결제</span><em>{currency.format(row.paid)}</em></div>
                  <div><span>분담</span><em>{currency.format(row.share)}</em></div>
                  <div><span>정산 차액</span><em className={row.net >= 0 ? 'positive' : 'negative'}>{row.net >= 0 ? '+' : '-'}{currency.format(Math.abs(row.net))}</em></div>
                </div>
              ))}
            </div>
          </div>

          <div>
            <h2>입력된 내역</h2>
            <h3>지출</h3>
            <div className="history-list desktop-only">
              {expenses.length === 0 ? (
                <div className="empty">아직 입력된 지출이 없어요.</div>
              ) : (
                expenses.map((expense) => (
                  <div key={expense.id} className="history-item">
                    <div className="history-main">
                      <strong>{expense.title}</strong>
                      <p>{withSubjectParticle(memberMap[expense.payerId]?.name ?? '')} 결제, {expense.participantIds.map((id) => memberMap[id]?.name).filter(Boolean).join(', ')} 사용</p>
                      {expense.originalAmount && expense.originalCurrency && expense.exchangeRate && expense.conversionMethod && (
                        <p className="foreign-history-detail">
                          {formatForeignCurrency(expense.originalAmount, expense.originalCurrency)} · 1 {expense.originalCurrency} = {rateFormatter.format(expense.exchangeRate)}원
                          <em className={expense.conversionMethod === 'rate' ? 'estimate-badge' : 'actual-badge'}>{expense.conversionMethod === 'rate' ? '기준 환율' : '기존 청구액'}</em>
                        </p>
                      )}
                    </div>
                    <span className="history-amount">{currency.format(expense.amount)}</span>
                    <div className="history-side">
                      <button onClick={() => openExpenseEdit(expense)}>수정</button>
                      <button onClick={() => removeExpense(expense.id)}>삭제</button>
                    </div>
                  </div>
                ))
              )}
            </div>
            <div className="mobile-only mobile-history-list">
              {expenses.length === 0 ? (
                <div className="empty">아직 입력된 지출이 없어요.</div>
              ) : (
                expenses.map((expense) => (
                  <div key={expense.id} className="mobile-history-card">
                    <strong>{expense.title}</strong>
                    <p>{withSubjectParticle(memberMap[expense.payerId]?.name ?? '')} 결제</p>
                    <p>{expense.participantIds.map((id) => memberMap[id]?.name).filter(Boolean).join(', ')} 사용</p>
                    {expense.originalAmount && expense.originalCurrency && expense.exchangeRate && expense.conversionMethod && (
                      <p className="foreign-history-detail">
                        {formatForeignCurrency(expense.originalAmount, expense.originalCurrency)} · 1 {expense.originalCurrency} = {rateFormatter.format(expense.exchangeRate)}원
                        <em className={expense.conversionMethod === 'rate' ? 'estimate-badge' : 'actual-badge'}>{expense.conversionMethod === 'rate' ? '기준 환율' : '기존 청구액'}</em>
                      </p>
                    )}
                    <em className="history-amount">{currency.format(expense.amount)}</em>
                    <div className="history-side">
                      <button onClick={() => openExpenseEdit(expense)}>수정</button>
                      <button onClick={() => removeExpense(expense.id)}>삭제</button>
                    </div>
                  </div>
                ))
              )}
            </div>

            <h3>송금</h3>
            <div className="history-list desktop-only">
              {transfers.length === 0 ? (
                <div className="empty">아직 기록된 송금이 없어요.</div>
              ) : (
                transfers.map((transfer) => (
                  <div key={transfer.id} className="history-item">
                    <div className="history-main">
                      <strong>{memberMap[transfer.fromId]?.name} → {memberMap[transfer.toId]?.name}</strong>
                    </div>
                    <span className="history-amount">{currency.format(transfer.amount)}</span>
                    <div className="history-side">
                      <button onClick={() => openTransferEdit(transfer)}>수정</button>
                      <button onClick={() => removeTransfer(transfer.id)}>삭제</button>
                    </div>
                  </div>
                ))
              )}
            </div>
            <div className="mobile-only mobile-history-list">
              {transfers.length === 0 ? (
                <div className="empty">아직 기록된 송금이 없어요.</div>
              ) : (
                transfers.map((transfer) => (
                  <div key={transfer.id} className="mobile-history-card">
                    <strong>{memberMap[transfer.fromId]?.name} → {memberMap[transfer.toId]?.name}</strong>
                    <em className="history-amount">{currency.format(transfer.amount)}</em>
                    <div className="history-side">
                      <button onClick={() => openTransferEdit(transfer)}>수정</button>
                      <button onClick={() => removeTransfer(transfer.id)}>삭제</button>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </section>

        <section className="panel saved-settlements-panel">
          <div className="section-header-with-actions">
            <div>
              <h2>저장된 정산</h2>
              <p className="helper">공유 링크를 만들거나 공유 링크로 접속하면 이 브라우저에 자동으로 저장돼요.</p>
            </div>
          </div>
          <div className="saved-settlement-list">
            {savedSettlementLinks.length === 0 ? (
              <div className="empty">아직 저장된 공유 정산이 없어요.</div>
            ) : (
              savedSettlementLinks.map((savedLink) => (
                <div key={savedLink.token} className="saved-settlement-item">
                  <div className="history-main">
                    <strong>{savedLink.title}</strong>
                    <p>{savedDateFormatter.format(new Date(savedLink.savedAt))} 저장 · {savedLink.id}</p>
                  </div>
                  <div className="history-side">
                    <button onClick={() => openSavedSettlementLink(savedLink.url)}>열기</button>
                    <button onClick={() => removeSavedSettlementLink(savedLink.token)}>삭제</button>
                  </div>
                </div>
              ))
            )}
          </div>
        </section>

        <section className="panel utility-panel">
          <h2>가져오기 / 내보내기</h2>
          <p className="helper">DB 공유 기능이 있어서 자주 쓰진 않지만, 백업이나 수동 복구가 필요할 때 사용할 수 있어요.</p>
          <div className="hero-actions">
            <button onClick={() => setIsImportModalOpen(true)}>Import</button>
            <button onClick={exportData}>Export</button>
            <button onClick={duplicateCurrentSettlement}>현재 정산 복제</button>
            <button onClick={resetCurrentSettlement}>전체 초기화</button>
          </div>
        </section>

        <section id="currency-settings" className="panel settings-panel">
          <div className="section-header-with-actions">
            <div>
              <h2>설정</h2>
              <p className="helper">필요할 때만 외화 입력을 켤 수 있어요. 자동 정산 결과는 항상 원화로 계산됩니다.</p>
            </div>
            <label className="setting-toggle">
              <input
                type="checkbox"
                checked={foreignCurrencySettings.enabled}
                onChange={(event) => setForeignCurrencyEnabled(event.target.checked)}
              />
              <span>
                <strong>해외 통화 입력</strong>
                <small>{foreignCurrencySettings.enabled ? '사용 중' : '사용 안 함'}</small>
              </span>
            </label>
          </div>
          {foreignCurrencySettings.enabled && (
            <div className="currency-settings-grid">
              <label className="currency-input-label">
                <span>기본 현지 통화</span>
                <select value={foreignCurrencySettings.currency} onChange={(event) => setDefaultForeignCurrency(event.target.value)}>
                  {supportedForeignCurrencies.map((item) => (
                    <option key={item.code} value={item.code}>{item.label}</option>
                  ))}
                </select>
              </label>
              <label className="currency-input-label">
                <span>1 {foreignCurrencySettings.currency}당 기준 환율</span>
                <input
                  value={foreignCurrencySettings.exchangeRate}
                  onChange={(event) => setDefaultExchangeRate(event.target.value)}
                  placeholder="예: 9.3원"
                  inputMode="decimal"
                />
              </label>
              <div className="base-currency-card">
                <span>정산 기준 통화</span>
                <strong>대한민국 원 (KRW)</strong>
                <small>송금·회비·최종 정산은 원화로 입력해요.</small>
              </div>
            </div>
          )}
        </section>
      </main>

      {isSummaryModalOpen && (
        <div className="modal-backdrop" onClick={() => setIsSummaryModalOpen(false)}>
          <div className="modal-card" onClick={(event) => event.stopPropagation()}>
            <div className="modal-header">
              <h2>정산 결과</h2>
              <button className="ghost-button" onClick={() => setIsSummaryModalOpen(false)}>닫기</button>
            </div>
            <p className="helper">클립보드 복사가 안 되면 아래 내용을 직접 복사해 쓰면 돼요.</p>
            <textarea value={summaryText} readOnly rows={8} />
          </div>
        </div>
      )}

      {isMembersModalOpen && (
        <div className="modal-backdrop" onClick={() => setIsMembersModalOpen(false)}>
          <div className="modal-card" onClick={(event) => event.stopPropagation()}>
            <div className="modal-header">
              <h2>참가자 관리</h2>
              <button className="ghost-button" onClick={() => setIsMembersModalOpen(false)}>닫기</button>
            </div>
            <div className="member-manage-list">
              {members.length === 0 ? (
                <div className="empty">아직 참가자가 없어요.</div>
              ) : (
                members.map((member) => (
                  <div key={member.id} className="member-manage-row">
                    <input
                      value={member.name}
                      onChange={(event) => updateMemberName(member.id, event.target.value)}
                      placeholder="이름"
                    />
                    <button onClick={() => removeMember(member.id)}>삭제</button>
                  </div>
                ))
              )}
            </div>
            <div className="inline-form">
              <input
                value={newMemberName}
                onChange={(event) => setNewMemberName(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key !== 'Enter') return
                  event.preventDefault()
                  void addMember()
                }}
                placeholder="새 참가자 추가"
              />
              <button onClick={() => void addMember()}>추가</button>
            </div>
          </div>
        </div>
      )}

      {isShareModalOpen && (
        <div className="modal-backdrop" onClick={() => setIsShareModalOpen(false)}>
          <div className="modal-card" onClick={(event) => event.stopPropagation()}>
            <div className="modal-header">
              <h2>공유 링크</h2>
              <button className="ghost-button" onClick={() => setIsShareModalOpen(false)}>닫기</button>
            </div>
            <p className="helper">아래 URL을 복사해서 보내면 같은 정산을 함께 수정할 수 있어요.</p>
            <textarea value={currentShareUrl} readOnly rows={4} />
          </div>
        </div>
      )}

      {isCollectDuesModalOpen && (
        <div className="modal-backdrop" onClick={() => setIsCollectDuesModalOpen(false)}>
          <div className="modal-card" onClick={(event) => event.stopPropagation()}>
            <div className="modal-header">
              <h2>회비 걷기</h2>
              <button className="ghost-button" onClick={() => setIsCollectDuesModalOpen(false)}>닫기</button>
            </div>
            <p className="helper">회차를 만든 뒤 참가자별 납부 여부를 체크하면 정산에 반영돼요.</p>
            <div className="form-grid">
              <input
                value={collectDuesForm.title}
                onChange={(event) => setCollectDuesForm((current) => ({ ...current, title: event.target.value }))}
                placeholder="회차명 (예: 1차 회비)"
              />
              <input
                value={collectDuesForm.amount}
                onChange={(event) => setCollectDuesForm((current) => ({ ...current, amount: event.target.value }))}
                onKeyDown={(event) => {
                  if (event.key !== 'Enter') return
                  event.preventDefault()
                  void collectDues()
                }}
                placeholder="1인당 회비 (예: 30000)"
                inputMode="text"
              />
              <select
                value={collectDuesForm.receiverId}
                onChange={(event) => setCollectDuesForm((current) => ({ ...current, receiverId: event.target.value }))}
              >
                <option value="">총무 선택</option>
                {members.map((member) => (
                  <option key={member.id} value={member.id}>{withSubjectParticle(member.name)} 받음</option>
                ))}
              </select>
            </div>
            <button onClick={collectDues}>회비 회차 만들기</button>
          </div>
        </div>
      )}

      {editingDuesCollectionId && (
        <div className="modal-backdrop" onClick={() => setEditingDuesCollectionId(null)}>
          <div className="modal-card" onClick={(event) => event.stopPropagation()}>
            <div className="modal-header">
              <h2>회비 회차 수정</h2>
              <button className="ghost-button" onClick={() => setEditingDuesCollectionId(null)}>닫기</button>
            </div>
            <div className="form-grid">
              <input
                value={duesEditForm.title}
                onChange={(event) => setDuesEditForm((current) => ({ ...current, title: event.target.value }))}
                placeholder="회차명"
              />
              <input
                value={duesEditForm.amount}
                onChange={(event) => setDuesEditForm((current) => ({ ...current, amount: event.target.value }))}
                placeholder="1인당 회비"
                inputMode="text"
              />
              <select
                value={duesEditForm.receiverId}
                onChange={(event) => setDuesEditForm((current) => ({
                  ...current,
                  receiverId: event.target.value,
                  paidMemberIds: current.paidMemberIds.filter((id) => id !== event.target.value),
                }))}
              >
                <option value="">총무 선택</option>
                {members.map((member) => (
                  <option key={member.id} value={member.id}>{withSubjectParticle(member.name)} 받음</option>
                ))}
              </select>
            </div>
            <div className="checkbox-list">
              {members.map((member) => (
                <label key={member.id} className={member.id === duesEditForm.receiverId ? 'disabled-checkbox-label' : ''}>
                  <input
                    type="checkbox"
                    checked={duesEditForm.paidMemberIds.includes(member.id)}
                    disabled={member.id === duesEditForm.receiverId}
                    onChange={() => toggleDuesEditPayment(member.id)}
                  />
                  {member.name}{member.id === duesEditForm.receiverId ? ' (총무)' : ''}
                </label>
              ))}
            </div>
            <button onClick={saveDuesCollectionEdit}>수정 저장</button>
          </div>
        </div>
      )}

      {editingExpenseId && (
        <div className="modal-backdrop" onClick={() => setEditingExpenseId(null)}>
          <div className="modal-card" onClick={(event) => event.stopPropagation()}>
            <div className="modal-header">
              <h2>지출 수정</h2>
              <button className="ghost-button" onClick={() => setEditingExpenseId(null)}>닫기</button>
            </div>
            <div className="form-grid">
              <input value={expenseEditForm.title} onChange={(event) => setExpenseEditForm((current) => ({ ...current, title: event.target.value }))} placeholder="항목명" />
              {(foreignCurrencySettings.enabled || expenseEditForm.currency !== 'KRW') && (
                <select
                  aria-label="결제 통화"
                  value={expenseEditForm.currency}
                  onChange={(event) => setExpenseEditForm((current) => ({
                    ...current,
                    amount: '',
                    currency: event.target.value,
                    exchangeRate: event.target.value === 'KRW' ? '' : foreignCurrencySettings.exchangeRate,
                  }))}
                >
                  <option value="KRW">대한민국 원 (KRW)</option>
                  {expenseEditForm.currency !== 'KRW' && expenseEditForm.currency !== foreignCurrencySettings.currency && (
                    <option value={expenseEditForm.currency}>{expenseEditForm.currency}</option>
                  )}
                  <option value={foreignCurrencySettings.currency}>
                    {supportedForeignCurrencies.find((item) => item.code === foreignCurrencySettings.currency)?.label ?? foreignCurrencySettings.currency}
                  </option>
                </select>
              )}
              <input
                value={expenseEditForm.amount}
                onChange={(event) => setExpenseEditForm((current) => ({ ...current, amount: event.target.value }))}
                placeholder={expenseEditForm.currency === 'KRW' ? '금액 (예: 12000+8000)' : `${expenseEditForm.currency} 결제 금액`}
                inputMode={expenseEditForm.currency === 'KRW' ? 'text' : 'decimal'}
              />
              <select value={expenseEditForm.payerId} onChange={(event) => setExpenseEditForm((current) => ({ ...current, payerId: event.target.value }))}>
                <option value="">결제자 선택</option>
                {members.map((member) => (
                  <option key={member.id} value={member.id}>{withSubjectParticle(member.name)} 결제</option>
                ))}
              </select>
            </div>
            <div className="checkbox-list">
              {members.map((member) => (
                <label key={member.id}>
                  <input type="checkbox" checked={expenseEditForm.participantIds.includes(member.id)} onChange={() => toggleExpenseEditParticipant(member.id)} />
                  {member.name}
                </label>
              ))}
            </div>
            <button onClick={saveExpenseEdit}>수정 저장</button>
          </div>
        </div>
      )}

      {editingTransferId && (
        <div className="modal-backdrop" onClick={() => setEditingTransferId(null)}>
          <div className="modal-card" onClick={(event) => event.stopPropagation()}>
            <div className="modal-header">
              <h2>송금 수정</h2>
              <button className="ghost-button" onClick={() => setEditingTransferId(null)}>닫기</button>
            </div>
            <div className="form-grid">
              <input value={transferEditForm.amount} onChange={(event) => setTransferEditForm((current) => ({ ...current, amount: event.target.value }))} placeholder="송금 금액 (예: 5000+2500)" inputMode="text" />
              <select value={transferEditForm.fromId} onChange={(event) => setTransferEditForm((current) => ({ ...current, fromId: event.target.value }))}>
                <option value="">보내는 사람 선택</option>
                {members.map((member) => (
                  <option key={member.id} value={member.id}>{withSubjectParticle(member.name)} 보냄</option>
                ))}
              </select>
              <select value={transferEditForm.toId} onChange={(event) => setTransferEditForm((current) => ({ ...current, toId: event.target.value }))}>
                <option value="">받는 사람 선택</option>
                {members.map((member) => (
                  <option key={member.id} value={member.id}>{withSubjectParticle(member.name)} 받음</option>
                ))}
              </select>
            </div>
            <button onClick={saveTransferEdit}>수정 저장</button>
          </div>
        </div>
      )}

      {isImportModalOpen && (
        <div className="modal-backdrop" onClick={() => setIsImportModalOpen(false)}>
          <div className="modal-card" onClick={(event) => event.stopPropagation()}>
            <div className="modal-header">
              <h2>Import</h2>
              <button className="ghost-button" onClick={() => setIsImportModalOpen(false)}>닫기</button>
            </div>
            <p className="helper">Export한 JSON 전체를 그대로 붙여넣으면 현재 상태를 복구할 수 있어요.</p>
            <textarea value={importText} onChange={(event) => setImportText(event.target.value)} placeholder='{"members":[],"expenses":[],"transfers":[]}' rows={10} />
            <div className="import-actions">
              <button onClick={importData}>불러오기</button>
              <span className="helper">{importMessage}</span>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default App
