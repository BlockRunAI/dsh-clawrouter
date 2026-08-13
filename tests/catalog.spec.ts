import { describe, expect, it } from 'vitest'
import { DEFAULT_CONTEXT_WINDOW, DEFAULT_MAX_TOKENS, projectCatalog } from '../src/catalog.ts'

/** An entry in the exact shape `GET /api/v1/models` really returns. */
const deepseekChat = {
  id: 'deepseek/deepseek-chat',
  object: 'model',
  owned_by: 'deepseek',
  name: 'DeepSeek V4 Flash Chat',
  description: 'Paid V4 Flash in non-thinking mode.',
  context_window: 1_048_576,
  max_output: 65_536,
  categories: ['chat', 'coding'],
  billing_mode: 'paid',
  pricing: { input: 0.14, output: 0.28 },
}

describe('projectCatalog', () => {
  it('reads capacity from context_window', () => {
    const [model] = projectCatalog('blockrun', { data: [deepseekChat] })
    // Regression: an earlier build read `context_length`, silently fell back to
    // the default, and reported a 1M-context model as 131072 — which would
    // compact a session long before it needed to.
    expect(model?.context?.contextWindow).toBe(1_048_576)
    expect(model?.defaultMaxTokens).toBe(65_536)
    expect(model?.name).toBe('DeepSeek V4 Flash Chat')
    expect(model?.provider).toBe('blockrun')
  })

  it('accepts context_length from a gateway that spells it that way', () => {
    const [model] = projectCatalog('blockrun', { data: [{ id: 'x', context_length: 32_000 }] })
    expect(model?.context?.contextWindow).toBe(32_000)
  })

  it('excludes media models that cannot hold a conversation', () => {
    const ids = projectCatalog('blockrun', {
      data: [
        deepseekChat,
        { id: 'google/nano-banana', categories: ['image'], billing_mode: 'per_image' },
        { id: 'bytedance/seedance-2.0', categories: ['video'], billing_mode: 'per_second' },
        { id: 'openai/tts', categories: ['speech'], billing_mode: 'per_character' },
      ],
    }).map(model => model.id)
    // Offering an image model as an agent model would let a user select it and
    // fail on the first turn.
    expect(ids).toEqual(['deepseek/deepseek-chat'])
  })

  it('keeps an untagged entry, since another gateway may not categorize at all', () => {
    const ids = projectCatalog('blockrun', { data: [{ id: 'private/model-a' }] }).map(model => model.id)
    expect(ids).toEqual(['private/model-a'])
  })

  it('declares text-only input even for a vision-tagged model', () => {
    const [model] = projectCatalog('blockrun', {
      data: [{ id: 'openai/gpt-5.6-sol', categories: ['chat', 'vision'] }],
    })
    // This adapter refuses image content, so claiming the capability would
    // admit an attachment the request then rejects mid-turn.
    expect(model?.inputModalities).toEqual(['text'])
  })

  it('sizes a model the catalog does not size', () => {
    const [model] = projectCatalog('blockrun', { data: [{ id: 'x', categories: ['chat'] }] })
    expect(model?.context?.contextWindow).toBe(DEFAULT_CONTEXT_WINDOW)
    expect(model?.defaultMaxTokens).toBe(DEFAULT_MAX_TOKENS)
  })

  it('drops entries that carry no usable id', () => {
    const ids = projectCatalog('blockrun', { data: [deepseekChat, { name: 'no id' }, { id: '' }, null, 'nope'] })
      .map(model => model.id)
    expect(ids).toEqual(['deepseek/deepseek-chat'])
  })

  it('falls back to the id when the entry has no name', () => {
    const [model] = projectCatalog('blockrun', { data: [{ id: 'bare/model' }] })
    expect(model?.name).toBe('bare/model')
    expect(model?.description).toBeUndefined()
  })

  it('accepts a bare array as well as a data envelope', () => {
    expect(projectCatalog('blockrun', [deepseekChat])).toHaveLength(1)
  })

  it('reads an unusable body as an empty catalog rather than throwing', () => {
    expect(projectCatalog('blockrun', {})).toEqual([])
    expect(projectCatalog('blockrun', null)).toEqual([])
  })

  it('ignores a nonsensical capacity instead of reporting it', () => {
    const [model] = projectCatalog('blockrun', { data: [{ id: 'x', context_window: -5, max_output: 0 }] })
    expect(model?.context?.contextWindow).toBe(DEFAULT_CONTEXT_WINDOW)
    expect(model?.defaultMaxTokens).toBe(DEFAULT_MAX_TOKENS)
  })
})
