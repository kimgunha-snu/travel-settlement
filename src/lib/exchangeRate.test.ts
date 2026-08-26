import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchReferenceExchangeRate } from './exchangeRate'

describe('fetchReferenceExchangeRate', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('loads and validates the latest won reference rate', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ date: '2026-08-26', base: 'JPY', quote: 'KRW', rate: 8.6879 }),
    })
    vi.stubGlobal('fetch', fetchMock)

    await expect(fetchReferenceExchangeRate('jpy')).resolves.toEqual({
      date: '2026-08-26',
      base: 'JPY',
      quote: 'KRW',
      rate: 8.6879,
    })
    expect(fetchMock).toHaveBeenCalledWith('https://api.frankfurter.dev/v2/rate/JPY/KRW', { signal: undefined })

  })

  it('rejects malformed rate responses', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ date: 'today', base: 'JPY', quote: 'KRW', rate: 0 }),
    }))

    await expect(fetchReferenceExchangeRate('JPY')).rejects.toThrow('기준 환율 응답이 올바르지 않습니다.')
  })
})
