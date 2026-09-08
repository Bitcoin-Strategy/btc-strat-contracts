import hre from 'hardhat';
import {
  concat,
  getAddress,
  keccak256,
  pad,
  toHex,
  type Address,
  type Hex,
} from 'viem';

/// V4 reads hook permissions from the low 14 bits of the address, so the address is mined and
/// deployed through the same CREATE2 proxy locally and on mainnet.

/// Permission bits, as laid out in `Hooks.sol`.
export const HOOK_FLAG = {
  beforeInitialize: 1 << 13,
  afterInitialize: 1 << 12,
  beforeAddLiquidity: 1 << 11,
  afterAddLiquidity: 1 << 10,
  beforeRemoveLiquidity: 1 << 9,
  afterRemoveLiquidity: 1 << 8,
  beforeSwap: 1 << 7,
  afterSwap: 1 << 6,
  beforeDonate: 1 << 5,
  afterDonate: 1 << 4,
  beforeSwapReturnDelta: 1 << 3,
  afterSwapReturnDelta: 1 << 2,
  afterAddLiquidityReturnDelta: 1 << 1,
  afterRemoveLiquidityReturnDelta: 1 << 0,
} as const;

/// Mask of every permission bit: `Hooks.ALL_HOOK_MASK`.
export const ALL_HOOK_MASK = (1 << 14) - 1;

/// Must match `StratPoolHook.getHookPermissions()`, or `BaseHook` rejects the address.
export const STRAT_POOL_HOOK_FLAGS =
  HOOK_FLAG.beforeInitialize |
  HOOK_FLAG.afterInitialize |
  HOOK_FLAG.beforeSwap |
  HOOK_FLAG.afterSwap |
  HOOK_FLAG.afterSwapReturnDelta;

/// Arachnid's deterministic deployment proxy, already on Robinhood Chain.
export const CREATE2_DEPLOYER: Address =
  '0x4e59b44847b379578588920cA78FbF26c0B4956C';

/// Runtime code of that proxy, for local chains. Calldata is `salt || init code`.
const CREATE2_DEPLOYER_CODE: Hex =
  '0x7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe03601600081602082378035828234f58015156039578182fd5b8082525050506014600cf3';

const create2Address = (
  deployer: Address,
  salt: Hex,
  initCodeHash: Hex,
): Address =>
  getAddress(
    `0x${keccak256(concat(['0xff', deployer, salt, initCodeHash])).slice(26)}`,
  );

/// First salt (from zero) whose CREATE2 address carries exactly `flags`; deterministic.
export function mineHookSalt(params: {
  initCode: Hex;
  flags: number;
  deployer?: Address;
  maxIterations?: number;
}): { salt: Hex; address: Address } {
  const {
    initCode,
    flags,
    deployer = CREATE2_DEPLOYER,
    maxIterations = 500_000,
  } = params;

  const initCodeHash = keccak256(initCode);
  const target = BigInt(flags);

  for (let i = 0; i < maxIterations; i++) {
    const salt = pad(toHex(i), { size: 32 });
    const address = create2Address(deployer, salt, initCodeHash);
    if ((BigInt(address) & BigInt(ALL_HOOK_MASK)) === target) {
      return { salt, address };
    }
  }

  throw new Error(
    `no hook salt found for flags 0x${flags.toString(16)} in ${maxIterations} tries`,
  );
}

/// Installs the proxy on a local chain. Real networks must already have it.
export async function ensureCreate2Deployer(): Promise<void> {
  const publicClient = await hre.viem.getPublicClient();
  const code = await publicClient.getCode({ address: CREATE2_DEPLOYER });
  if (code && code !== '0x') return;

  if (hre.network.name !== 'hardhat' && hre.network.name !== 'localhost') {
    throw new Error(
      `the deterministic deployment proxy ${CREATE2_DEPLOYER} has no code on ${hre.network.name}; ` +
        'deploy it there first (https://github.com/Arachnid/deterministic-deployment-proxy)',
    );
  }

  await hre.network.provider.send('hardhat_setCode', [
    CREATE2_DEPLOYER,
    CREATE2_DEPLOYER_CODE,
  ]);
}

/// Mines and deploys through the proxy. `reused` means the same init code is already deployed there.
export async function deployHook(params: {
  initCode: Hex;
  flags: number;
}): Promise<{ address: Address; salt: Hex; reused: boolean }> {
  const { initCode, flags } = params;
  const [deployer] = await hre.viem.getWalletClients();
  const publicClient = await hre.viem.getPublicClient();

  await ensureCreate2Deployer();

  const { salt, address } = mineHookSalt({ initCode, flags });

  const existing = await publicClient.getCode({ address });
  if (existing && existing !== '0x') {
    return { address, salt, reused: true };
  }

  const hash = await deployer.sendTransaction({
    to: CREATE2_DEPLOYER,
    data: concat([salt, initCode]),
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });

  // The proxy discards the revert reason: the hook rejected these constructor arguments.
  if (receipt.status !== 'success') {
    throw new Error(
      `HookDeploymentReverted: the hook's constructor refused its arguments (transaction ${hash})`,
    );
  }

  const code = await publicClient.getCode({ address });
  if (!code || code === '0x') {
    throw new Error(`hook did not deploy at mined address ${address}`);
  }

  return { address, salt, reused: false };
}
