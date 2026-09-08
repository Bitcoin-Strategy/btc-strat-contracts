import hre from 'hardhat';
import { type Abi, type Address, type Hex } from 'viem';

import { waitForSuccess } from './tx';
import { poolId, type PoolKey } from './v4-keys';

import poolManagerArtifact from '@uniswap/v4-core/out/PoolManager.sol/PoolManager.json';
import poolSwapTestArtifact from '@uniswap/v4-core/out/PoolSwapTest.sol/PoolSwapTest.json';
import poolModifyLiquidityTestArtifact from '@uniswap/v4-core/out/PoolModifyLiquidityTest.sol/PoolModifyLiquidityTest.json';
import stateViewArtifact from '@uniswap/v4-periphery/foundry-out/StateView.sol/StateView.json';
import v4QuoterArtifact from '@uniswap/v4-periphery/foundry-out/V4Quoter.sol/V4Quoter.json';

/// A real V4 stack for local chains, from Uniswap's npm artifacts: the hook must be tested against real call timing.

export const POOL_MANAGER_ABI = poolManagerArtifact.abi as Abi;
export const SWAP_ROUTER_ABI = poolSwapTestArtifact.abi as Abi;
export const LIQUIDITY_ROUTER_ABI = poolModifyLiquidityTestArtifact.abi as Abi;
export const STATE_VIEW_ABI = stateViewArtifact.abi as Abi;
export const V4_QUOTER_ABI = v4QuoterArtifact.abi as Abi;

export { poolId, sortCurrencies, buildPoolKey, type PoolKey } from './v4-keys';

export const MIN_SQRT_PRICE = 4295128739n;
export const MAX_SQRT_PRICE =
  1461446703485210103287273052203988822378723970342n;

const isqrt = (n: bigint): bigint => {
  if (n < 2n) return n;
  let x0 = n;
  let x1 = (x0 + n / x0) >> 1n;
  while (x1 < x0) {
    x0 = x1;
    x1 = (x0 + n / x0) >> 1n;
  }
  return x0;
};

/// Full-range `L = sqrt(amount0 * amount1)`; the amounts must match the pool ratio.
export const fullRangeLiquidity = (
  amount0Raw: bigint,
  amount1Raw: bigint,
): bigint => isqrt(amount0Raw * amount1Raw);

export const fullRange = (tickSpacing: number) => ({
  tickLower: Math.ceil(-887272 / tickSpacing) * tickSpacing,
  tickUpper: Math.floor(887272 / tickSpacing) * tickSpacing,
});

const deployArtifact = async (
  artifact: { abi: unknown; bytecode: { object: string } },
  args: unknown[],
): Promise<Address> => {
  const [deployer] = await hre.viem.getWalletClients();
  const publicClient = await hre.viem.getPublicClient();

  const hash = await deployer.deployContract({
    abi: artifact.abi as Abi,
    bytecode: artifact.bytecode.object as Hex,
    args,
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success' || !receipt.contractAddress) {
    throw new Error(`deploy failed (${hash})`);
  }
  return receipt.contractAddress;
};

/// Deploys only `PoolManager`, the one piece a local chain lacks.
export async function deployPoolManager(): Promise<Address> {
  const [deployer] = await hre.viem.getWalletClients();
  return deployArtifact(poolManagerArtifact, [deployer.account.address]);
}

export async function deployTestnetRouters(poolManager: Address): Promise<{
  swapRouter: Address;
  liquidityRouter: Address;
  stateView: Address;
}> {
  const swapRouter = await deployArtifact(poolSwapTestArtifact, [poolManager]);
  const liquidityRouter = await deployArtifact(
    poolModifyLiquidityTestArtifact,
    [poolManager],
  );
  const stateView = await deployArtifact(stateViewArtifact, [poolManager]);

  return { swapRouter, liquidityRouter, stateView };
}

/// A quote is a swap that reverts with its result, so chains without a canonical quoter need one.
export async function deployV4Quoter(poolManager: Address): Promise<Address> {
  return deployArtifact(v4QuoterArtifact, [poolManager]);
}

export async function deployUniswapV4(): Promise<{
  poolManager: Address;
  swapRouter: Address;
  liquidityRouter: Address;
  stateView: Address;
}> {
  const poolManager = await deployPoolManager();
  return { poolManager, ...(await deployTestnetRouters(poolManager)) };
}

/// `caller` matters: the hook may gate initialization.
export async function initializePool(params: {
  poolManager: Address;
  key: PoolKey;
  sqrtPriceX96: bigint;
  caller?: any;
}): Promise<void> {
  const { poolManager, key, sqrtPriceX96 } = params;
  const [defaultCaller] = await hre.viem.getWalletClients();
  const caller = params.caller ?? defaultCaller;

  const hash = await caller.writeContract({
    address: poolManager,
    abi: POOL_MANAGER_ABI,
    functionName: 'initialize',
    args: [key, sqrtPriceX96],
  });
  await waitForSuccess(hash, 'PoolManager.initialize');
}

export async function approvePair(
  key: PoolKey,
  spender: Address,
  owner: any,
  amount: bigint,
): Promise<void> {
  for (const currency of [key.currency0, key.currency1]) {
    const token = await hre.viem.getContractAt(
      'MockERC20Decimals',
      currency as Address,
    );
    const hash = await token.write.approve([spender, amount], {
      account: owner.account,
    });
    await waitForSuccess(hash, `approve(${currency})`);
  }
}

export async function addLiquidity(params: {
  liquidityRouter: Address;
  key: PoolKey;
  tickLower: number;
  tickUpper: number;
  liquidityDelta: bigint;
  provider?: any;
}): Promise<void> {
  const { liquidityRouter, key, tickLower, tickUpper, liquidityDelta } = params;
  const [defaultProvider] = await hre.viem.getWalletClients();
  const provider = params.provider ?? defaultProvider;

  await approvePair(key, liquidityRouter, provider, 2n ** 255n);

  const hash = await provider.writeContract({
    address: liquidityRouter,
    abi: LIQUIDITY_ROUTER_ABI,
    functionName: 'modifyLiquidity',
    args: [
      key,
      {
        tickLower,
        tickUpper,
        liquidityDelta,
        salt: `0x${'00'.repeat(32)}`,
      },
      '0x',
    ],
  });
  await waitForSuccess(hash, 'PoolModifyLiquidityTest.modifyLiquidity');
}

/// Does not wait or approve; for several swaps in one block.
export async function swapTx(params: {
  swapRouter: Address;
  key: PoolKey;
  zeroForOne: boolean;
  amountIn: bigint;
  trader?: any;
}): Promise<Hex> {
  const { swapRouter, key, zeroForOne, amountIn } = params;
  const [defaultTrader] = await hre.viem.getWalletClients();
  const trader = params.trader ?? defaultTrader;

  return trader.writeContract({
    address: swapRouter,
    abi: SWAP_ROUTER_ABI,
    functionName: 'swap',
    args: [
      key,
      {
        zeroForOne,
        amountSpecified: -amountIn,
        sqrtPriceLimitX96: zeroForOne
          ? MIN_SQRT_PRICE + 1n
          : MAX_SQRT_PRICE - 1n,
      },
      { takeClaims: false, settleUsingBurn: false },
      '0x',
    ],
    gas: 2_000_000n,
  });
}

export async function swapExactIn(params: {
  swapRouter: Address;
  key: PoolKey;
  zeroForOne: boolean;
  amountIn: bigint;
  trader?: any;
}): Promise<void> {
  const [defaultTrader] = await hre.viem.getWalletClients();
  const trader = params.trader ?? defaultTrader;

  await approvePair(params.key, params.swapRouter, trader, 2n ** 255n);

  const hash = await swapTx(params);
  await waitForSuccess(hash, 'PoolSwapTest.swap');
}

export async function swapExactOut(params: {
  swapRouter: Address;
  key: PoolKey;
  zeroForOne: boolean;
  amountOut: bigint;
  trader?: any;
}): Promise<void> {
  const { swapRouter, key, zeroForOne, amountOut } = params;
  const [defaultTrader] = await hre.viem.getWalletClients();
  const trader = params.trader ?? defaultTrader;

  await approvePair(key, swapRouter, trader, 2n ** 255n);

  const hash = await trader.writeContract({
    address: swapRouter,
    abi: SWAP_ROUTER_ABI,
    functionName: 'swap',
    args: [
      key,
      {
        zeroForOne,
        amountSpecified: amountOut,
        sqrtPriceLimitX96: zeroForOne
          ? MIN_SQRT_PRICE + 1n
          : MAX_SQRT_PRICE - 1n,
      },
      { takeClaims: false, settleUsingBurn: false },
      '0x',
    ],
    gas: 2_000_000n,
  });
  await waitForSuccess(hash, 'PoolSwapTest.swap (exact out)');
}

/// A currency's claim id is its address.
export async function claimBalance(
  poolManager: Address,
  owner: Address,
  currency: Address,
): Promise<bigint> {
  const publicClient = await hre.viem.getPublicClient();
  return (await publicClient.readContract({
    address: poolManager,
    abi: POOL_MANAGER_ABI,
    functionName: 'balanceOf',
    args: [owner, BigInt(currency)],
  })) as bigint;
}

export async function currentTick(
  stateView: Address,
  key: PoolKey,
): Promise<number> {
  const publicClient = await hre.viem.getPublicClient();
  const slot0 = (await publicClient.readContract({
    address: stateView,
    abi: STATE_VIEW_ABI,
    functionName: 'getSlot0',
    args: [poolId(key)],
  })) as [bigint, number, number, number];
  return slot0[1];
}

export async function currentLiquidity(
  stateView: Address,
  key: PoolKey,
): Promise<bigint> {
  const publicClient = await hre.viem.getPublicClient();
  return (await publicClient.readContract({
    address: stateView,
    abi: STATE_VIEW_ABI,
    functionName: 'getLiquidity',
    args: [poolId(key)],
  })) as bigint;
}
