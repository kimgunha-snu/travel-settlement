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
  updateRemoteExpense,
  updateRemoteMember,
  updateRemoteTransfer,
  updateSettlement,
  type SettlementPayload,
} from './lib/settlementStore'

type Member = {
  id: string
  name: string
}

type Expense = {
  id: string
  title: string
  amount: number
  payerId: string
  participantIds: string[]
}

type Transfer = {
  id: string
  amount: number
  fromId: string
  toId: string
}

type BalanceRow = {
  memberId: string
  paid: number
  share: number
  transferredOut: number
  transferredIn: number
  net: number
}

type Settlement = {
  id: string
  fromId: string
  toId: string
  amount: number
}

type ImportPayload = SettlementPayload

const currency = new Intl.NumberFormat('ko-KR', {
  style: 'currency',
  currency: 'KRW',
  maximumFractionDigits: 0,
})

const storageKey = 'travel-settlement-app-data'
const createId = () => Math.random().toString(36).slice(2, 10)
const createUuid = () => 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (char) => {
  const random = Math.random() * 16 | 0
  const value = char === 'x' ? random : (random & 0x3) | 0x8
  return value.toString(16)
})

const emptyPayload = (): ImportPayload => ({ members: [], expenses: [], transfers: [] })

const evaluateAmountInput = (value: string) => {
  const sanitized = value.replace(/,/g, '').trim()
  if (!sanitized) return null
  if (!/^[0-9+\-*/().\s]+$/.test(sanitized)) return null

  try {
    const result = Function(`"use strict"; return (${sanitized})`)()
    if (typeof result !== 'number' || !Number.isFinite(result)) return null
    return result
  } catch {
    return null
  }
}

const readStoredData = (): ImportPayload => {
  if (shouldStartFreshFromUrl()) return emptyPayload()

  try {
    const raw = window.localStorage.getItem(storageKey)
    if (!raw) return emptyPayload()
    const parsed = JSON.parse(raw) as Partial<ImportPayload>
    return {
      members: Array.isArray(parsed.members) ? parsed.members : [],
      expenses: Array.isArray(parsed.expenses) ? parsed.expenses : [],
      transfers: Array.isArray(parsed.transfers) ? parsed.transfers : [],
    }
  } catch {
    return emptyPayload()
  }
}

const getUrl = () => new URL(window.location.href)
const getSettlementIdFromUrl = () => getUrl().searchParams.get('settlement') ?? ''
const getSettlementTokenFromUrl = () => getUrl().searchParams.get('token') ?? ''
const getShareTokenFromUrl = () => getUrl().searchParams.get('share') ?? ''

const shouldStartFreshFromUrl = () => getUrl().searchParams.get('fresh') === '1'

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

  return {
    payload: { members, expenses, transfers },
    memberIdMap,
  }
}

function App() {
  const [members, setMembers] = useState<Member[]>(() => readStoredData().members)
  const [expenses, setExpenses] = useState<Expense[]>(() => readStoredData().expenses)
  const [transfers, setTransfers] = useState<Transfer[]>(() => readStoredData().transfers)
  const [newMemberName, setNewMemberName] = useState('')
  const [expenseForm, setExpenseForm] = useState({
    title: '',
    amount: '',
    payerId: '',
    participantIds: [] as string[],
  })
  const [transferForm, setTransferForm] = useState({
    amount: '',
    fromId: '',
    toId: '',
  })
  const [isImportModalOpen, setIsImportModalOpen] = useState(false)
  const [importText, setImportText] = useState('')
  const [importMessage, setImportMessage] = useState('내보낸 데이터(JSON)를 붙여넣으면 지금 상태를 그대로 복구할 수 있어요.')
  const [exportMessage, setExportMessage] = useState('')
  const [isSummaryModalOpen, setIsSummaryModalOpen] = useState(false)
  const [summaryText, setSummaryText] = useState('')
  const [remoteStatus, setRemoteStatus] = useState(canUseRemoteStore() ? '공유 기능 사용 가능' : 'Supabase 환경변수 미설정')
  const [sharedSettlementId, setSharedSettlementId] = useState(() => getSettlementIdFromUrl())
  const [sharedSettlementToken, setSharedSettlementToken] = useState(() => getShareTokenFromUrl() || getSettlementTokenFromUrl())
  const [isShareModalOpen, setIsShareModalOpen] = useState(false)
  const [shareUrl, setShareUrl] = useState('')
  const [editingExpenseId, setEditingExpenseId] = useState<string | null>(null)
  const [editingTransferId, setEditingTransferId] = useState<string | null>(null)
  const [isMembersModalOpen, setIsMembersModalOpen] = useState(false)
  const [expenseEditForm, setExpenseEditForm] = useState({ title: '', amount: '', payerId: '', participantIds: [] as string[] })
  const [transferEditForm, setTransferEditForm] = useState({ amount: '', fromId: '', toId: '' })
  const lastRemoteJsonRef = useRef('')
  const suppressNextRemoteSaveRef = useRef(false)

  const currentPayload: SettlementPayload = useMemo(() => ({ members, expenses, transfers }), [members, expenses, transfers])
  const currentPayloadJson = useMemo(() => JSON.stringify(currentPayload), [currentPayload])

  useEffect(() => {
    window.localStorage.setItem(storageKey, currentPayloadJson)

    const url = getUrl()
    if (url.searchParams.get('fresh') === '1') {
      url.searchParams.delete('fresh')
      window.history.replaceState({}, '', url.toString())
    }
  }, [currentPayloadJson])

  useEffect(() => {
    getSettlementIdFromUrl()
    const settlementToken = getShareTokenFromUrl() || getSettlementTokenFromUrl()
    if (!settlementToken) return
    if (!canUseRemoteStore()) {
      setRemoteStatus('URL에 공유 정산 ID가 있지만 Supabase 환경변수가 없어요.')
      return
    }

    setRemoteStatus('공유 정산 연결 중...')

    let isCancelled = false

    const load = async () => {
      try {
        const record = await getSettlementByToken(settlementToken)
        if (isCancelled) return
        suppressNextRemoteSaveRef.current = true
        lastRemoteJsonRef.current = JSON.stringify(record.data)
        setSharedSettlementId(record.id)
        setSharedSettlementToken(record.share_token)
        setMembers(record.data.members)
        setExpenses(record.data.expenses)
        setTransfers(record.data.transfers)
        setRemoteStatus(`공유 정산 연결됨: ${record.id}`)
        setShareUrl(window.location.href)
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
      const nextJson = JSON.stringify(record.data)
      if (nextJson === lastRemoteJsonRef.current) {
        return
      }
      suppressNextRemoteSaveRef.current = true
      lastRemoteJsonRef.current = nextJson
      setMembers(record.data.members)
      setExpenses(record.data.expenses)
      setTransfers(record.data.transfers)
      setRemoteStatus(`다른 사람이 수정한 내용을 반영했어요: ${record.id}`)
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

  useEffect(() => {
    if (!sharedSettlementId || !sharedSettlementToken) return
    const url = getUrl()
    url.searchParams.delete('settlement')
    url.searchParams.delete('token')
    url.searchParams.set('share', sharedSettlementToken)
    setShareUrl(url.toString())
  }, [sharedSettlementId, sharedSettlementToken])

  const memberMap = useMemo(() => Object.fromEntries(members.map((member) => [member.id, member])), [members])

  const balances = useMemo<BalanceRow[]>(() => {
    const rows = new Map<string, BalanceRow>()
    members.forEach((member) => {
      rows.set(member.id, {
        memberId: member.id,
        paid: 0,
        share: 0,
        transferredOut: 0,
        transferredIn: 0,
        net: 0,
      })
    })

    expenses.forEach((expense) => {
      const payer = rows.get(expense.payerId)
      if (payer) payer.paid += expense.amount

      const participants = expense.participantIds.length > 0 ? expense.participantIds : [expense.payerId]
      const perHead = expense.amount / participants.length
      participants.forEach((participantId) => {
        const participant = rows.get(participantId)
        if (participant) participant.share += perHead
      })
    })

    transfers.forEach((transfer) => {
      rows.get(transfer.fromId)!.transferredOut += transfer.amount
      rows.get(transfer.toId)!.transferredIn += transfer.amount
    })

    return Array.from(rows.values()).map((row) => ({
      ...row,
      net: row.paid - row.share - row.transferredOut + row.transferredIn,
    }))
  }, [expenses, members, transfers])

  const settlements = useMemo<Settlement[]>(() => {
    const creditors = balances.filter((row) => row.net > 0.5).map((row) => ({ memberId: row.memberId, amount: row.net }))
    const debtors = balances.filter((row) => row.net < -0.5).map((row) => ({ memberId: row.memberId, amount: -row.net }))
    const result: Settlement[] = []
    let i = 0
    let j = 0

    while (i < debtors.length && j < creditors.length) {
      const debtor = debtors[i]
      const creditor = creditors[j]
      const amount = Math.min(debtor.amount, creditor.amount)
      result.push({ id: `${debtor.memberId}-${creditor.memberId}`, fromId: debtor.memberId, toId: creditor.memberId, amount })
      debtor.amount -= amount
      creditor.amount -= amount
      if (debtor.amount <= 0.5) i += 1
      if (creditor.amount <= 0.5) j += 1
    }

    return result
  }, [balances])

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
    const shouldDelete = window.confirm(`${withObjectParticle(memberName)} 삭제하면 관련 지출/송금 데이터도 함께 바뀔 수 있어요. 정말 삭제할까요?`)
    if (!shouldDelete) return

    if (sharedSettlementId && canUseRemoteStore()) {
      void deleteRemoteMember(memberId).catch(() => setRemoteStatus('참가자 삭제에 실패했어요.'))
    } else {
      setMembers((current) => current.filter((member) => member.id !== memberId))
      setExpenses((current) =>
        current
          .filter((expense) => expense.payerId !== memberId)
          .map((expense) => ({ ...expense, participantIds: expense.participantIds.filter((id) => id !== memberId) }))
          .filter((expense) => expense.participantIds.length > 0),
      )
      setTransfers((current) => current.filter((transfer) => transfer.fromId !== memberId && transfer.toId !== memberId))
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

  const addExpense = async () => {
    const amount = evaluateAmountInput(expenseForm.amount)
    if (!expenseForm.title.trim()) {
      setRemoteStatus('지출 항목명을 입력해 주세요.')
      return
    }
    if (!expenseForm.payerId) {
      setRemoteStatus('지출 결제자를 선택해 주세요.')
      return
    }
    if (amount === null || amount <= 0) {
      setRemoteStatus('지출 금액을 올바르게 입력해 주세요.')
      return
    }

    const expense = {
      id: sharedSettlementId ? createUuid() : createId(),
      title: expenseForm.title.trim(),
      amount,
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

  const exportData = () => {
    const payload: ImportPayload = { members, expenses, transfers }
    const text = JSON.stringify(payload, null, 2)
    const blob = new Blob([text], { type: 'application/json;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `travel-settlement-export-${new Date().toISOString().slice(0, 10)}.json`
    document.body.appendChild(anchor)
    anchor.click()
    document.body.removeChild(anchor)
    URL.revokeObjectURL(url)
    setExportMessage('현재 정산 데이터를 JSON 파일로 다운로드했어요.')
  }

  const copySettlementSummary = async () => {
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

  const resetCurrentSettlement = () => {
    const shouldReset = window.confirm('현재 정산 내용을 전부 비울까요? 이 작업은 되돌리기 어려워요.')
    if (!shouldReset) return

    setMembers([])
    setExpenses([])
    setTransfers([])
    setNewMemberName('')
    setExpenseForm({ title: '', amount: '', payerId: '', participantIds: [] })
    setTransferForm({ amount: '', fromId: '', toId: '' })
    setExportMessage('현재 정산을 비웠어요.')
  }

  const duplicateCurrentSettlement = () => {
    const url = getUrl()
    url.searchParams.delete('settlement')
    url.searchParams.set('fresh', '1')
    const nextWindow = window.open(url.toString(), '_blank', 'noopener,noreferrer')
    if (!nextWindow) {
      setExportMessage('새 창을 열지 못했어요. 팝업 차단을 확인해 주세요.')
      return
    }

    const clonedPayload = JSON.stringify(currentPayload)
    nextWindow.addEventListener('load', () => {
      try {
        nextWindow.localStorage.setItem(storageKey, clonedPayload)
      } catch {
        // noop
      }
    })
    setExportMessage('현재 정산을 새 창으로 복제했어요.')
  }

  const openNewSettlementWindow = () => {
    const url = getUrl()
    url.searchParams.delete('settlement')
    url.searchParams.set('fresh', '1')
    window.open(url.toString(), '_blank', 'noopener,noreferrer')
  }

  const shareSettlement = async () => {
    if (!canUseRemoteStore()) {
      setRemoteStatus('Supabase 환경변수가 없어서 공유 링크를 만들 수 없어요.')
      return
    }

    try {
      let settlementId = sharedSettlementId

      if (!settlementId) {
        const record = await createSettlement('공유 정산')
        settlementId = record.id
        setSharedSettlementToken(record.share_token)
        const { payload: normalizedPayload, memberIdMap } = normalizePayloadForRemote(currentPayload)
        setSharedSettlementId(settlementId)
        setMembers(normalizedPayload.members)
        setExpenses(normalizedPayload.expenses)
        setTransfers(normalizedPayload.transfers)
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
      url.searchParams.set('share', token)
      window.history.replaceState({}, '', url.toString())
      lastRemoteJsonRef.current = currentPayloadJson
      setShareUrl(url.toString())
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

  const importData = () => {
    try {
      const parsed = JSON.parse(importText) as ImportPayload
      if (!Array.isArray(parsed.members) || !Array.isArray(parsed.expenses) || !Array.isArray(parsed.transfers)) {
        throw new Error('invalid')
      }
      setMembers(parsed.members)
      setExpenses(parsed.expenses)
      setTransfers(parsed.transfers)
      setImportMessage('가져오기에 성공했어요. 이전 상태를 그대로 복구했습니다.')
      setIsImportModalOpen(false)
      setImportText('')
    } catch {
      setImportMessage('가져오기에 실패했어요. export한 JSON 전체를 그대로 붙여넣어 주세요.')
    }
  }

  const openExpenseEdit = (expense: Expense) => {
    setEditingExpenseId(expense.id)
    setExpenseEditForm({
      title: expense.title,
      amount: String(expense.amount),
      payerId: expense.payerId,
      participantIds: [...expense.participantIds],
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

  const saveExpenseEdit = () => {
    if (!editingExpenseId) return
    const amount = evaluateAmountInput(expenseEditForm.amount)
    if (!expenseEditForm.title.trim() || !expenseEditForm.payerId || amount === null || amount <= 0) return

    const nextExpense = {
      id: editingExpenseId,
      title: expenseEditForm.title.trim(),
      amount,
      payerId: expenseEditForm.payerId,
      participantIds: expenseEditForm.participantIds.length > 0 ? expenseEditForm.participantIds : [expenseEditForm.payerId],
    }

    if (sharedSettlementId && canUseRemoteStore()) {
      setExpenses((current) => current.map((expense) => expense.id !== editingExpenseId ? expense : nextExpense))
      void updateRemoteExpense(nextExpense).catch(() => setRemoteStatus('지출 수정에 실패했어요.'))
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

  const toggleExpenseEditParticipant = (memberId: string) => {
    setExpenseEditForm((current) => ({
      ...current,
      participantIds: current.participantIds.includes(memberId)
        ? current.participantIds.filter((id) => id !== memberId)
        : [...current.participantIds, memberId],
    }))
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
          <h1>누가 얼마를 내고, 받아야 하는지 한 번에 정리</h1>
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
                <span key={member.id} className="chip removable-chip">
                  {member.name}
                  <button type="button" onClick={() => removeMember(member.id)}>삭제</button>
                </span>
              ))
            )}
          </div>
        </section>

        <section className="panel two-column">
          <div className="form-section">
            <h2>지출 추가</h2>
            <div className="form-grid">
              <input value={expenseForm.title} onChange={(event) => setExpenseForm((current) => ({ ...current, title: event.target.value }))} placeholder="항목명" />
              <input value={expenseForm.amount} onChange={(event) => setExpenseForm((current) => ({ ...current, amount: event.target.value }))} placeholder="금액 (예: 12000+8000)" inputMode="text" />
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
              <h2>자동 정산 결과</h2>
            </div>
            <button onClick={copySettlementSummary}>정산 결과 복사</button>
          </div>
          <div className="settlement-list">
            {settlements.length === 0 ? (
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
            <textarea value={shareUrl} readOnly rows={4} />
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
              <input value={expenseEditForm.amount} onChange={(event) => setExpenseEditForm((current) => ({ ...current, amount: event.target.value }))} placeholder="금액 (예: 12000+8000)" inputMode="text" />
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
