import { encodeAbiParameters, keccak256, type Address, type Hex } from 'viem';

/// Pure V4 key helpers, without the local test stack.

export type PoolKey = {
  currency0: Address;
  currency1: Address;
  fee: number;
  tickSpacing: number;
  hooks: Address;
};

export const POOL_KEY_COMPONENTS = [
  { name: 'currency0', type: 'address' },
  { name: 'currency1', type: 'address' },
  { name: 'fee', type: 'uint24' },
  { name: 'tickSpacing', type: 'int24' },
  { name: 'hooks', type: 'address' },
] as const;

export const sortCurrencies = (a: Address, b: Address): [Address, Address] =>
  a.toLowerCase() < b.toLowerCase() ? [a, b] : [b, a];

export const poolId = (key: PoolKey): Hex =>
  keccak256(
    encodeAbiParameters(
      [{ type: 'tuple', components: POOL_KEY_COMPONENTS }],
      [key],
    ),
  );

export const buildPoolKey = (params: {
  tokenA: Address;
  tokenB: Address;
  fee: number;
  tickSpacing: number;
  hooks: Address;
}): PoolKey => {
  const [currency0, currency1] = sortCurrencies(params.tokenA, params.tokenB);
  return {
    currency0,
    currency1,
    fee: params.fee,
    tickSpacing: params.tickSpacing,
    hooks: params.hooks,
  };
};

export const POOL_MANAGER_ABI = [
  {
    type: 'function',
    name: 'initialize',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'key', type: 'tuple', components: POOL_KEY_COMPONENTS },
      { name: 'sqrtPriceX96', type: 'uint160' },
    ],
    outputs: [{ name: 'tick', type: 'int24' }],
  },
  {
    type: 'function',
    name: 'extsload',
    stateMutability: 'view',
    inputs: [{ name: 'slot', type: 'bytes32' }],
    outputs: [{ name: 'value', type: 'bytes32' }],
  },
] as const;

const POOLS_SLOT = 6n;

/// Offset of `liquidity` inside `Pool.State`, as in `StateLibrary`.
const LIQUIDITY_OFFSET = 3n;

export const poolStateSlot = (id: Hex): Hex =>
  keccak256(
    encodeAbiParameters(
      [{ type: 'bytes32' }, { type: 'uint256' }],
      [id, POOLS_SLOT],
    ),
  );

type Reader = { readContract: (args: any) => Promise<any> };

/// `PoolManager` exposes state only through `extsload`.
const extsload = async (
  publicClient: Reader,
  poolManager: Address,
  slot: Hex,
): Promise<bigint> =>
  BigInt(
    (await publicClient.readContract({
      address: poolManager,
      abi: POOL_MANAGER_ABI,
      functionName: 'extsload',
      args: [slot],
    })) as Hex,
  );

const asInt24 = (value: bigint): number =>
  Number(value >= 1n << 23n ? value - (1n << 24n) : value);

export async function readPoolSlot0(
  publicClient: Reader,
  poolManager: Address,
  id: Hex,
): Promise<{
  sqrtPriceX96: bigint;
  tick: number;
  protocolFee: number;
  lpFee: number;
}> {
  const word = await extsload(publicClient, poolManager, poolStateSlot(id));
  return {
    sqrtPriceX96: word & ((1n << 160n) - 1n),
    tick: asInt24((word >> 160n) & 0xffffffn),
    protocolFee: Number((word >> 184n) & 0xffffffn),
    lpFee: Number((word >> 208n) & 0xffffffn),
  };
}

export async function readPoolLiquidity(
  publicClient: Reader,
  poolManager: Address,
  id: Hex,
): Promise<bigint> {
  const slot = (BigInt(poolStateSlot(id)) + LIQUIDITY_OFFSET)
    .toString(16)
    .padStart(64, '0');
  const word = await extsload(publicClient, poolManager, `0x${slot}`);
  return word & ((1n << 128n) - 1n);
}

export async function isPoolInitialized(
  publicClient: Reader,
  poolManager: Address,
  key: PoolKey,
): Promise<boolean> {
  const { sqrtPriceX96 } = await readPoolSlot0(
    publicClient,
    poolManager,
    poolId(key),
  );
  return sqrtPriceX96 !== 0n;
}
