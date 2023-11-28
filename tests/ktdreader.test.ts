import { describe, expect, it, beforeAll } from '@jest/globals'
import { KtdReader } from '../src/ktdreader'

describe('KtdReader tests', () => {
  it('should', () => {
    const reader = new KtdReader('./tests/data/test.ktd')
  })
})
