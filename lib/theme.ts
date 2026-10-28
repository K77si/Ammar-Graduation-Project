'use client'

import { useEffect, useState } from 'react'

export const THEME_KEY = 'sanad-theme'

export function applyTheme(dark: boolean) {
  document.documentElement.classList.toggle('dark', dark)
}

export function useTheme() {
  const [dark, setDark] = useState(false)

  useEffect(() => {
    const saved = localStorage.getItem(THEME_KEY) === 'dark'
    setDark(saved)
    applyTheme(saved)
  }, [])

  const toggle = () => {
    setDark((current) => {
      const next = !current
      localStorage.setItem(THEME_KEY, next ? 'dark' : 'light')
      applyTheme(next)
      return next
    })
  }

  return { dark, toggle }
}
