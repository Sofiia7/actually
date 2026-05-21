import type {
  HistoryItem,
  MatchResult,
  Settings,
  TestKeysResult,
} from './types'

export type RequestMessage =
  | { type: 'EXTRACT_AND_MATCH' }
  | { type: 'GET_SETTINGS' }
  | { type: 'SAVE_SETTINGS'; settings: Partial<Settings> }
  | { type: 'TEST_KEYS' }
  | { type: 'GET_HISTORY' }
  | { type: 'CLEAR_HISTORY' }
  | { type: 'GET_CACHE_STATUS' }
  | { type: 'REFRESH_CACHE_NOW' }
  | {
      type: 'PLACE_ORDER'
      marketId: string
      tokenId: string
      side: 'BUY_YES' | 'BUY_NO'
      sizeUsd: number
      price: number
      negRisk: boolean
    }

export type ResponseMessage =
  | { type: 'MATCH_RESULT'; result: MatchResult | null; reason?: string }
  | { type: 'SETTINGS_RESPONSE'; settings: Settings }
  | { type: 'OK' }
  | { type: 'TEST_KEYS_RESULT'; result: TestKeysResult }
  | { type: 'HISTORY_RESPONSE'; items: HistoryItem[] }
  | { type: 'CACHE_STATUS'; count: number; lastUpdated: number; refreshing: boolean }
  | { type: 'REFRESH_STARTED' }
  | { type: 'REFRESH_RESULT'; ok: boolean; added: number; reused: number; error?: string }
  | { type: 'ORDER_RESULT'; ok: boolean; orderId?: string; error?: string }
  | { type: 'ERROR'; error: string }

export async function sendToBackground<R = ResponseMessage>(
  msg: RequestMessage,
): Promise<R> {
  return (await chrome.runtime.sendMessage(msg)) as R
}
