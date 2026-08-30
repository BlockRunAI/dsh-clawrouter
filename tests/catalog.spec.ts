import { describe, expect, it } from 'vitest'
import { DEFAULT_CONTEXT_WINDOW, DEFAULT_MAX_TOKENS, projectCatalog, suggestModels } from '../src/catalog.ts'

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
    // Capped: the gateway settles on requested max_tokens, so declaring this
    // model's full 65,536 would bill every unspecified call for output nobody
    // asked for. See "the default output cap is a money decision" below.
    expect(model?.defaultMaxTokens).toBe(8_192)
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

  it('declares image input for a model measured to accept one', () => {
    const [model] = projectCatalog('blockrun', {
      data: [{ id: 'google/gemini-3.5-flash', categories: ['chat', 'vision'] }],
    })
    expect(model?.inputModalities).toEqual(['text', 'image'])
  })

  it('keeps a vision-TAGGED model text-only when it is not on the verified list', () => {
    // The tag over-claims. Sent the same inline PNG, this model dropped the
    // image and answered "I didn't receive any image", and the turn was
    // paid for. Trusting the tag would admit an attachment that fails
    // mid-turn, after the message is durable and the call is paid for.
    const [model] = projectCatalog('blockrun', {
      data: [{ id: 'openai/gpt-5.2-pro', categories: ['chat', 'vision'] }],
    })
    expect(model?.inputModalities).toEqual(['text'])
  })

  it('keeps an untagged model text-only even if it is listed', () => {
    // Both signals must agree, so a model the gateway has retagged away from
    // vision stops being offered one without waiting for a release here.
    const [model] = projectCatalog('blockrun', {
      data: [{ id: 'google/gemini-3.5-flash', categories: ['chat'] }],
    }, ['google/gemini-3.5-flash'])
    expect(model?.inputModalities).toEqual(['text'])
  })

  it('takes a caller-supplied list, so a fixed gateway needs no release here', () => {
    const [model] = projectCatalog('blockrun', {
      data: [{ id: 'openai/gpt-5.2-pro', categories: ['chat', 'vision'] }],
    }, ['openai/gpt-5.2-pro'])
    expect(model?.inputModalities).toEqual(['text', 'image'])
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

describe('suggestModels', () => {
  const KNOWN = [
    'deepseek/deepseek-chat', 'deepseek/deepseek-v4-pro', 'deepseek/deepseek-reasoner',
    'anthropic/claude-opus-5', 'anthropic/claude-sonnet-4.6',
    'openai/gpt-4.1-nano', 'google/gemini-3.5-flash',
  ]

  it.each([
    // The three mistakes a real run produced, in order of how likely they are.
    ['deepseek-chat', 'deepseek/deepseek-chat'],            // dropped the vendor prefix
    ['anthropic/claude-opus5', 'anthropic/claude-opus-5'],  // missing hyphen
    ['deepseek/deepseek-v4', 'deepseek/deepseek-v4-pro'],   // truncated suffix
  ])('suggests %j -> %j', (typo, expected) => {
    expect(suggestModels(typo, KNOWN)[0]).toBe(expected)
  })

  it('returns the exact id alone when it is a case or punctuation variant', () => {
    expect(suggestModels('DeepSeek/DeepSeek-Chat', KNOWN)).toEqual(['deepseek/deepseek-chat'])
  })

  it('suggests nothing for a name with no relation to the catalog', () => {
    // Proposing the alphabetically nearest noise would be worse than silence.
    expect(suggestModels('llama-3-70b-instruct', KNOWN)).toEqual([])
    expect(suggestModels('', KNOWN)).toEqual([])
  })

  it('bounds how many it offers', () => {
    expect(suggestModels('deepseek', KNOWN).length).toBeLessThanOrEqual(3)
  })
})

describe('reasoning efforts', () => {
  it('offers efforts for a reasoning-tagged model', () => {
    const [model] = projectCatalog('blockrun', {
      data: [{ id: 'deepseek/deepseek-reasoner', categories: ['chat', 'reasoning'] }],
    })
    expect(model?.reasoning?.efforts.map(effort => effort.id)).toEqual(['high', 'max'])
  })

  it('offers none for a model that does not reason', () => {
    // Not cosmetic: `openai/gpt-4o` returns HTTP 400 for reasoning_effort after
    // taking payment, so the adapter refuses locally on this absence.
    const [model] = projectCatalog('blockrun', { data: [{ id: 'openai/gpt-4o', categories: ['chat', 'vision'] }] })
    expect(model?.reasoning).toBeUndefined()
  })

  it('declares efforts from the tag, unlike vision', () => {
    // The two fail at different cost. A wrongly-claimed vision model charges
    // and fails; a wrongly-claimed effort is translated to the vendor's nearest
    // value and the answer still arrives.
    const [model] = projectCatalog('blockrun', { data: [{ id: 'xai/grok-4.5', categories: ['chat', 'reasoning'] }] })
    expect(model?.reasoning?.efforts).toHaveLength(2)
    expect(model?.inputModalities).toEqual(['text'])
  })
})

describe('the default output cap is a money decision', () => {
  // This gateway quotes on the max_tokens you REQUEST and settles that amount,
  // not what the model returns. Measured on anthropic/claude-opus-5: capped at
  // its advertised 128,000 max_output a request quotes $0.3211, against
  // $0.0216 with no cap and $0.0036 capped at 1,000. Declaring the advertised
  // ceiling as the default billed 89x for output nobody asked for.
  it('caps the default well below a large advertised max_output', () => {
    const [model] = projectCatalog('blockrun', {
      data: [{ id: 'anthropic/claude-opus-5', categories: ['chat'], max_output: 128_000 }],
    })
    expect(model?.defaultMaxTokens).toBe(8_192)
  })

  it('leaves a model that advertises less than the ceiling alone', () => {
    const [model] = projectCatalog('blockrun', {
      data: [{ id: 'x', categories: ['chat'], max_output: 4_096 }],
    })
    expect(model?.defaultMaxTokens).toBe(4_096)
  })

  it('takes a caller-supplied ceiling, for workloads that need long replies', () => {
    const [model] = projectCatalog('blockrun', {
      data: [{ id: 'x', categories: ['chat'], max_output: 128_000 }],
    }, undefined, 32_000)
    expect(model?.defaultMaxTokens).toBe(32_000)
  })
})
