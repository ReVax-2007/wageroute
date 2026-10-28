import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import { reservePerPaycheckCents } from '@shared/cadence'
import { addDaysISO, todayISO } from '@shared/dates'
import { DEFAULT_SETTINGS, settingsToRecord } from '@shared/settings'
import type { Frequency } from '@shared/types'
import {
  createAccount,
  createBill,
  createGoal,
  createTransaction,
  insertPaycheckRecord,
  writeSettings
} from './repositories'

type Db = Database.Database

interface BillSpec {
  name: string
  amountCents: number
  frequency: Frequency
  dueDay: number
  category: string
  autopay: boolean
}

const DEMO_BILLS: BillSpec[] = [
  { name: 'Rent', amountCents: 185000, frequency: 'monthly', dueDay: 1, category: 'Housing', autopay: true },
  { name: 'Car insurance', amountCents: 14800, frequency: 'monthly', dueDay: 5, category: 'Insurance', autopay: true },
  { name: 'Electric', amountCents: 9500, frequency: 'monthly', dueDay: 12, category: 'Utilities', autopay: false },
  { name: 'Phone', amountCents: 6500, frequency: 'monthly', dueDay: 18, category: 'Utilities', autopay: true },
  { name: 'Internet', amountCents: 6000, frequency: 'monthly', dueDay: 20, category: 'Utilities', autopay: true },
  { name: 'Spotify', amountCents: 1199, frequency: 'monthly', dueDay: 22, category: 'Subscriptions', autopay: true }
]

// Packaged builds start blank: one local user plus default settings, no demo
// data. The demo profile below exists only for development, so a disposable
// profile never needs manual setup just to see the app populated.
export function seedIfEmpty(db: Db): string {
  const existing = db
    .prepare('SELECT id FROM users ORDER BY created_at LIMIT 1')
    .get() as { id: string } | undefined
  if (existing) return existing.id

  const userId = randomUUID()
  const ts = new Date().toISOString()
  db.prepare(
    `INSERT INTO users
       (id, email, display_name, currency, created_at, updated_at, deleted_at, revision)
     VALUES (?, NULL, ?, 'USD', ?, ?, NULL, 1)`
  ).run(userId, '', ts, ts)
  writeSettings(db, userId, settingsToRecord(DEFAULT_SETTINGS))
  return userId
}

export function seedDemoIfEmpty(db: Db): string {
  const existing = db
    .prepare('SELECT id FROM users ORDER BY created_at LIMIT 1')
    .get() as { id: string } | undefined
  if (existing) return existing.id

  const seed = db.transaction(() => {
    const userId = randomUUID()
    const ts = new Date().toISOString()

    db.prepare(
      `INSERT INTO users
         (id, email, display_name, currency, created_at, updated_at, deleted_at, revision)
       VALUES (?, NULL, ?, 'USD', ?, ?, NULL, 1)`
    ).run(userId, 'Alex', ts, ts)

    writeSettings(
      db,
      userId,
      settingsToRecord({
        ...DEFAULT_SETTINGS,
        payCadence: 'biweekly',
        savingsPercent: 20,
        investmentPercent: 15,
        goalsPercent: 15,
        debtPercent: 5,
        wholeDollarBuckets: true
      })
    )

    const checking = createAccount(db, userId, {
      name: 'Everyday Checking',
      kind: 'checking',
      institution: 'Chase',
      startingBalanceCents: 245000,
      sortOrder: 1
    })
    const savings = createAccount(db, userId, {
      name: 'High-Yield Savings',
      kind: 'savings',
      institution: 'Ally',
      startingBalanceCents: 820000,
      sortOrder: 2
    })
    const brokerage = createAccount(db, userId, {
      name: 'Brokerage',
      kind: 'investment',
      institution: 'Fidelity',
      startingBalanceCents: 1240000,
      sortOrder: 3
    })
    createAccount(db, userId, {
      name: 'Cash Wallet',
      kind: 'cash',
      institution: '',
      startingBalanceCents: 12000,
      sortOrder: 4
    })
    createAccount(db, userId, {
      name: 'Tangerine World Mastercard',
      kind: 'credit',
      institution: 'Tangerine',
      startingBalanceCents: -42000,
      creditLimitCents: 500000,
      sortOrder: 5
    })

    const billIds = new Map<string, string>()
    for (const bill of DEMO_BILLS) {
      const id = createBill(db, userId, {
        name: bill.name,
        amountCents: bill.amountCents,
        frequency: bill.frequency,
        dueDay: bill.dueDay,
        category: bill.category,
        accountId: checking,
        autopay: bill.autopay,
        isActive: true,
        nextDueOn: null
      })
      billIds.set(bill.name, id)
    }

    const priorityCents = DEMO_BILLS.reduce(
      (total, bill) =>
        total + reservePerPaycheckCents(bill.amountCents, bill.frequency, 'biweekly'),
      0
    )

    const emergency = createGoal(db, userId, {
      name: 'Emergency Fund',
      targetCents: 500000,
      targetDate: addDaysISO(todayISO(), 240),
      priority: 1,
      color: '#38BDF8',
      accountId: savings,
      isEmergency: true
    })
    const tattoo = createGoal(db, userId, {
      name: 'Tattoo Fund',
      targetCents: 120000,
      targetDate: addDaysISO(todayISO(), 150),
      priority: 2,
      color: '#FBBF24',
      accountId: savings
    })
    const japan = createGoal(db, userId, {
      name: 'Japan Trip',
      targetCents: 350000,
      targetDate: addDaysISO(todayISO(), 365),
      priority: 3,
      color: '#A78BFA',
      accountId: savings
    })

    const paycheck = (daysAgo: number, goals: { goalId: string; label: string; amountCents: number }[]) => {
      seedPaycheck(db, userId, {
        depositAccountId: checking,
        daysAgo,
        incomeCents: 320000,
        priorityCents,
        savingsCents: 42000,
        investmentCents: 30000,
        debtCents: 15000,
        goalAllocations: goals
      })
    }

    paycheck(42, [
      { goalId: emergency, label: 'Emergency Fund', amountCents: 25000 },
      { goalId: tattoo, label: 'Tattoo Fund', amountCents: 10000 }
    ])
    paycheck(28, [
      { goalId: emergency, label: 'Emergency Fund', amountCents: 25000 },
      { goalId: tattoo, label: 'Tattoo Fund', amountCents: 10000 }
    ])
    paycheck(14, [
      { goalId: emergency, label: 'Emergency Fund', amountCents: 25000 },
      { goalId: tattoo, label: 'Tattoo Fund', amountCents: 10000 },
      { goalId: japan, label: 'Japan Trip', amountCents: 15000 }
    ])

    const today = todayISO()
    const spend = (
      accountId: string,
      amountCents: number,
      daysAgo: number,
      memo: string,
      category: string,
      kind: 'expense' | 'bill_payment' | 'transfer' | 'investment',
      billId?: string,
      counterAccountId?: string
    ) =>
      createTransaction(db, userId, {
        accountId,
        kind,
        amountCents,
        occurredOn: addDaysISO(today, -daysAgo),
        memo,
        category,
        billId: billId ?? null,
        counterAccountId: counterAccountId ?? null
      })

    spend(checking, -185000, 26, 'Rent', 'Housing', 'bill_payment', billIds.get('Rent'))
    spend(checking, -9820, 20, 'Electric', 'Utilities', 'bill_payment', billIds.get('Electric'))
    spend(checking, -8240, 2, "Trader Joe's", 'Groceries', 'expense')
    spend(checking, -4510, 4, 'Shell', 'Transport', 'expense')
    spend(checking, -685, 1, 'Blue Bottle', 'Dining', 'expense')
    spend(checking, -6340, 6, 'Sushi Kaido', 'Dining', 'expense')
    spend(checking, -4500, 12, 'Gym membership', 'Health', 'expense')

    spend(checking, -50000, 10, 'Savings transfer', 'Transfer', 'transfer', undefined, savings)
    createTransaction(db, userId, {
      accountId: savings,
      kind: 'transfer',
      amountCents: 50000,
      occurredOn: addDaysISO(today, -10),
      memo: 'Savings transfer',
      category: 'Transfer',
      counterAccountId: checking
    })

    spend(checking, -30000, 9, 'Brokerage contribution', 'Investing', 'investment', undefined, brokerage)
    createTransaction(db, userId, {
      accountId: brokerage,
      kind: 'investment',
      amountCents: 30000,
      occurredOn: addDaysISO(today, -9),
      memo: 'Brokerage contribution',
      category: 'Investing',
      counterAccountId: checking
    })

    return userId
  })

  return seed()
}

interface SeedPaycheckInput {
  depositAccountId: string
  daysAgo: number
  incomeCents: number
  priorityCents: number
  savingsCents: number
  investmentCents: number
  debtCents: number
  goalAllocations: { goalId: string; label: string; amountCents: number }[]
}

function seedPaycheck(db: Db, userId: string, input: SeedPaycheckInput): void {
  const goalTotal = input.goalAllocations.reduce(
    (total, allocation) => total + allocation.amountCents,
    0
  )
  const leisureCents =
    input.incomeCents -
    input.priorityCents -
    input.savingsCents -
    input.investmentCents -
    input.debtCents -
    goalTotal
  if (leisureCents < 0) throw new Error('Seeded paycheck allocates more than it earns')

  insertPaycheckRecord(db, userId, {
    incomeCents: input.incomeCents,
    receivedOn: addDaysISO(todayISO(), -input.daysAgo),
    source: 'Payroll',
    depositAccountId: input.depositAccountId,
    priorityCents: input.priorityCents,
    surplusCents: input.incomeCents - input.priorityCents,
    leisureCents,
    health: 'covered',
    recordIncome: true,
    allocations: [
      {
        bucket: 'priority',
        goalId: null,
        label: 'Priority Wall reserve',
        amountCents: input.priorityCents
      },
      { bucket: 'savings', goalId: null, label: 'Savings', amountCents: input.savingsCents },
      {
        bucket: 'investment',
        goalId: null,
        label: 'Investments',
        amountCents: input.investmentCents
      },
      { bucket: 'debt', goalId: null, label: 'Debt payoff', amountCents: input.debtCents },
      ...input.goalAllocations.map((allocation) => ({
        bucket: 'goal' as const,
        goalId: allocation.goalId,
        label: allocation.label,
        amountCents: allocation.amountCents
      })),
      {
        bucket: 'leisure',
        goalId: null,
        label: 'Guilt-free spending',
        amountCents: leisureCents
      }
    ]
  })
}
