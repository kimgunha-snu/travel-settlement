export type ReferenceExchangeRate = {
  base: string
  quote: 'KRW'
  rate: number
  date: string
}

const referenceRateApiBaseUrl = 'https://api.frankfurter.dev/v2/rate'

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value)

export const fetchReferenceExchangeRate = async (
  currency: string,
  signal?: AbortSignal,
): Promise<ReferenceExchangeRate> => {
  const base = currency.trim().toUpperCase()
  if (!/^[A-Z]{3}$/.test(base) || base === 'KRW') throw new Error('지원하지 않는 기준 통화입니다.')

  const response = await fetch(`${referenceRateApiBaseUrl}/${encodeURIComponent(base)}/KRW`, { signal })
  if (!response.ok) throw new Error('기준 환율을 불러오지 못했습니다.')

  const data: unknown = await response.json()
  if (!isRecord(data)
    || data.base !== base
    || data.quote !== 'KRW'
    || typeof data.rate !== 'number'
    || !Number.isFinite(data.rate)
    || data.rate <= 0
    || typeof data.date !== 'string'
    || !/^\d{4}-\d{2}-\d{2}$/.test(data.date)) {
    throw new Error('기준 환율 응답이 올바르지 않습니다.')
  }

  return { base, quote: 'KRW', rate: data.rate, date: data.date }
}
