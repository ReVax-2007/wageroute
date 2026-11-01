import assert from 'node:assert/strict'
import test from 'node:test'
import { CHANNELS } from '../shared/channels'
import { createFinanceApi } from './api'

const ignore = (async () => undefined) as never

test('every bridge method reaches one declared channel, and the contract has no extras', async () => {
  const seen: string[] = []
  const call = (async (channel: string) => {
    seen.push(channel)
    return undefined
  }) as never
  const api = createFinanceApi(call)

  for (const method of Object.values(api)) {
    await (method as (...args: unknown[]) => Promise<unknown>)('id', {}, [])
  }

  assert.deepEqual([...seen].sort(), [...CHANNELS].sort())
})

test('the bridge exposes exactly the channels the contract declares', () => {
  const api = createFinanceApi(ignore)
  assert.equal(Object.keys(api).length, CHANNELS.length)
})
