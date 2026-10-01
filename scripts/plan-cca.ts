import hre from 'hardhat';
import { formatUnits, getAddress, type Address } from 'viem';

import { defaultConfig } from './deploy';
import {
  auctionSteps,
  bidGrid,
  blockAt,
  checkAuctionSteps,
  encodeAuctionSteps,
  encodeLpAllocationSchedule,
  encodePositionDefinitions,
  FULL_RANGE_ONLY,
  MPS,
  priceX96,
  satsFromPriceX96,
  secondsIn,
  SECONDS_PER_BLOCK,
  TICKS_PER_FLOOR,
} from './lib/cca-params';
import { loadDeployment } from './lib/deployment';
import { profileConfig } from './lib/profiles';

/**
//  * Converts the CCA config into the launch parameters and checks each against the contract's rules.
//  * Writes nothing; works without a deployment.
//  *   npx hardhat run scripts/plan-cca.ts --network robinhood
//  *   BTC_USD=83000  BIDDING_OPENS=2026-10-15T00:00:00Z
//  * Run it close to registration: the start block projection drifts about an hour over a fortnight.
//  */

const MEASURE_WINDOW = 5_000_000n;

const fmtDuration = (seconds: number): string => {
  const days = seconds / 86_400;
  return days >= 1
    ? `${days.toFixed(2)} days`
    : `${(seconds / 3_600).toFixed(1)} hours`;
};

const fmtTime = (unixSeconds: number): string =>
  new Date(unixSeconds * 1000).toISOString().replace('.000Z', 'Z');

const row = (label: string, value: string) =>
  console.log(`  ${label.padEnd(28)}${value}`);

const parseOpensAt = (text: string | undefined, fallback: bigint): bigint => {
  if (!text) return fallback;
  const ms = Date.parse(text);
  if (Number.isNaN(ms)) {
    throw new Error(`BIDDING_OPENS must be an ISO date such as 2026-10-15T00:00:00Z, got "${text}"`);
  }
  return BigInt(Math.floor(ms / 1000));
};

async function main(): Promise<number> {
  const btcUsd = BigInt(process.env.BTC_USD ?? 83_000);
  const cfg = { ...defaultConfig(), ...profileConfig('prod') };
  const c = cfg.cca;

  let strat: Address | undefined;
  let btc: Address | undefined;
  let treasury: Address | undefined;
  let hook: Address | undefined;
  try {
    const a = loadDeployment().addresses;
    strat = a.strat ? getAddress(a.strat) : undefined;
    btc = a.btc ? getAddress(a.btc) : undefined;
    treasury = a.treasury ? getAddress(a.treasury) : undefined;
    hook = a.poolHook ? getAddress(a.poolHook) : undefined;
  } catch {
    /* no deployment yet */
  }

  const publicClient = await hre.viem.getPublicClient();
  const headBlock = await publicClient.getBlock();
  const head = headBlock.number;
  let secondsPerBlock = SECONDS_PER_BLOCK;
  let measuredOver = 0n;
  if (head > MEASURE_WINDOW) {
    const past = await publicClient.getBlock({ blockNumber: head - MEASURE_WINDOW });
    secondsPerBlock = Number(headBlock.timestamp - past.timestamp) / Number(MEASURE_WINDOW);
    measuredOver = MEASURE_WINDOW;
  }
  const fmtBlocks = (blocks: bigint): string =>
    `${blocks.toLocaleString('en-US')} blocks (~${fmtDuration(secondsIn(blocks, secondsPerBlock))})`;

  console.log(`\n=== the auction ===\n`);
  const opensAt = parseOpensAt(process.env.BIDDING_OPENS, c.biddingOpensAt);
  const startBlock = blockAt(opensAt, head, headBlock.timestamp, secondsPerBlock);
  const durationBlocks = c.durationBlocks;
  const steps = auctionSteps(durationBlocks);
  const endBlock = checkAuctionSteps(steps, startBlock);
  if (endBlock !== startBlock + durationBlocks) {
    throw new Error(`schedule covers ${endBlock - startBlock} blocks, not ${durationBlocks}`);
  }
  // Claimable at close; migration needs the next block.
  const claimBlock = endBlock;
  const migrationBlock = endBlock + 1n;

  const closesAt = Number(opensAt) + secondsIn(durationBlocks, secondsPerBlock);
  row('head', `${head.toLocaleString('en-US')} at ${fmtTime(Number(headBlock.timestamp))}`);
  row(
    'block time',
    measuredOver > 0n
      ? `${secondsPerBlock.toFixed(5)} s, measured over the last ${measuredOver.toLocaleString('en-US')} blocks`
      : `${secondsPerBlock} s (configured; not enough history here to measure)`,
  );
  row('startBlock', `${startBlock.toLocaleString('en-US')}  (bidding opens ~${fmtTime(Number(opensAt))})`);
  row('endBlock', `${endBlock.toLocaleString('en-US')}  (${fmtBlocks(durationBlocks)} of bidding, closes ~${fmtTime(Math.round(closesAt))})`);
  row('claimBlock', `${claimBlock.toLocaleString('en-US')}`);
  row('migrationBlock', `${migrationBlock.toLocaleString('en-US')}`);

  console.log(`\n=== the issuance schedule ===\n`);
  for (const [i, step] of steps.entries()) {
    const share = Number((step.mps * step.blocks * 10_000n) / MPS) / 100;
    row(
      `step ${i + 1}`,
      `${step.mps} mps a block for ${step.blocks.toLocaleString('en-US')} blocks` +
        `  — ${share.toFixed(2)}% of supply over ${fmtDuration(secondsIn(step.blocks, secondsPerBlock))}`,
    );
  }
  row('auctionStepsData', encodeAuctionSteps(steps));

  console.log(`\n=== prices ===\n`);
  // The floor must sit on the bid grid; `bidGrid` derives both and checks the auction minimums.
  const announced = priceX96(c.floorBtc1e8);
  const { floorPrice: floor, tickSpacing: bidTickSpacing } = bidGrid(c.floorBtc1e8);
  const onePip = floor / 10_000n;
  row('floor', `${c.floorBtc1e8} sat a STRAT`);
  row('floorPrice (Q96)', `${floor}  — on the grid; announced ${announced}, lifted by ${floor - announced}`);
  row('tickSpacing (Q96)', `${bidTickSpacing}  — a ${TICKS_PER_FLOOR}th of the floor, ${(Number(bidTickSpacing * 10_000n / onePip) / 10_000).toFixed(1)} bps`);
  row('floor % tickSpacing', `${floor % bidTickSpacing}  — must be 0 or the constructor reverts`);
  row('requiredCurrencyRaised', `${c.minGraduationBtc1e8}  — ${formatUnits(c.minGraduationBtc1e8, 8)} cbBTC`);
  console.log(
    `\n  Read back: floorPrice is ${satsFromPriceX96(floor)} sat a STRAT, and the whole auction\n` +
      `  supply at that price raises ${formatUnits((c.supplyStrat / 10n ** 18n) * c.floorBtc1e8, 8)} cbBTC, which is the threshold.`,
  );

  console.log(`\n=== supply ===\n`);
  const total = c.supplyStrat + c.lpReserveStrat;
  row('deposited to launcher', `${formatUnits(total, 18)} STRAT`);
  row('reservedTokenAmountForLP', `${c.lpReserveStrat}  — ${formatUnits(c.lpReserveStrat, 18)} STRAT`);
  row('offered in the auction', `${formatUnits(c.supplyStrat, 18)} STRAT  (the remainder)`);

  console.log(`\n=== the LP funding schedule ===\n`);
  const brackets = [{ lowerThreshold: 0n, rate: c.lpBudgetMps }];
  row('lpAllocationSchedule', encodeLpAllocationSchedule(brackets));
  row('', `one bracket from 0, ${Number(c.lpBudgetMps * 100n / MPS)}% of the raise`);
  console.log(
    `\n  A ceiling, not a spend. The migration mints one full-range position, and a full-range\n` +
      `  position at price P takes exactly ${formatUnits(c.lpReserveStrat, 18)} STRAT against ${formatUnits(c.lpReserveStrat, 18)} x P of cbBTC.\n` +
      `  Whatever the budget leaves over goes to \`recipient\` in the same transaction, so the pool is\n` +
      `  funded at the discovered price with no figure hardcoded. Worked through at three prices:\n`,
  );
  const sold = c.supplyStrat / 10n ** 18n;
  const reserve = c.lpReserveStrat / 10n ** 18n;
  for (const price of [c.floorBtc1e8, c.floorBtc1e8 * 2n, c.floorBtc1e8 * 4n]) {
    const raised = sold * price;
    const forLp = reserve * price;
    console.log(
      `    ${String(price).padStart(4)} sat   raise ${formatUnits(raised, 8).padStart(8)} cbBTC` +
        `   LP takes ${formatUnits(forLp, 8).padStart(7)}` +
        `   to recipient ${formatUnits(raised - forLp, 8).padStart(8)}` +
        `   (LP is ${((Number(forLp) / Number(raised)) * 100).toFixed(1)}%)`,
    );
  }

  console.log(`\n=== the position plan ===\n`);
  row('positionDefinitions', encodePositionDefinitions(FULL_RANGE_ONLY));
  row('', 'empty: one full-range position for the whole budget');

  console.log(`\n=== the pool the auction migrates into ===\n`);
  row('poolParameters.fee', `${cfg.feeStratBtc}  — ${cfg.feeStratBtc / 10_000}% LP fee`);
  row('poolParameters.tickSpacing', `${cfg.tickSpacingStratBtc}`);
  row('poolParameters.hook', hook ?? 'StratPoolHook, from the deployment');
  row('currency', btc ?? 'cbBTC');
  row('token', strat ?? 'STRAT, from the deployment');

  console.log(`\n=== recipients ===\n`);
  const devBtc = (c.devRecoveryUsd * 10n ** 8n) / btcUsd;
  row('fundsRecipient', 'the LBPStrategy — required, it sweeps the raise itself');
  row('tokensRecipient', treasury ?? 'Treasury — unsold auction STRAT, outside activated supply');
  row('positionRecipient', 'to decide: holds the Genesis LP NFT');
  row('recipient', 'to decide: takes the raise net of the LP');
  console.log(
    `\n  \`recipient\` is the one address the raise lands on, and the split the client asked for has\n` +
      `  two parts: $${c.devRecoveryUsd.toLocaleString('en-US')} of cost recovery, then the rest to the Treasury. At $${btcUsd.toLocaleString('en-US')} a coin\n` +
      `  that first part is ${formatUnits(devBtc, 8)} cbBTC. Nothing in the launcher splits one address into two, so\n` +
      `  either \`recipient\` is the Genesis admin and the split is two transfers it makes, or it is a\n` +
      `  splitter contract written for the purpose. The admin is one less contract to trust.`,
  );

  console.log();
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error(`\n${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
