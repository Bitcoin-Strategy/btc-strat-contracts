import { type Address } from 'viem';

/** Uniswap's canonical v4 stack, which the app must use. Same addresses on Robinhood mainnet and testnet.
//  * Source: https://developers.uniswap.org/contracts/v4/deployments */

export type CanonicalV4 = {
  poolManager: Address;
  positionManager: Address;
  /// Simulated, not read: a quote reverts with its answer.
  quoter: Address;
  stateView: Address;
  universalRouter: Address;
  permit2: Address;
};

const ROBINHOOD: CanonicalV4 = {
  poolManager: '0x8366a39cc670b4001a1121b8f6a443a643e40951',
  positionManager: '0x58daec3116aae6d93017baaea7749052e8a04fa7',
  quoter: '0x8dc178efb8111bb0973dd9d722ebeff267c98f94',
  stateView: '0xf3334192d15450cdd385c8b70e03f9a6bd9e673b',
  universalRouter: '0x8876789976decbfcbbbe364623c63652db8c0904',
  permit2: '0x000000000022D473030F116dDEE9F6B43aC78BA3',
};

export const CANONICAL_V4: Record<number, CanonicalV4> = {
  4663: ROBINHOOD,
  46630: ROBINHOOD,
};

export const canonicalV4 = (chainId: number): CanonicalV4 | undefined =>
  CANONICAL_V4[chainId];

/** Whether the router's `ExactInputSingleParams` has `sqrtPriceLimitX96`; proved by `check-swap-venue.ts`. */
export type V4ActionLayout = 'with-price-limit' | 'without-price-limit';

export const V4_ACTION_LAYOUT: Record<number, V4ActionLayout> = {
  4663: 'with-price-limit',
  46630: 'with-price-limit',
};

export const V4_SWAP_COMMAND = 0x10;

/// From `v4-periphery/src/libraries/Actions.sol`.
export const V4_ACTIONS = {
  swapExactInSingle: 0x06,
  swapExactIn: 0x07,
  settleAll: 0x0c,
  takeAll: 0x0f,
} as const;
