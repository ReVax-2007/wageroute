import { randomUUID } from 'node:crypto'
import {
  CATEGORY_NAME_MAX,
  categoryKey,
  defaultCategoryKind,
  normalizeCategoryName
} from '@shared/categories'
import { RepositoryError } from '@shared/errors'
import type { Category, CategoryInput, CategoryKind, TransactionKind } from '@shared/types'
import { CATEGORY_KINDS } from '@shared/writeRules'
import { assertOneOf, assertText, nowISO, optionalText, softDelete, updateRow, type Db } from './common'

const CATEGORY_SELECT = `
  SELECT id, user_id AS userId, name, kind, color, sort_order AS sortOrder,
         created_at AS createdAt, updated_at AS updatedAt,
         deleted_at AS deletedAt, revision
  FROM categories
  WHERE user_id = ? AND deleted_at IS NULL`

export function listCategories(db: Db, userId: string): Category[] {
  return db
    .prepare(`${CATEGORY_SELECT} ORDER BY sort_order, name`)
    .all(userId) as Category[]
}

/**
 * SQLite's `lower()` only folds ASCII, while reports group by the locale-aware
 * `categoryKey`. Comparing in JS keeps the lookup and the report on one key:
 * otherwise "CAFÉ" and "Café" become two rows and split one category's total.
 */
function findByName(db: Db, userId: string, name: string): Category | undefined {
  const key = categoryKey(name)
  return listCategories(db, userId).find((row) => categoryKey(row.name) === key)
}

function nextSortOrder(db: Db, userId: string): number {
  const row = db
    .prepare('SELECT COALESCE(MAX(sort_order), -1) AS value FROM categories WHERE user_id = ?')
    .get(userId) as { value: number }
  return row.value + 1
}

function insertCategory(
  db: Db,
  userId: string,
  name: string,
  kind: CategoryKind,
  color: string | null,
  sortOrder: number
): string {
  const id = randomUUID()
  const ts = nowISO()
  db.prepare(
    `INSERT INTO categories
       (id, user_id, name, kind, color, sort_order, created_at, updated_at, deleted_at, revision)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 1)`
  ).run(id, userId, name, kind, color, sortOrder, ts, ts)
  return id
}

/** Creates a category, or returns the existing row with the same name. */
export function createCategory(db: Db, userId: string, input: CategoryInput): string {
  const name = normalizeCategoryName(assertText(input.name, 'Category name', CATEGORY_NAME_MAX))
  const existing = findByName(db, userId, name)
  if (existing) return existing.id
  return insertCategory(
    db,
    userId,
    name,
    assertOneOf(input.kind, CATEGORY_KINDS, 'category kind'),
    optionalText(input.color, 'Color', 30),
    nextSortOrder(db, userId)
  )
}

export function updateCategory(
  db: Db,
  userId: string,
  id: string,
  patch: Partial<CategoryInput>
): void {
  const current = db
    .prepare(`${CATEGORY_SELECT} AND id = ?`)
    .get(userId, id) as Category | undefined
  if (!current) throw new RepositoryError('NOT_FOUND', 'Category not found')

  let nextName: string | undefined
  if (patch.name !== undefined) {
    nextName = normalizeCategoryName(assertText(patch.name, 'Category name', CATEGORY_NAME_MAX))
    const clash = findByName(db, userId, nextName)
    if (clash && clash.id !== id) {
      throw new RepositoryError('CONFLICT', 'A category with that name already exists')
    }
  }

  db.transaction(() => {
    updateRow(db, 'categories', id, userId, {
      name: nextName,
      kind:
        patch.kind === undefined
          ? undefined
          : assertOneOf(patch.kind, CATEGORY_KINDS, 'category kind'),
      color:
        patch.color === undefined
          ? undefined
          : patch.color
            ? assertText(patch.color, 'Color', 30)
            : null
    })
    // The text column is what search and CSV export read, so a rename has to
    // reach the rows that still carry the old spelling.
    if (nextName !== undefined && nextName !== current.name) {
      const ts = nowISO()
      db.prepare(
        `UPDATE transactions
         SET category = ?, updated_at = ?, revision = revision + 1
         WHERE user_id = ? AND category_id = ? AND deleted_at IS NULL`
      ).run(nextName, ts, userId, id)
      // A bill carries only the text, and autopay posts it through
      // ensureCategory — leaving the old spelling there would mint the old
      // category again the first time the bill ran.
      const oldKey = categoryKey(current.name)
      const updateBill = db.prepare(
        `UPDATE bills SET category = ?, updated_at = ?, revision = revision + 1
         WHERE id = ? AND user_id = ?`
      )
      const bills = db
        .prepare(
          `SELECT id, category FROM bills
           WHERE user_id = ? AND deleted_at IS NULL`
        )
        .all(userId) as { id: string; category: string }[]
      for (const bill of bills) {
        if (categoryKey(bill.category) === oldKey) updateBill.run(nextName, ts, bill.id, userId)
      }
    }
  })()
}

/**
 * Removing a category keeps the ledger: rows lose the pointer and keep their
 * last text, so no entry disappears from a report because its label did.
 */
export function deleteCategory(db: Db, userId: string, id: string): void {
  const exists = db
    .prepare('SELECT 1 AS present FROM categories WHERE id = ? AND user_id = ? AND deleted_at IS NULL')
    .get(id, userId)
  if (!exists) throw new RepositoryError('NOT_FOUND', 'Category not found')
  db.transaction(() => {
    const ts = nowISO()
    db.prepare(
      `UPDATE transactions
       SET category_id = NULL, updated_at = ?, revision = revision + 1
       WHERE user_id = ? AND category_id = ? AND deleted_at IS NULL`
    ).run(ts, userId, id)
    softDelete(db, 'categories', id, userId)
  })()
}

/**
 * Resolves a written name to a category row, creating it the first time. Null
 * means "no category": an empty name stays empty rather than becoming a row
 * called nothing.
 */
export function ensureCategory(
  db: Db,
  userId: string,
  name: string,
  kind: TransactionKind
): string | null {
  const cleaned = normalizeCategoryName(name).slice(0, CATEGORY_NAME_MAX)
  if (!cleaned) return null
  const existing = findByName(db, userId, cleaned)
  if (existing) return existing.id
  return insertCategory(
    db,
    userId,
    cleaned,
    defaultCategoryKind(kind),
    null,
    nextSortOrder(db, userId)
  )
}

/** A map of category name keys to ids, for imports that only carry text. */
export function categoryIdsByKey(db: Db, userId: string): Map<string, string> {
  const rows = db.prepare(`${CATEGORY_SELECT}`).all(userId) as Category[]
  return new Map(rows.map((row) => [categoryKey(row.name), row.id]))
}
