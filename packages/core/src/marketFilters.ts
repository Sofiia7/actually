import { NOISE_QUESTION_PATTERNS } from './constants'

export function isNoiseMarket(question: string): boolean {
  return NOISE_QUESTION_PATTERNS.some((re) => re.test(question))
}
