import { describe, expect, it } from 'vitest'
import {
  calculateBalances,
  calculateSettlements,
  getMemberReferences,
  parseSettlementPayload,
  sanitizeSettlementPayload,
  type SettlementPayload,
} from './settlement'

const members = [
  { id: 'a', name: 'A' },
  { id: 'b', name: 'B' },
  { id: 'c', name: 'C' },
]

const payload = (overrides: Partial<SettlementPayload> = {}): SettlementPayload => ({
  members,
  expenses: [],
  transfers: [],
  duesCollections: [],
  ...overrides,
})

describe('calculateBalances', () => {
  it('distributes indivisible won amounts deterministically', () => {
    const balances = calculateBalances(payload({
      expenses: [{ id: 'e1', title: 'expense', amount: 100, payerId: 'a', participantIds: ['a', 'b', 'c'] }],
    }))

    expect(balances.map((row) => row.share)).toEqual([34, 33, 33])
    expect(balances.map((row) => row.net)).toEqual([66, -33, -33])
    expect(balances.reduce((sum, row) => sum + row.net, 0)).toBe(0)
    expect(calculateSettlements(balances).settlements).toEqual([
      { id: 'b-a', fromId: 'b', toId: 'a', amount: 33 },
      { id: 'c-a', fromId: 'c', toId: 'a', amount: 33 },
    ])
  })

  it('keeps the balance invariant for every small remainder', () => {
    for (let amount = 1; amount <= 100; amount += 1) {
      const balances = calculateBalances(payload({
        expenses: [{ id: `e-${amount}`, title: 'expense', amount, payerId: 'a', participantIds: ['a', 'b', 'c'] }],
      }))
      expect(balances.reduce((sum, row) => sum + row.net, 0)).toBe(0)
      expect(balances.every((row) => Number.isInteger(row.share) && Number.isInteger(row.net))).toBe(true)
    }
  })

  it('subtracts transfers that were already sent', () => {
    const balances = calculateBalances(payload({
      members: members.slice(0, 2),
      expenses: [{ id: 'e1', title: 'expense', amount: 100, payerId: 'a', participantIds: ['a', 'b'] }],
      transfers: [{ id: 't1', amount: 20, fromId: 'b', toId: 'a' }],
    }))

    expect(balances.map((row) => row.net)).toEqual([30, -30])
    expect(calculateSettlements(balances).settlements).toEqual([
      { id: 'b-a', fromId: 'b', toId: 'a', amount: 30 },
    ])
  })
})

describe('calculateSettlements', () => {
  it('refuses to emit a partial result for an imbalanced ledger', () => {
    const result = calculateSettlements([
      { memberId: 'a', paid: 0, share: 0, transferredOut: 0, transferredIn: 0, net: 10 },
      { memberId: 'b', paid: 0, share: 0, transferredOut: 0, transferredIn: 0, net: -7 },
    ])

    expect(result).toEqual({ settlements: [], imbalance: 3 })
  })
})

describe('payload validation and sanitation', () => {
  it('removes dangling and duplicate participant IDs before calculation', () => {
    const cleaned = sanitizeSettlementPayload(payload({
      members: members.slice(0, 2),
      expenses: [{ id: 'e1', title: 'expense', amount: 100, payerId: 'a', participantIds: ['a', 'b', 'ghost', 'b'] }],
    }))

    expect(cleaned.changed).toBe(true)
    expect(cleaned.payload.expenses[0].participantIds).toEqual(['a', 'b'])
    expect(calculateBalances(cleaned.payload).map((row) => row.net)).toEqual([50, -50])
  })

  it('rejects fractional and non-numeric imported money', () => {
    const valid = payload({
      expenses: [{ id: 'e1', title: 'expense', amount: 100, payerId: 'a', participantIds: ['a'] }],
    })
    expect(() => parseSettlementPayload({ ...valid, expenses: [{ ...valid.expenses[0], amount: 10.5 }] })).toThrow()
    expect(() => parseSettlementPayload({ ...valid, expenses: [{ ...valid.expenses[0], amount: '100' }] })).toThrow()
  })
})

describe('getMemberReferences', () => {
  it('counts every record that must be resolved before member deletion', () => {
    const references = getMemberReferences(payload({
      expenses: [{ id: 'e1', title: 'expense', amount: 100, payerId: 'a', participantIds: ['a', 'b'] }],
      transfers: [{ id: 't1', amount: 10, fromId: 'b', toId: 'a' }],
      duesCollections: [{ id: 'd1', title: 'dues', amount: 20, receiverId: 'a', paidMemberIds: ['b'] }],
    }), 'b')

    expect(references).toEqual({
      paidExpenses: 0,
      participatedExpenses: 1,
      transfers: 1,
      receivedDuesCollections: 0,
      paidDuesCollections: 1,
      total: 3,
    })
  })
})
