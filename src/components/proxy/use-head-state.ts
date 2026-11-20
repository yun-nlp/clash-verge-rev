import { useCallback, useEffect, useReducer } from 'react'

import { useProfiles } from '@/hooks/use-profiles'

import { ProxySortType } from './use-filter-sort'

export interface HeadState {
  open?: boolean
  showType: boolean
  sortType: ProxySortType
  filterText: string
  filterMatchCase?: boolean
  filterMatchWholeWord?: boolean
  filterUseRegularExpression?: boolean
  textState: 'url' | 'filter' | null
  testUrl: string
}

type HeadStateStorage = Record<string, Record<string, HeadState>>

const HEAD_STATE_KEY = 'proxy-head-state'
export const DEFAULT_STATE: HeadState = {
  open: false,
  showType: true,
  sortType: 0,
  filterText: '',
  filterMatchCase: false,
  filterMatchWholeWord: false,
  filterUseRegularExpression: false,
  textState: null,
  testUrl: '',
}

type HeadStateAction =
  | { type: 'reset' }
  | { type: 'replace'; payload: Record<string, HeadState> }
  | { type: 'update'; groupName: string; patch: Partial<HeadState> }

function headStateReducer(
  state: Record<string, HeadState>,
  action: HeadStateAction,
): Record<string, HeadState> {
  switch (action.type) {
    case 'reset':
      return {}
    case 'replace':
      return action.payload
    case 'update': {
      const prev = state[action.groupName] || DEFAULT_STATE
      return { ...state, [action.groupName]: { ...prev, ...action.patch } }
    }
    default:
      return state
  }
}

export function useHeadStateNew() {
  const { profiles } = useProfiles()
  const current = profiles?.current || ''
  const storedUrls = JSON.stringify(
    profiles?.items?.find((item) => item.uid === current)?.group_test_urls ?? {},
  )

  const [state, dispatch] = useReducer(headStateReducer, {})

  useEffect(() => {
    try {
      const data = JSON.parse(
        localStorage.getItem(HEAD_STATE_KEY) || '{}',
      ) as HeadStateStorage

      const value = data[current] || {}
      const overrides = JSON.parse(storedUrls) as Record<string, string>
      for (const [name, testUrl] of Object.entries(overrides)) {
        value[name] = { ...DEFAULT_STATE, ...value[name], testUrl }
      }

      if (value && typeof value === 'object') {
        dispatch({ type: 'replace', payload: value })
      } else {
        dispatch({ type: 'reset' })
      }
    } catch {
      dispatch({ type: 'reset' })
    }
  }, [current, storedUrls])

  useEffect(() => {
    const timer = setTimeout(() => {
      try {
        const item = localStorage.getItem(HEAD_STATE_KEY)

        let data = (item ? JSON.parse(item) : {}) as HeadStateStorage

        if (!data || typeof data !== 'object') data = {}

        data[current] = state

        localStorage.setItem(HEAD_STATE_KEY, JSON.stringify(data))
      } catch {}
    })

    return () => clearTimeout(timer)
  }, [state, current])

  const setHeadState = useCallback(
    (groupName: string, obj: Partial<HeadState>) => {
      dispatch({ type: 'update', groupName, patch: obj })
    },
    [],
  )

  return [state, setHeadState] as const
}
