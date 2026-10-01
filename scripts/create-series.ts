import hre from 'hardhat';
import {
  encodeFunctionData,
  formatUnits,
  parseUnits,
  type Abi,
  type Address,
} from 'viem';
import { z } from 'zod';

import { loadDeployment } from './lib/deployment';
import { revertName } from './lib/errors';
import { waitForSuccess } from './lib/tx';

const DAY = 24n * 60n * 60n;

const envSchema = z.object({
  /// BTC per STRAT, as a decimal.
  SERIES_PRICE: z.string().default('0.0000025'),
  /// cbBTC.
  SERIES_MIN: z.string().default('0.0001'),
  SERIES_CAPACITY: z.string().default('1000000'),
  SERIES_DAYS: z.coerce.number().int().positive().default(30),
  SERIES_VESTING_DAYS: z.coerce.number().int().positive().default(1),
  SERIES_VESTING_SECONDS: z.coerce.number().int().positive().optional(),
});

const wad = (value: bigint) => formatUnits(value, 18);

async function main(): Promise<number> {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    console.error(
      'bad series environment:\n' +
        parsed.error.issues
          .map((issue) => `  ${issue.path.join('.')}: ${issue.message}`)
          .join('\n'),
    );
    return 1;
  }
  const cfg = parsed.data;
  const vestingSeconds = cfg.SERIES_VESTING_SECONDS
    ? BigInt(cfg.SERIES_VESTING_SECONDS)
    : BigInt(cfg.SERIES_VESTING_DAYS) * DAY;

  const deployment = loadDeployment();
  const a = deployment.addresses;

  const [deployer] = await hre.viem.getWalletClients();
  const publicClient = await hre.viem.getPublicClient();
  const me = deployer.account.address;

  const bondingAbi = (await hre.artifacts.readArtifact('Bonding')).abi as Abi;
  const authorityAbi = (await hre.artifacts.readArtifact('ProtocolAuthority'))
    .abi as Abi;
  const errorAbis = [bondingAbi, authorityAbi];

  const bonding = await hre.viem.getContractAt('Bonding', a.bonding as Address);
  const authority = await hre.viem.getContractAt(
    'ProtocolAuthority',
    a.authority as Address,
  );

  const admin = (await authority.read.admin()) as Address;
  if (admin === '0x0000000000000000000000000000000000000000') {
    console.log(
      'Genesis is finalized: the admin is gone and series changes go through a DAO proposal.',
    );
    return 2;
  }

  if (admin.toLowerCase() !== me.toLowerCase()) {
    console.error(
      `only the Genesis admin can open a series: authority.admin() is ${admin}, this wallet is ${me}`,
    );
    return 1;
  }

  const [live, liveId] = await bonding.read.liveSeries();
  if (live) {
    console.log(
      `series ${liveId} is already live; retire it before opening another one`,
    );
    return 2;
  }

  const block = await publicClient.getBlock();
  const args = [
    parseUnits(cfg.SERIES_PRICE, 18),
    0n,
    block.timestamp + BigInt(cfg.SERIES_DAYS) * DAY,
    vestingSeconds,
    parseUnits(cfg.SERIES_CAPACITY, 18),
    parseUnits(cfg.SERIES_MIN, 8),
  ] as const;

  console.log(
    ` opening a series at ${cfg.SERIES_PRICE} cbBTC per STRAT,` +
      ` ${cfg.SERIES_CAPACITY} STRAT capacity, ${cfg.SERIES_DAYS}d window,` +
      ` ${vestingSeconds}s vesting, min ${cfg.SERIES_MIN}`,
  );

  const calldata = encodeFunctionData({
    abi: bondingAbi,
    functionName: 'createSeries',
    args: [...args],
  });

  try {
    await publicClient.simulateContract({
      account: me,
      address: a.authority as Address,
      abi: authorityAbi,
      functionName: 'execute',
      args: [a.bonding as Address, calldata],
    });
  } catch (error) {
    console.error(
      `createSeries would revert: ${revertName(error, errorAbis)}`,
    );
    return 1;
  }

  try {
    await waitForSuccess(
      await authority.write.execute([a.bonding as Address, calldata]),
      'ProtocolAuthority.execute(createSeries)',
    );
  } catch (error) {
    console.error(`createSeries reverted: ${revertName(error, errorAbis)}`);
    return 1;
  }

  const [nowLive, nowId] = await bonding.read.liveSeries();
  const series = await bonding.read.getSeries([nowId]);
  console.log(`\nPASS  series ${nowId} created, live: ${nowLive}`);
  console.log(` price:    ${wad(series.priceBtcPerStrat)} cbBTC per STRAT`);
  console.log(` window:   ${series.startTime} -> ${series.endTime}`);
  console.log(` capacity: ${wad(series.capacityMstrat)} STRAT`);
  console.log(` min:      ${formatUnits(series.minPurchaseBtc, 8)} cbBTC`);
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
