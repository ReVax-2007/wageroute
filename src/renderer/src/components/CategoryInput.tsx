import { categoryKey } from '@shared/categories'
import { useFinanceStore } from '../store/useFinanceStore'

/**
 * A category box that suggests the ledger's categories and accepts a new name.
 * A typed name that matches an existing category posts that category's id, so
 * every form files an entry under the same row the ledger already has.
 */
export function CategoryInput({
  listId,
  value,
  onChange,
  placeholder
}: {
  listId: string
  value: string
  onChange: (name: string, categoryId: string | null) => void
  placeholder?: string
}) {
  const categories = useFinanceStore((state) => state.snapshot?.categories) ?? []
  const change = (name: string) => {
    const match = categories.find((category) => categoryKey(category.name) === categoryKey(name))
    onChange(name, match?.id ?? null)
  }
  return (
    <>
      <input
        className="input"
        list={listId}
        value={value}
        placeholder={placeholder}
        onChange={(event) => change(event.target.value)}
      />
      <datalist id={listId}>
        {categories.map((category) => (
          <option key={category.id} value={category.name} />
        ))}
      </datalist>
    </>
  )
}
