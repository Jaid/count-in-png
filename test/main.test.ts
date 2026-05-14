import {expect, test} from 'bun:test'

const {default: countInPng} = await import('#src/main.ts')

test('should run', () => {
  expect(countInPng).toBe('count-in-png') // TODO Test actual functionality
})
