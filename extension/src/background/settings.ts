import type { Settings } from '../shared/types'
import { DEFAULT_SETTINGS, STORAGE_KEYS } from '../shared/constants'

export async function getSettings(): Promise<Settings> {
  const data = await chrome.storage.local.get(STORAGE_KEYS.settings)
  const stored = (data[STORAGE_KEYS.settings] as Partial<Settings> | undefined) ?? {}
  return { ...DEFAULT_SETTINGS, ...stored }
}

export async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  const current = await getSettings()
  const next = { ...current, ...patch }
  await chrome.storage.local.set({ [STORAGE_KEYS.settings]: next })
  return next
}
