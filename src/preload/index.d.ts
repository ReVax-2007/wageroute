import type { FinanceApi } from '@shared/api'

declare global {
  interface Window {
    api: FinanceApi
  }
}

export {}
