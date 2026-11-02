import { useEffect, useId, type ReactNode } from 'react'
import { X } from 'lucide-react'

interface SheetProps {
  title: string
  hint?: string
  onClose: () => void
  children: ReactNode
}

/** A bottom sheet, because a phone is taller than it is wide. */
export function Sheet({ title, hint, onClose, children }: SheetProps) {
  const titleId = useId()

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = previous
    }
  }, [onClose])

  return (
    <div className="sheet-backdrop" onPointerDown={onClose}>
      <section
        className="sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onPointerDown={(event) => event.stopPropagation()}
      >
        <div className="sheet-grip" aria-hidden="true" />
        <header className="sheet-head">
          <div>
            <h2 id={titleId}>{title}</h2>
            {hint ? <p className="muted small">{hint}</p> : null}
          </div>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Close">
            <X size={20} />
          </button>
        </header>
        <div className="sheet-body">{children}</div>
      </section>
    </div>
  )
}
