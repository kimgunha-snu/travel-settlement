import { useEffect, useMemo, useState } from 'react'
import './App.css'

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
  fromId: string
  toId: string
  amount: number
}

type ImportPayload = {
  members: Member[]
  expenses: Expense[]
  transfers: Transfer[]
}

const currency = new Intl.NumberFormat('ko-KR', {
  style: 'currency',
  currency: 'KRW',
  maximumFractionDigits: 0,
})

const storageKey = 'travel-settlement-app-data'
const createId = () => Math.random().toString(36).slice(2, 10)

const hasBatchim = (name: string) => {
  const last = name.trim().at(-1)
  if (!last) return false
  const code = last.charCodeAt(0)
  if (code < 0xac00 || code > 0xd7a3) return false
  return (code - 0xac00) % 28 !== 0
}

const withSubjectParticle = (name: string) => `${name}${hasBatchim(name) ? '이' : '가'}`

function App() {
  const [members, setMembers] = useState<Member[]>([])
  const [expenses, setExpenses] = useState<Expense[]>([])
  const [transfers, setTransfers] = useState<Transfer[]>([])
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

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(storageKey)
      if (!raw) return
      const parsed = JSON.parse(raw) as ImportPayload
      setMembers(parsed.members ?? [])
      setExpenses(parsed.expenses ?? [])
      setTransfers(parsed.transfers ?? [])
    } catch {
      // ignore broken local data
    }
  }, [])

  useEffect(() => {
    window.localStorage.setItem(storageKey, JSON.stringify({ members, expenses, transfers }))
  }, [members, expenses, transfers])

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
      result.push({ fromId: debtor.memberId, toId: creditor.memberId, amount })
      debtor.amount -= amount
      creditor.amount -= amount
      if (debtor.amount <= 0.5) i += 1
      if (creditor.amount <= 0.5) j += 1
    }

    return result
  }, [balances])

  const allMembersSelected = members.length > 0 && expenseForm.participantIds.length === members.length

  const addMember = () => {
    const name = newMemberName.trim()
    if (!name) return

    const member = { id: createId(), name }
    setMembers((current) => [...current, member])
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

  const removeMember = (memberId: string) => {
    setMembers((current) => current.filter((member) => member.id !== memberId))
    setExpenses((current) =>
      current
        .filter((expense) => expense.payerId !== memberId)
        .map((expense) => ({ ...expense, participantIds: expense.participantIds.filter((id) => id !== memberId) }))
        .filter((expense) => expense.participantIds.length > 0),
    )
    setTransfers((current) => current.filter((transfer) => transfer.fromId !== memberId && transfer.toId !== memberId))
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

  const addExpense = () => {
    const amount = Number(expenseForm.amount)
    if (!expenseForm.title.trim() || !expenseForm.payerId || !Number.isFinite(amount) || amount <= 0) return

    setExpenses((current) => [
      ...current,
      {
        id: createId(),
        title: expenseForm.title.trim(),
        amount,
        payerId: expenseForm.payerId,
        participantIds: expenseForm.participantIds.length > 0 ? expenseForm.participantIds : [expenseForm.payerId],
      },
    ])

    setExpenseForm((current) => ({ ...current, title: '', amount: '' }))
  }

  const addTransfer = () => {
    const amount = Number(transferForm.amount)
    if (!transferForm.fromId || !transferForm.toId || transferForm.fromId === transferForm.toId) return
    if (!Number.isFinite(amount) || amount <= 0) return

    setTransfers((current) => [
      ...current,
      { id: createId(), amount, fromId: transferForm.fromId, toId: transferForm.toId },
    ])

    setTransferForm((current) => ({ ...current, amount: '' }))
  }

  const exportData = async () => {
    const payload: ImportPayload = { members, expenses, transfers }
    const text = JSON.stringify(payload, null, 2)
    await navigator.clipboard.writeText(text)
    setExportMessage('현재 정산 데이터를 JSON으로 클립보드에 복사했어요.')
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

  const removeExpense = (id: string) => setExpenses((current) => current.filter((expense) => expense.id !== id))
  const removeTransfer = (id: string) => setTransfers((current) => current.filter((transfer) => transfer.id !== id))

  return (
    <div className="app-shell">
      <header className="hero">
        <div>
          <p className="eyebrow">여행 정산 앱</p>
          <h1>누가 얼마를 내고, 받아야 하는지 한 번에 정리</h1>
          <p className="subtitle">여행 중 사용한 돈, 송금 내역, 같이 쓴 사람만 넣으면 자동으로 정산 결과를 계산해줘요.</p>
        </div>
        <div className="hero-actions">
          <button onClick={() => setIsImportModalOpen(true)}>Import</button>
          <button onClick={exportData}>Export</button>
        </div>
        {exportMessage && <p className="helper export-message">{exportMessage}</p>}
      </header>

      <main className="layout">
        <section className="panel">
          <h2>참가자</h2>
          <div className="inline-form">
            <input
              value={newMemberName}
              onChange={(event) => setNewMemberName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== 'Enter') return
                event.preventDefault()
                addMember()
              }}
              placeholder="이름 추가"
            />
            <button onClick={addMember}>추가</button>
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
              <input value={expenseForm.amount} onChange={(event) => setExpenseForm((current) => ({ ...current, amount: event.target.value }))} placeholder="금액" inputMode="numeric" />
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
              <input value={transferForm.amount} onChange={(event) => setTransferForm((current) => ({ ...current, amount: event.target.value }))} placeholder="송금 금액" inputMode="numeric" />
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
          <h2>자동 정산 결과</h2>
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
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>이름</th>
                    <th>결제</th>
                    <th>분담</th>
                    <th>송금 반영 후</th>
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
          </div>

          <div>
            <h2>입력된 내역</h2>
            <h3>지출</h3>
            <div className="history-list">
              {expenses.length === 0 ? (
                <div className="empty">아직 입력된 지출이 없어요.</div>
              ) : (
                expenses.map((expense) => (
                  <div key={expense.id} className="history-item">
                    <div>
                      <strong>{expense.title}</strong>
                      <p>{withSubjectParticle(memberMap[expense.payerId]?.name ?? '')} 결제, {expense.participantIds.map((id) => memberMap[id]?.name).join(', ')} 사용</p>
                    </div>
                    <div className="history-side">
                      <span>{currency.format(expense.amount)}</span>
                      <button onClick={() => removeExpense(expense.id)}>삭제</button>
                    </div>
                  </div>
                ))
              )}
            </div>

            <h3>송금</h3>
            <div className="history-list">
              {transfers.length === 0 ? (
                <div className="empty">아직 기록된 송금이 없어요.</div>
              ) : (
                transfers.map((transfer) => (
                  <div key={transfer.id} className="history-item">
                    <div>
                      <strong>{memberMap[transfer.fromId]?.name} → {memberMap[transfer.toId]?.name}</strong>
                    </div>
                    <div className="history-side">
                      <span>{currency.format(transfer.amount)}</span>
                      <button onClick={() => removeTransfer(transfer.id)}>삭제</button>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </section>
      </main>

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
