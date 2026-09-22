import hre from 'hardhat';

export {
  addLiquidity,
  deployUniswapV4,
  fullRange,
  fullRangeLiquidity,
  swapExactIn,
  currentLiquidity,
  currentTick,
  poolId,
  type PoolKey,
} from '../../scripts/lib/uniswap-v4-local';

export const warp = async (seconds: bigint | number) => {
  await hre.network.provider.send('evm_increaseTime', [Number(seconds)]);
  await hre.network.provider.send('evm_mine');
};

export const mineBlocks = async (n: number) => {
  await hre.network.provider.send('hardhat_mine', ['0x' + n.toString(16)]);
};

export const now = async (): Promise<bigint> => {
  const publicClient = await hre.viem.getPublicClient();
  return (await publicClient.getBlock()).timestamp;
};
