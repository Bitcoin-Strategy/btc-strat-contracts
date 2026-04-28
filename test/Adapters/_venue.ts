import hre from 'hardhat';
import { TickMath } from '@uniswap/v3-sdk';
import { type Address } from 'viem';

import {
  addLiquidity,
  deployUniswapV4,
  fullRange,
  initializePool,
  sortCurrencies,
  type PoolKey,
} from '../../scripts/lib/uniswap-v4-local';
import { tickForPrice } from '../Oracle/_v4';

export {
  addLiquidity,
  claimBalance,
  currentTick,
  fullRange,
  swapExactIn,
  type PoolKey,
} from '../../scripts/lib/uniswap-v4-local';

export const FEE = 3000;
export const TICK_SPACING = 60;
const ZERO_HOOK = '0x0000000000000000000000000000000000000000' as Address;

/// STRAT $2, BTC $100k, MID $1.
export const BTC_PER_STRAT = 0.00002;
export const MID_PER_STRAT = 2;
export const BTC_PER_MID = 0.00001;

export type Token = { address: Address; decimals: number };

export type Venue = {
  poolManager: Address;
  swapRouter: Address;
  liquidityRouter: Address;
  stateView: Address;
  strat: Token;
  btc: Token;
  mid: Token;
  stratBtc: PoolKey;
  stratMid: PoolKey;
  midBtc: PoolKey;
};

const deployToken = async (
  symbol: string,
  decimals: number,
): Promise<Token> => {
  const token = await hre.viem.deployContract('MockERC20Decimals', [
    symbol,
    symbol,
    decimals,
  ]);
  return { address: token.address, decimals };
};

/// STRAT/cbBTC plus two pools through a third token for multi-hop. Hookless, so failures are about the adapters.
export async function deployVenue(
  opts: { liquidity?: bigint } = {},
): Promise<Venue> {
  const { liquidity = 10n ** 18n } = opts;

  const [deployer] = await hre.viem.getWalletClients();
  const publicClient = await hre.viem.getPublicClient();

  const v4 = await deployUniswapV4();

  const strat = await deployToken('STRAT', 18);
  const btc = await deployToken('cbBTC', 8);
  const mid = await deployToken('MID', 6);

  for (const token of [strat, btc, mid]) {
    const erc20 = await hre.viem.getContractAt(
      'MockERC20Decimals',
      token.address,
    );
    const hash = await erc20.write.mint([deployer.account.address, 10n ** 36n]);
    await publicClient.waitForTransactionReceipt({ hash });
  }

  const open = async (
    base: Token,
    quote: Token,
    quotePerBase: number,
  ): Promise<PoolKey> => {
    const [currency0, currency1] = sortCurrencies(base.address, quote.address);
    const baseIsCurrency0 =
      currency0.toLowerCase() === base.address.toLowerCase();

    const key: PoolKey = {
      currency0,
      currency1,
      fee: FEE,
      tickSpacing: TICK_SPACING,
      hooks: ZERO_HOOK,
    };

    const tick = tickForPrice({
      quotePerBase,
      baseDecimals: base.decimals,
      quoteDecimals: quote.decimals,
      baseIsCurrency0,
    });

    await initializePool({
      poolManager: v4.poolManager,
      key,
      sqrtPriceX96: BigInt(TickMath.getSqrtRatioAtTick(tick).toString()),
    });

    const range = fullRange(TICK_SPACING);
    await addLiquidity({
      liquidityRouter: v4.liquidityRouter,
      key,
      tickLower: range.tickLower,
      tickUpper: range.tickUpper,
      liquidityDelta: liquidity,
    });

    return key;
  };

  const stratBtc = await open(strat, btc, BTC_PER_STRAT);
  const stratMid = await open(strat, mid, MID_PER_STRAT);
  const midBtc = await open(mid, btc, BTC_PER_MID);

  return { ...v4, strat, btc, mid, stratBtc, stratMid, midBtc };
}

export const hop = (key: PoolKey, tokenIn: Address) => ({
  key,
  zeroForOne: key.currency0.toLowerCase() === tokenIn.toLowerCase(),
});

export const balanceOf = async (
  token: Address,
  holder: Address,
): Promise<bigint> => {
  const erc20 = await hre.viem.getContractAt('MockERC20Decimals', token);
  return erc20.read.balanceOf([holder]);
};

export const whole = (token: Token, amount: number): bigint =>
  BigInt(amount) * 10n ** BigInt(token.decimals);
