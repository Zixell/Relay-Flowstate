import { setDbSetting, getAllSettings } from './db'

const cache = new Map<string, string>()

export function loadSettings(): void {
  try {
    const all = getAllSettings()
    for (const [k, v] of Object.entries(all)) {
      cache.set(k, v)
    }
  } catch {
    // DB may not be ready yet
  }
}

export function getSetting(key: string): string {
  return cache.get(key) ?? process.env[key] ?? ''
}

export function setSetting(key: string, value: string): void {
  cache.set(key, value)
  setDbSetting(key, value)
}

export function getSettingForClient(key: string): string {
  // Returns masked value for sensitive keys so the renderer can show "set" state
  const val = getSetting(key)
  if (!val) return ''
  const lk = key.toLowerCase()
  // File paths are not sensitive — don't mask them
  if ((lk.includes('key') || lk.includes('secret')) && !lk.includes('path')) {
    return val.slice(0, 8) + '•'.repeat(Math.min(val.length - 8, 24))
  }
  return val
}
