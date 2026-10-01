import hre from 'hardhat';
import {
  encodeAbiParameters,
  encodeFunctionData,
  encodePacked,
  formatUnits,
  getAddress,
  parseAbi,
  type Address,
  type Hex,
} from 'viem';

import { deploymentFile, loadDeployment } from './lib/deployment';
import {
  canonicalV4,
  V4_ACTION_LAYOUT,
  V4_ACTIONS,
  V4_SWAP_COMMAND,
  type V4ActionLayout,
} from './lib/v4-canonical';
import { POOL_KEY_COMPONENTS, type PoolKey } from './lib/v4-keys';

/**
//  * Finds which v4 action layout the deployed router decodes, using `eth_call` only.
//  *   npx hardhat run scripts/check-swap-venue.ts --network robinhoodTestnet
//  */

const QUOTER_ABI = [
  {
    type: 'function',
    name: 'quoteExactInputSingle',
    stateMutability: 'nonpayable',
    inputs: [
      {
        name: 'params',
        type: 'tuple',
        components: [
          { name: 'poolKey', type: 'tuple', components: POOL_KEY_COMPONENTS },
          { name: 'zeroForOne', type: 'bool' },
          { name: 'exactAmount', type: 'uint128' },
          { name: 'hookData', type: 'bytes' },
        ],
      },
    ],
    outputs: [
      { name: 'amountOut', type: 'uint256' },
      { name: 'gasEstimate', type: 'uint256' },
    ],
  },
] as const;

const UR_ABI = parseAbi([
  'function execute(bytes commands, bytes[] inputs, uint256 deadline) payable',
]);

const STATE_VIEW_ABI = parseAbi([
  'function getLiquidity(bytes32 poolId) view returns (uint128)',
  'function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)',
]);

const KNOWN_ERRORS: Record<string, string> = {
  '0x8b063d73': 'V4TooLittleReceived',
  '0x5bf6f916': 'TransactionDeadlinePassed',
  '0xd76a1e9e': 'InvalidCommandType',
  '0x2c4029e9': 'ExecutionFailed',
  '0xf96fb071': 'InsufficientAllowance',
  '0xd81b2f2e': 'AllowanceExpired',
  // Seen once the action decodes but the probe address holds nothing.
  '0x675cae38': 'InsufficientToken',
};

const withPriceLimit = [
  {
    type: 'tuple',
    components: [
      { name: 'poolKey', type: 'tuple', components: POOL_KEY_COMPONENTS },
      { name: 'zeroForOne', type: 'bool' },
      { name: 'amountIn', type: 'uint128' },
      { name: 'amountOutMinimum', type: 'uint128' },
      { name: 'sqrtPriceLimitX96', type: 'uint160' },
      { name: 'hookData', type: 'bytes' },
    ],
  },
] as const;

const withoutPriceLimit = [
  {
    type: 'tuple',
    components: [
      { name: 'poolKey', type: 'tuple', components: POOL_KEY_COMPONENTS },
      { name: 'zeroForOne', type: 'bool' },
      { name: 'amountIn', type: 'uint128' },
      { name: 'amountOutMinimum', type: 'uint128' },
      { name: 'hookData', type: 'bytes' },
    ],
  },
] as const;

const CURRENCY_AND_AMOUNT = [{ type: 'address' }, { type: 'uint256' }] as const;

const swapCalldata = (params: {
  layout: V4ActionLayout;
  key: PoolKey;
  zeroForOne: boolean;
  amountIn: bigint;
  amountOutMinimum: bigint;
  currencyIn: Address;
  currencyOut: Address;
  deadline: bigint;
}): Hex => {
  const { layout, key, zeroForOne, amountIn, amountOutMinimum } = params;

  const swap =
    layout === 'with-price-limit'
      ? encodeAbiParameters(withPriceLimit, [
          {
            poolKey: key,
            zeroForOne,
            amountIn,
            amountOutMinimum,
            // Zero is the router's widest bound; `amountOutMinimum` is the guarantee.
            sqrtPriceLimitX96: 0n,
            hookData: '0x',
          },
        ])
      : encodeAbiParameters(withoutPriceLimit, [
          { poolKey: key, zeroForOne, amountIn, amountOutMinimum, hookData: '0x' },
        ]);

  const actions = encodePacked(
    ['uint8', 'uint8', 'uint8'],
    [V4_ACTIONS.swapExactInSingle, V4_ACTIONS.settleAll, V4_ACTIONS.takeAll],
  );
  const actionParams = [
    swap,
    encodeAbiParameters(CURRENCY_AND_AMOUNT, [params.currencyIn, amountIn]),
    encodeAbiParameters(CURRENCY_AND_AMOUNT, [params.currencyOut, amountOutMinimum]),
  ];

  return encodeFunctionData({
    abi: UR_ABI,
    functionName: 'execute',
    args: [
      encodePacked(['uint8'], [V4_SWAP_COMMAND]),
      [encodeAbiParameters([{ type: 'bytes' }, { type: 'bytes[]' }], [actions, actionParams])],
      params.deadline,
    ],
  });
};

/// Raw `eth_call`, to see the exact revert data, including the empty revert of a mis-encoded action.
async function rawCall(
  rpcUrl: string,
  call: { from: Address; to: Address; data: Hex },
): Promise<{ ok: boolean; data: string }> {
  const response = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'eth_call',
      params: [{ ...call, gas: '0x989680' }, 'latest'],
    }),
  });
  const body = (await response.json()) as {
    result?: string;
    error?: { message: string; data?: string };
  };
  if (body.error) return { ok: false, data: body.error.data ?? '0x' };
  return { ok: true, data: body.result ?? '0x' };
}

const describe = (data: string) =>
  data === '0x' || data === ''
    ? 'empty revert (the router could not decode the action)'
    : `${KNOWN_ERRORS[data.slice(0, 10)] ?? 'unknown error'} ${data.slice(0, 10)}`;

let failures = 0;
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
};

async function main() {
  const publicClient = await hre.viem.getPublicClient();
  const chainId = await publicClient.getChainId();
  const rpcUrl = (hre.network.config as { url?: string }).url;
  if (!rpcUrl) throw new Error('this check needs an http network');

  const canonical = canonicalV4(chainId);
  if (!canonical) {
    throw new Error(
      `no canonical Uniswap addresses recorded for chain ${chainId}. Add them to scripts/lib/v4-canonical.ts from https://developers.uniswap.org/contracts/v4/deployments`,
    );
  }

  const deployment = loadDeployment();
  const pool = deployment.pools?.btcUsdg;
  if (!pool) {
    throw new Error(
      `${deploymentFile()} has no pools.btcUsdg — run scripts/deploy-usdg-pool.ts first`,
    );
  }

  const key: PoolKey = {
    currency0: getAddress(pool.currency0),
    currency1: getAddress(pool.currency1),
    fee: pool.fee,
    tickSpacing: pool.tickSpacing,
    hooks: getAddress(pool.hooks),
  };
  const btc = getAddress(deployment.addresses.btc);
  const usdg = getAddress(deployment.addresses.usdg);
  const zeroForOne = getAddress(key.currency0) === usdg;

  console.log(`\nChain ${chainId}, pool ${pool.id}\n`);

  console.log('Canonical Uniswap contracts');
  for (const [name, address] of Object.entries(canonical)) {
    const code = await publicClient.getCode({ address: address as Address });
    check(`${name} at ${address}`, !!code && code !== '0x');
  }

  console.log('\nThe pool');
  const [sqrtPriceX96] = await publicClient.readContract({
    address: canonical.stateView,
    abi: STATE_VIEW_ABI,
    functionName: 'getSlot0',
    args: [pool.id as Hex],
  });
  const liquidity = await publicClient.readContract({
    address: canonical.stateView,
    abi: STATE_VIEW_ABI,
    functionName: 'getLiquidity',
    args: [pool.id as Hex],
  });
  check('initialized', sqrtPriceX96 > 0n);
  check('has liquidity', liquidity > 0n, `L = ${liquidity}`);

  const amountIn = 1_000n * 10n ** 6n;
  const { result: quoted } = await publicClient.simulateContract({
    address: canonical.quoter,
    abi: QUOTER_ABI,
    functionName: 'quoteExactInputSingle',
    args: [{ poolKey: key, zeroForOne, exactAmount: amountIn, hookData: '0x' }],
  });
  check(
    'the canonical quoter prices a swap',
    quoted[0] > 0n,
    `1000 USDG -> ${formatUnits(quoted[0], 8)} cbBTC`,
  );

  console.log('\nWhich action layout this router accepts');
  const probe = '0x000000000000000000000000000000000000dEaD' as Address;
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);

  const accepted: V4ActionLayout[] = [];
  for (const layout of ['with-price-limit', 'without-price-limit'] as const) {
    const { ok, data } = await rawCall(rpcUrl, {
      from: probe,
      to: canonical.universalRouter,
      data: swapCalldata({
        layout,
        key,
        zeroForOne,
        amountIn,
        amountOutMinimum: 1n,
        currencyIn: usdg,
        currencyOut: btc,
        deadline,
      }),
    });
    // A decodable error means the encoding was understood; an empty revert means it was not.
    const understood = ok || data !== '0x';
    console.log(`  ${layout.padEnd(21)} ${ok ? 'accepted' : describe(data)}`);
    if (understood) accepted.push(layout);
  }

  check('exactly one layout is understood', accepted.length === 1, accepted.join(', ') || 'none');

  const configured = V4_ACTION_LAYOUT[chainId];
  check(
    `the configured layout matches (${configured ?? 'not set'})`,
    accepted.length === 1 && configured === accepted[0],
    accepted.length === 1 && configured !== accepted[0]
      ? `set V4_ACTION_LAYOUT[${chainId}] = '${accepted[0]}' in scripts/lib/v4-canonical.ts and mirror it in the app's lib/swap/config.ts`
      : '',
  );

  if (accepted.length === 1) {
    const layout = accepted[0];

    console.log('\nThe promises the router is supposed to keep');
    const impossible = await rawCall(rpcUrl, {
      from: probe,
      to: canonical.universalRouter,
      data: swapCalldata({
        layout,
        key,
        zeroForOne,
        amountIn,
        amountOutMinimum: quoted[0] * 2n,
        currencyIn: usdg,
        currencyOut: btc,
        deadline,
      }),
    });
    check(
      'a minimum the pool cannot meet is refused',
      impossible.data.startsWith('0x8b063d73'),
      describe(impossible.data),
    );

    const expired = await rawCall(rpcUrl, {
      from: probe,
      to: canonical.universalRouter,
      data: swapCalldata({
        layout,
        key,
        zeroForOne,
        amountIn,
        amountOutMinimum: 1n,
        currencyIn: usdg,
        currencyOut: btc,
        deadline: BigInt(Math.floor(Date.now() / 1000) - 600),
      }),
    });
    check(
      'a passed deadline is refused',
      expired.data.startsWith('0x5bf6f916'),
      describe(expired.data),
    );
  }

  console.log(
    failures === 0
      ? '\nThe swap route holds on this chain.\n'
      : `\n${failures} check(s) failed. Do not point the app at this chain yet.\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
