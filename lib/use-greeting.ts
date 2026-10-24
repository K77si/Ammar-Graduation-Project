'use client'

import { useSyncExternalStore } from 'react'
import { timeGreeting } from '@/lib/display'

const subscribe = () => () => {}

export function useGreeting() {
  return useSyncExternalStore(subscribe, () => timeGreeting(), () => 'مرحباً')
}
