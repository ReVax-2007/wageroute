import {
  cloneElement,
  isValidElement,
  useEffect,
  useId,
  useRef,
  type ButtonHTMLAttributes,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactElement,
  type ReactNode
} from 'react'
import { X } from 'lucide-react'
import { formatMoney, formatMoneyCompact } from '@shared/money'
import { useFinanceStore } from '../store/useFinanceStore'

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

function visibleFocusables(panel: HTMLElement): HTMLElement[] {
  return [...panel.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (element) => element.getClientRects().length > 0
  )
}

/**
 * One focus model for every dialog: focus moves inside on open, Tab and
 * Shift-Tab stay inside, Escape closes, the page behind cannot scroll, and
 * focus returns to whatever opened it. The close callback is read through a ref
 * so an inline arrow function does not restart the effect on every render.
 */
export function useDialog(onClose: () => void, active = true) {
  const panelRef = useRef<HTMLDivElement>(null)
  const closeRef = useRef(onClose)
  const returnToRef = useRef<HTMLElement | null>(null)
  const wasActive = useRef(active)
  closeRef.current = onClose
  // Captured during render, before autoFocus moves into the panel. A dialog
  // that mounts once and opens later captures the trigger on the transition.
  if (active && !wasActive.current && typeof document !== 'undefined') {
    returnToRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null
  }
  wasActive.current = active
  if (returnToRef.current === null && typeof document !== 'undefined') {
    returnToRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null
  }

  useEffect(() => {
    if (!active) return
    const panel = panelRef.current
    const returnTo = returnToRef.current

    if (panel && !panel.contains(document.activeElement)) {
      const body = panel.querySelector<HTMLElement>('.modal-body, .allocator-body') ?? panel
      const field = body.querySelector<HTMLElement>(
        'input:not([type="hidden"]), select, textarea'
      )
      ;(field ?? panel).focus()
    }

    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        closeRef.current()
        return
      }
      if (event.key !== 'Tab' || !panel) return

      const items = visibleFocusables(panel)
      if (items.length === 0) {
        event.preventDefault()
        panel.focus()
        return
      }
      const first = items[0]
      const last = items[items.length - 1]
      const active = document.activeElement
      if (event.shiftKey) {
        if (active === first || active === panel) {
          event.preventDefault()
          last.focus()
        }
      } else if (active === last) {
        event.preventDefault()
        first.focus()
      }
    }

    document.addEventListener('keydown', handleKey)
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    document.documentElement.classList.add('dialog-open')
    return () => {
      document.removeEventListener('keydown', handleKey)
      document.body.style.overflow = previousOverflow
      document.documentElement.classList.remove('dialog-open')
      returnTo?.focus()
    }
  }, [active])

  return panelRef
}

/** Closes only when the press both started and ended on the backdrop itself. */
export function backdropHandlers(onClose: () => void) {
  let downOnBackdrop = false
  return {
    onMouseDown: (event: ReactMouseEvent<HTMLDivElement>) => {
      downOnBackdrop = event.target === event.currentTarget
    },
    onClick: (event: ReactMouseEvent<HTMLDivElement>) => {
      if (downOnBackdrop && event.target === event.currentTarget) onClose()
      downOnBackdrop = false
    }
  }
}


export function Card({
  title,
  subtitle,
  actions,
  children,
  className
}: {
  title?: string
  subtitle?: string
  actions?: ReactNode
  children: ReactNode
  className?: string
}) {
  return (
    <section className={className ? `card ${className}` : 'card'}>
      {(title || actions) && (
        <header className="card-head">
          <div>
            {title && <h2 className="card-title">{title}</h2>}
            {subtitle && <p className="card-sub">{subtitle}</p>}
          </div>
          {actions}
        </header>
      )}
      <div className="card-body">{children}</div>
    </section>
  )
}

export function Money({
  cents,
  currency = 'USD',
  compact = false,
  className
}: {
  cents: number
  currency?: string
  compact?: boolean
  className?: string
}) {
  return (
    <span className={className ? `num ${className}` : 'num'}>
      {compact ? formatMoneyCompact(cents, currency) : formatMoney(cents, currency)}
    </span>
  )
}

type ButtonVariant = 'primary' | 'ghost' | 'quiet' | 'danger'

export function Button({
  variant = 'ghost',
  size = 'md',
  icon,
  children,
  className,
  type = 'button',
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant
  size?: 'md' | 'sm'
  icon?: ReactNode
}) {
  return (
    <button
      {...rest}
      type={type}
      className={`btn btn-${variant} btn-${size}${className ? ` ${className}` : ''}`}
    >
      {icon}
      {children}
    </button>
  )
}

export function IconButton({
  label,
  danger = false,
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { label: string; danger?: boolean }) {
  return (
    <button
      {...rest}
      type="button"
      aria-label={label}
      title={label}
      className={danger ? 'icon-btn icon-btn-danger' : 'icon-btn'}
    >
      {children}
    </button>
  )
}

export function Field({
  label,
  hint,
  error,
  wide = false,
  children
}: {
  label: string
  hint?: string
  /** Field-level validation: linked to the control, not left at the bottom. */
  error?: string
  wide?: boolean
  children: ReactNode
}) {
  const generatedId = useId()
  const hintId = `${generatedId}-hint`
  const errorId = `${generatedId}-error`
  const describedBy =
    [hint ? hintId : null, error ? errorId : null].filter(Boolean).join(' ') || undefined

  const control =
    isValidElement(children) && error
      ? cloneElement(children as ReactElement<Record<string, unknown>>, {
          'aria-invalid': true,
          'aria-describedby': describedBy
        })
      : isValidElement(children) && describedBy
        ? cloneElement(children as ReactElement<Record<string, unknown>>, {
            'aria-describedby': describedBy
          })
        : children

  return (
    <label className={wide ? 'field span-2' : 'field'}>
      <span className="field-label">{label}</span>
      {control}
      {hint && (
        <span className="field-hint" id={hintId}>
          {hint}
        </span>
      )}
      {error && (
        <span className="field-error" id={errorId} role="alert">
          {error}
        </span>
      )}
    </label>
  )
}

/**
 * One styled question for every destructive or far-reaching action. Screens
 * call `askConfirm`, which resolves true only if the user explicitly agrees.
 */
export function ConfirmDialog() {
  const request = useFinanceStore((state) => state.confirmRequest)
  const resolveConfirm = useFinanceStore((state) => state.resolveConfirm)
  if (!request) return null

  return (
    <Modal
      title={request.title}
      onClose={() => resolveConfirm(false)}
      footer={
        <>
          <Button variant="quiet" onClick={() => resolveConfirm(false)}>
            Cancel
          </Button>
          <Button
            variant={request.danger ? 'danger' : 'primary'}
            onClick={() => resolveConfirm(true)}
          >
            {request.confirmLabel ?? 'Continue'}
          </Button>
        </>
      }
    >
      <p className="confirm-body">{request.body}</p>
    </Modal>
  )
}

export function Modal({
  title,
  subtitle,
  onClose,
  children,
  footer,
  wide = false
}: {
  title: string
  subtitle?: string
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
  wide?: boolean
}) {
  const panelRef = useDialog(onClose)
  const backdrop = backdropHandlers(onClose)
  const titleId = useId()
  const subtitleId = useId()

  return (
    <div className="modal-backdrop" {...backdrop}>
      <div
        ref={panelRef}
        className={wide ? 'modal modal-wide' : 'modal'}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={subtitle ? subtitleId : undefined}
        tabIndex={-1}
      >
        <header className="modal-head">
          <div>
            <h2 id={titleId}>{title}</h2>
            {subtitle && <p id={subtitleId}>{subtitle}</p>}
          </div>
          <IconButton label="Close" onClick={onClose}>
            <X size={17} />
          </IconButton>
        </header>
        <div className="modal-body">{children}</div>
        {footer && <footer className="modal-foot">{footer}</footer>}
      </div>
    </div>
  )
}

export function Progress({
  value,
  max,
  color,
  label
}: {
  value: number
  max: number
  color?: string
  label: string
}) {
  const percent = max > 0 ? Math.min(100, Math.max(0, (value / max) * 100)) : 0
  return (
    <div
      className="bar"
      role="progressbar"
      aria-label={label}
      aria-valuenow={Math.round(percent)}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <div
        className="bar-fill"
        style={{ width: `${percent}%`, ...(color ? { background: color } : {}) }}
      />
    </div>
  )
}

export function Switch({
  checked,
  onChange,
  label,
  disabled = false
}: {
  checked: boolean
  onChange: (next: boolean) => void
  label: string
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      className={checked ? 'switch on' : 'switch'}
      onClick={() => onChange(!checked)}
    >
      <span className="switch-knob" />
    </button>
  )
}

/**
 * A small set of exclusive choices. These are radio semantics rather than tabs:
 * there is no panel to show or hide, and a screen reader should announce which
 * option is chosen. Arrow keys move the selection the way a native radio group
 * does, and only the chosen option sits in the tab order.
 */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  label
}: {
  options: { value: T; label: string }[]
  value: T
  onChange: (value: T) => void
  label: string
}) {
  const buttons = useRef<(HTMLButtonElement | null)[]>([])

  const choose = (index: number) => {
    const option = options[index]
    if (!option) return
    onChange(option.value)
    buttons.current[index]?.focus()
  }

  const handleKey = (event: ReactKeyboardEvent<HTMLButtonElement>, index: number) => {
    const last = options.length - 1
    let next: number | null = null
    switch (event.key) {
      case 'ArrowRight':
      case 'ArrowDown':
        next = index === last ? 0 : index + 1
        break
      case 'ArrowLeft':
      case 'ArrowUp':
        next = index === 0 ? last : index - 1
        break
      case 'Home':
        next = 0
        break
      case 'End':
        next = last
        break
      default:
        return
    }
    event.preventDefault()
    choose(next)
  }

  return (
    <div className="segmented" role="radiogroup" aria-label={label}>
      {options.map((option, index) => {
        const selected = option.value === value
        return (
          <button
            key={option.value}
            ref={(element) => {
              buttons.current[index] = element
            }}
            type="button"
            role="radio"
            aria-checked={selected}
            tabIndex={selected ? 0 : -1}
            className={selected ? 'active' : undefined}
            onClick={() => onChange(option.value)}
            onKeyDown={(event) => handleKey(event, index)}
          >
            {option.label}
          </button>
        )
      })}
    </div>
  )
}

export function EmptyState({
  icon,
  title,
  body,
  action
}: {
  icon: ReactNode
  title: string
  body: string
  action?: ReactNode
}) {
  return (
    <div className="empty">
      <div className="empty-icon">{icon}</div>
      <h3>{title}</h3>
      <p>{body}</p>
      {action}
    </div>
  )
}

export function Toast() {
  const notice = useFinanceStore((state) => state.notice)
  const dismiss = useFinanceStore((state) => state.dismissNotice)
  const pause = useFinanceStore((state) => state.pauseNotice)
  const resume = useFinanceStore((state) => state.resumeNotice)
  if (!notice) return null

  const isError = notice.tone === 'error'
  return (
    <div
      className={isError ? 'toast toast-error' : 'toast'}
      role={isError ? 'alert' : 'status'}
      onMouseEnter={pause}
      onMouseLeave={resume}
      onFocus={pause}
      onBlur={resume}
    >
      <span className="toast-text">{notice.text}</span>
      <button
        type="button"
        className="toast-close"
        aria-label="Dismiss notification"
        onClick={dismiss}
      >
        <X size={14} />
      </button>
    </div>
  )
}
