import { existsSync, readFileSync } from 'node:fs';

import hre from 'hardhat';
import { createPublicClient, formatUnits, getAddress, http } from 'viem';
import { type Address } from 'viem';

import { DeployLedger, type LedgerFile } from './lib/deploy-ledger';
import {
  argsFile,
  deploymentFile,
  deploymentName,
  loadDeployment,
  writeJson,
  type PoolRecord,
} from './lib/deployment';
import {
  addLiquidity,
  deployV4Quoter,
  fullRange,
  fullRangeLiquidity,
  MAX_SQRT_PRICE,
  MIN_SQRT_PRICE,
  STATE_VIEW_ABI,
  SWAP_ROUTER_ABI,
  V4_QUOTER_ABI,
} from './lib/uniswap-v4-local';
import { waitForSuccess } from './lib/tx';
import { canonicalV4 } from './lib/v4-canonical';
import {
  buildPoolKey,
  isPoolInitialized,
  poolId,
  POOL_MANAGER_ABI,
  type PoolKey,
} from './lib/v4-keys';

/**
//  * Opens a hookless cbBTC/USDG v4 pool for stablecoin bonding routes. Safe to re-run.
//  *   npx hardhat run scripts/deploy-usdg-pool.ts --network robinhoodTestnet
//  * Optional env: USDG, UNISWAP_V4_QUOTER, USDG_PER_BTC, USDG_POOL_BTC (default 200),
//  * PRICE_FEED_RPC_URL, USDG_POOL_TOPUP, SMOKE_SWAP.
//  */

/// Part of the pool key: changing either names a different pool.
const POOL_FEE = 500;
const POOL_TICK_SPACING = 10;
const POOL_HOOKS = '0x0000000000000000000000000000000000000000' as const;

/// The same feed the app shows dollars with.
const BTC_USD_FEED = '0xF4030086522a5bEEa4988F8cA5B36dbC97BeE88c' as const;
const BTC_USD_FEED_RPC = 'https://ethereum-rpc.publicnode.com';
/// Three Chainlink heartbeats.
const MAX_FEED_AGE_SECONDS = 3 * 60 * 60;

const CHAINLINK_ABI = [
  {
    type: 'function',
    name: 'latestRoundData',
    stateMutability: 'view',
    inputs: [],
    outputs: [
      { name: 'roundId', type: 'uint80' },
      { name: 'answer', type: 'int256' },
      { name: 'startedAt', type: 'uint256' },
      { name: 'updatedAt', type: 'uint256' },
      { name: 'answeredInRound', type: 'uint80' },
    ],
  },
] as const;

/// Default depth in whole cbBTC, deep enough that test swaps show realistic price impact.
const DEFAULT_DEPTH_BTC = '200';

const USDG_DECIMALS = 6;
const BTC_DECIMALS = 8;

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

/// `sqrt(amount1 / amount0) * 2^96` from the seed amounts, so both sides deposit in full.
const sqrtPriceX96From = (amount0: bigint, amount1: bigint): bigint =>
  isqrt((amount1 << 192n) / amount0);

const envValue = (name: string): string | undefined => {
  const raw = process.env[name];
  return raw && raw.trim() !== '' ? raw.trim() : undefined;
};

async function usdPerBtc1e8(): Promise<{ price: bigint; source: string }> {
  const override = envValue('USDG_PER_BTC');
  if (override) {
    const parsed = Number(override);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      throw new Error(
        `USDG_PER_BTC must be a positive number, got "${override}"`,
      );
    }
    return {
      price: BigInt(Math.round(parsed * 1e8)),
      source: `USDG_PER_BTC=${override}`,
    };
  }

  const client = createPublicClient({
    transport: http(envValue('PRICE_FEED_RPC_URL') ?? BTC_USD_FEED_RPC),
  });

  const [, answer, , updatedAt] = await client.readContract({
    address: BTC_USD_FEED,
    abi: CHAINLINK_ABI,
    functionName: 'latestRoundData',
  });

  if (answer <= 0n)
    throw new Error('Chainlink BTC/USD returned a non-positive answer');

  const age = Math.floor(Date.now() / 1000) - Number(updatedAt);
  if (age > MAX_FEED_AGE_SECONDS) {
    throw new Error(
      `Chainlink BTC/USD is ${Math.round(age / 3600)}h stale. Pass USDG_PER_BTC to open the pool anyway.`,
    );
  }

  return { price: answer, source: `Chainlink BTC/USD (${age}s old)` };
}

/// Appends to the args file so `deploy.ts` entries are kept.
function mergeArgsFile(ledger: DeployLedger, deployment: string): string {
  const file = argsFile(deployment);
  const fresh = ledger.serialize(deployment);
  if (!existsSync(file)) return writeJson(file, fresh);

  const existing = JSON.parse(readFileSync(file, 'utf8')) as LedgerFile;
  return writeJson(file, {
    ...existing,
    entries: { ...existing.entries, ...fresh.entries },
  });
}

export async function deployUsdgPool() {
  const [deployer] = await hre.viem.getWalletClients();
  const publicClient = await hre.viem.getPublicClient();
  const me = deployer.account.address;

  const deployment = loadDeployment();
  const a = deployment.addresses;

  const need = (key: string): Address => {
    const value = a[key];
    if (!value) throw new Error(`${deploymentFile()} is missing "${key}"`);
    return getAddress(value);
  };

  const poolManager = need('poolManager');
  const liquidityRouter = need('liquidityRouter');
  const stateView = need('stateView');
  const swapRouter = need('swapRouter');
  const btc = need('btc');

  const ledger = new DeployLedger();

  console.log(`\n Deployer: ${me}`);
  console.log(` Pool manager: ${poolManager}`);

  const configuredUsdg = envValue('USDG') ?? a.usdg;
  let usdg: Address;
  let usdgIsMock = false;

  if (configuredUsdg) {
    usdg = getAddress(configuredUsdg);
    usdgIsMock = deployment.mocks && !envValue('USDG');
    console.log(`\n USDG: ${usdg} (already deployed)`);
  } else {
    if (!deployment.mocks) {
      throw new Error(
        'This deployment is not a mock deployment, so USDG must be an existing token. Set USDG=0x...',
      );
    }
    console.log('\n Deploying the mock USDG...');
    const token = await hre.viem.deployContract('MockERC20Decimals', [
      'Mock Global Dollar',
      'mUSDG',
      USDG_DECIMALS,
    ]);
    usdg = getAddress(token.address);
    usdgIsMock = true;
    await ledger.record('USDG', usdg, 'MockERC20Decimals', [
      'Mock Global Dollar',
      'mUSDG',
      USDG_DECIMALS,
    ]);
    console.log(` USDG: ${usdg}`);
  }

  const usdgDecimals = Number(
    await publicClient.readContract({
      address: usdg,
      abi: [
        {
          type: 'function',
          name: 'decimals',
          stateMutability: 'view',
          inputs: [],
          outputs: [{ type: 'uint8' }],
        },
      ] as const,
      functionName: 'decimals',
    }),
  );
  if (usdgDecimals !== USDG_DECIMALS) {
    throw new Error(
      `USDG at ${usdg} reports ${usdgDecimals} decimals; this script prices the pool for ${USDG_DECIMALS}`,
    );
  }

  // Use Uniswap's canonical stack where it exists; deploy a quoter only where it does not.
  const chainId = await publicClient.getChainId();
  const canonical = canonicalV4(chainId);

  const configuredQuoter =
    envValue('UNISWAP_V4_QUOTER') ?? canonical?.quoter ?? a.v4Quoter;
  let quoter: Address;
  if (configuredQuoter) {
    quoter = getAddress(configuredQuoter);
    console.log(
      ` Quoter: ${quoter}${canonical ? ' (canonical)' : ' (already deployed)'}`,
    );
  } else {
    console.log('\n No canonical quoter on this chain; deploying V4Quoter...');
    quoter = getAddress(await deployV4Quoter(poolManager));
    ledger.recordExternal(quoter, 'V4Quoter', {
      verify: false,
      note: 'Uniswap v4-periphery, deployed from the published artifact',
    });
    console.log(` Quoter: ${quoter}`);
  }

  if (canonical) {
    console.log(
      ` Router: ${canonical.universalRouter} (canonical UniversalRouter)`,
    );
    console.log(` Permit2: ${canonical.permit2}`);
  } else {
    console.log(
      '\n  No canonical UniversalRouter on this chain. The app has no router it can ask a\n' +
        '  user to approve — see scripts/lib/v4-canonical.ts.',
    );
  }

  const key: PoolKey = buildPoolKey({
    tokenA: btc,
    tokenB: usdg,
    fee: POOL_FEE,
    tickSpacing: POOL_TICK_SPACING,
    hooks: POOL_HOOKS,
  });
  const id = poolId(key);
  const btcIsCurrency0 = getAddress(key.currency0) === btc;

  const { price, source } = await usdPerBtc1e8();
  console.log(
    `\n Opening price: ${formatUnits(price, 8)} USDG per cbBTC — ${source}`,
  );

  const depthBtc = envValue('USDG_POOL_BTC') ?? DEFAULT_DEPTH_BTC;
  const btcAmount = BigInt(Math.round(Number(depthBtc) * 10 ** BTC_DECIMALS));
  // Raw USDG per raw satoshi: price * 1e6 / 1e16.
  const usdgAmount = (btcAmount * price) / 10n ** 10n;
  if (btcAmount <= 0n || usdgAmount <= 0n) {
    throw new Error('USDG_POOL_BTC must be large enough to price both sides');
  }

  const amount0 = btcIsCurrency0 ? btcAmount : usdgAmount;
  const amount1 = btcIsCurrency0 ? usdgAmount : btcAmount;

  console.log(
    ` Depth: ${formatUnits(btcAmount, BTC_DECIMALS)} cbBTC + ${formatUnits(usdgAmount, USDG_DECIMALS)} USDG`,
  );
  console.log(` Pool id: ${id}`);

  if (await isPoolInitialized(publicClient, poolManager, key)) {
    console.log('  pool already initialized, skipped');
  } else {
    const sqrtPriceX96 = sqrtPriceX96From(amount0, amount1);
    console.log(`\n Initializing the pool at sqrtPriceX96 ${sqrtPriceX96}...`);
    const hash = await deployer.writeContract({
      address: poolManager,
      abi: POOL_MANAGER_ABI,
      functionName: 'initialize',
      args: [key, sqrtPriceX96],
    });
    await waitForSuccess(hash, 'PoolManager.initialize(cbBTC/USDG)');
    console.log('  initialized');
  }

  const readLiquidity = async (): Promise<bigint> =>
    (await publicClient.readContract({
      address: stateView,
      abi: STATE_VIEW_ABI,
      functionName: 'getLiquidity',
      args: [id],
    })) as bigint;
  const liquidity = await readLiquidity();

  /// Adds one full-range position, minting funds on a mock chain.
  const addDepth = async (add0: bigint, add1: bigint) => {
    if (usdgIsMock) {
      console.log(' Minting the mocks...');
      // Twice the estimate: a full-range position can draw slightly more of one side.
      for (const [token, amount] of [
        [key.currency0, add0 * 2n],
        [key.currency1, add1 * 2n],
      ] as const) {
        const mock = await hre.viem.getContractAt('MockERC20Decimals', token);
        await waitForSuccess(await mock.write.mint([me, amount]), 'mock mint');
      }
    } else {
      for (const [token, amount] of [
        [key.currency0, add0],
        [key.currency1, add1],
      ] as const) {
        const erc20 = await hre.viem.getContractAt('MockERC20Decimals', token);
        const held = await erc20.read.balanceOf([me]);
        if (held < amount) {
          const symbol = await erc20.read.symbol();
          throw new Error(
            `Seeding needs ${amount} of ${symbol} (raw) and ${me} holds ${held}`,
          );
        }
      }
    }

    console.log(' Adding full-range liquidity...');
    const range = fullRange(POOL_TICK_SPACING);
    const before = await readLiquidity();
    await addLiquidity({
      liquidityRouter,
      key,
      tickLower: range.tickLower,
      tickUpper: range.tickUpper,
      liquidityDelta: fullRangeLiquidity(add0, add1),
    });
    if ((await readLiquidity()) <= before) {
      throw new Error('cbBTC/USDG: modifyLiquidity did not add liquidity');
    }
  };

  const topUpBtc = envValue('USDG_POOL_TOPUP');

  if (liquidity === 0n) {
    await addDepth(amount0, amount1);
    console.log('  seeded');
  } else if (topUpBtc) {
    // A trading pool has its own price, and the deposit must match it.
    const [sqrtPriceX96] = (await publicClient.readContract({
      address: stateView,
      abi: STATE_VIEW_ABI,
      functionName: 'getSlot0',
      args: [id],
    })) as [bigint, number, number, number];

    const addBtc = BigInt(Math.round(Number(topUpBtc) * 10 ** BTC_DECIMALS));
    const priceNum = sqrtPriceX96 * sqrtPriceX96;
    const priceDen = 1n << 192n;

    const [add0, add1] = btcIsCurrency0
      ? [addBtc, (addBtc * priceNum) / priceDen]
      : [(addBtc * priceDen) / priceNum, addBtc];

    console.log(
      `\n Topping the pool up by ${formatUnits(addBtc, BTC_DECIMALS)} cbBTC at its own price...`,
    );
    await addDepth(add0, add1);
    console.log('  added');
  } else {
    console.log(
      `\n Pool already holds liquidity (L = ${liquidity}), nothing to add.`,
    );
    console.log('  set USDG_POOL_TOPUP=<cbBTC> to deepen it.');
  }

  const [sqrtPriceX96Now, tick] = (await publicClient.readContract({
    address: stateView,
    abi: STATE_VIEW_ABI,
    functionName: 'getSlot0',
    args: [id],
  })) as [bigint, number, number, number];

  const oneBtc = 10n ** BigInt(BTC_DECIMALS);
  const { result: quoted } = (await publicClient.simulateContract({
    address: quoter,
    abi: V4_QUOTER_ABI,
    functionName: 'quoteExactInputSingle',
    args: [
      {
        poolKey: key,
        zeroForOne: btcIsCurrency0,
        exactAmount: oneBtc,
        hookData: '0x',
      },
    ],
    account: me,
  })) as { result: [bigint, bigint] };

  console.log(`\n Pool state: sqrtPriceX96 ${sqrtPriceX96Now}, tick ${tick}`);
  console.log(
    ` Quote: 1 cbBTC sells for ${formatUnits(quoted[0], USDG_DECIMALS)} USDG (fee and impact included)`,
  );

  const smoke = envValue('SMOKE_SWAP');
  if (smoke) {
    const amountIn = BigInt(Math.round(Number(smoke) * 10 ** USDG_DECIMALS));
    console.log(
      `\n Live check: swapping ${smoke} USDG for cbBTC through the app's router...`,
    );

    const usdgToken = await hre.viem.getContractAt('MockERC20Decimals', usdg);
    const btcToken = await hre.viem.getContractAt('MockERC20Decimals', btc);

    if (usdgIsMock) {
      await waitForSuccess(await usdgToken.write.mint([me, amountIn]), 'USDG mint');
    }

    await waitForSuccess(
      await usdgToken.write.approve([swapRouter, amountIn]),
      'USDG approve',
    );

    const before = await btcToken.read.balanceOf([me]);
    const zeroForOne = !btcIsCurrency0;
    const swapHash = await deployer.writeContract({
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
    });
    await waitForSuccess(swapHash, 'PoolSwapTest.swap(USDG -> cbBTC)');
    const after = await btcToken.read.balanceOf([me]);

    console.log(
      `  received ${formatUnits(after - before, BTC_DECIMALS)} cbBTC in ${swapHash}`,
    );
  }

  const pool: PoolRecord = {
    id,
    currency0: getAddress(key.currency0),
    currency1: getAddress(key.currency1),
    fee: key.fee,
    tickSpacing: key.tickSpacing,
    hooks: getAddress(key.hooks),
  };

  const updated = {
    ...deployment,
    addresses: {
      ...deployment.addresses,
      usdg,
      v4Quoter: quoter,
      ...(canonical
        ? {
            universalRouter: canonical.universalRouter,
            permit2: canonical.permit2,
            canonicalStateView: canonical.stateView,
          }
        : {}),
    },
    pools: { ...(deployment.pools ?? {}), btcUsdg: pool },
  };

  const written = writeJson(deploymentFile(), updated);
  console.log(`\n ${written} updated`);

  if (Object.keys(ledger.entries).length > 0) {
    console.log(` ${mergeArgsFile(ledger, deploymentName())} updated`);
  }

  console.log('\n For the app (src/lib/addresses.ts and lib/swap/config.ts):');
  console.log(`   USDG:    '${usdg.toLowerCase()}',`);
  console.log(`   pool id: '${id}'`);
  console.log(
    '\n Then prove the route on this chain before pointing anyone at it:\n' +
      `   npx hardhat run scripts/check-swap-venue.ts --network ${hre.network.name}`,
  );
}

if (require.main === module)
  deployUsdgPool()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
