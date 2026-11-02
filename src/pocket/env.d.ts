/// <reference types="vite/client" />

declare const __POCKET_VERSION__: string

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>
}

interface Navigator {
  /** Safari on iOS still answers this, and never fires beforeinstallprompt. */
  standalone?: boolean
}
