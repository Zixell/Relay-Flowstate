import { useEffect, useState } from 'react'

export interface UpdateState {
  status: 'idle' | 'checking' | 'up-to-date' | 'available' | 'downloading' | 'ready' | 'error'
  current: string
  version?: string
  progress?: number
  error?: string
  notesUrl?: string
  /** 'install' replaces the app and restarts (Windows); 'open' opens the downloaded .dmg (macOS); 'page' only links the release. */
  mode: 'install' | 'open' | 'page'
}

/** Where the app update stands, kept current by the main process. */
export function useUpdates(): UpdateState | null {
  const [state, setState] = useState<UpdateState | null>(null)
  useEffect(() => {
    if (!window.api?.updates) return
    void window.api.updates.state().then(setState)
    return window.api.updates.onState(setState)
  }, [])
  return state
}
