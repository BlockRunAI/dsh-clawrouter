/**
 * HTTP status to harness failure code.
 *
 * Its own module because {@link ../translate.ts} needs it too, and `adapter.ts`
 * already imports the translator — putting it there would close a cycle.
 *
 * @module dsh-clawrouter/http-error
 */

import { CONTEXT_WINDOW_EXCEEDED_CODE, isContextWindowExceededError, isQuotaExceededError, QUOTA_EXCEEDED_CODE } from '@deepseek-ai/dsh-llm'


export function httpErrorCode(status: number, detail = ''): string {
  if (status === 401 || status === 403) return 'AUTH'
  // x402's own status, checked before the quota wording below: "insufficient
  // balance" on a 402 is this wallet being short, which is the more precise
  // answer than a generic account-quota failure.
  if (status === 402) return 'PAYMENT_REQUIRED'
  if (isQuotaExceededError(detail)) return QUOTA_EXCEEDED_CODE
  if (status === 429) return 'RATE_LIMIT'
  if (status === 400) {
    // Compaction's overflow recovery keys on this exact code
    // (`compaction-basic` compares `failure.code`), so reporting an overflow
    // as a plain invalid request silently costs a long session its automatic
    // recovery: it fails instead of compacting and carrying on.
    if (isContextWindowExceededError(detail)) return CONTEXT_WINDOW_EXCEEDED_CODE
    return 'INVALID_REQUEST'
  }
  if (status >= 500) return 'SERVER'
  return `HTTP_${status}`
}
