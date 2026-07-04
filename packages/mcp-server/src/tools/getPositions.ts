import type { Position } from '../positions'

export interface GetPositionsDeps {
  privateKey: string | undefined
  getFunderAddress: () => Promise<string>
  fetchPositions: (address: string) => Promise<Position[]>
}

export interface GetPositionsOutput {
  ok: boolean
  positions?: Position[]
  error?: string
}

export async function getPositions(deps: GetPositionsDeps): Promise<GetPositionsOutput> {
  if (!deps.privateKey) {
    return { ok: false, error: 'not_configured' }
  }
  try {
    const address = await deps.getFunderAddress()
    const positions = await deps.fetchPositions(address)
    return { ok: true, positions }
  } catch (err) {
    return { ok: false, error: String(err instanceof Error ? err.message : err) }
  }
}
