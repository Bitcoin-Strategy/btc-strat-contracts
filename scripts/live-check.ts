/**
//  * Real-chain checks: waits for the TWAP, then bonds on a plain `eth_estimateGas` limit and reports
//  * whether the liquidity leg landed.
//  *   npx hardhat run scripts/live-check.ts --network robinhoodTestnet
//  */
import hre from 'hardhat';
import { type Address } from 'viem';

import { loadDeployment } from './lib/deployment';
import { waitForSuccess } from './lib/tx';

const WAD = 10n ** 18n;
const BTC = 10n ** 8n;
const BPS = 10_000n;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const d = loadDeployment();
  const a = d.addresses as Record<string, Address>;
  const [signer] = await hre.viem.getWalletClients();
  const publicClient = await hre.viem.getPublicClient();

  const oracle = await hre.viem.getContractAt('ProtocolOracle', a.protocolOracle);
  const bonding = await hre.viem.getContractAt('Bonding', a.bonding);
  const treasury = await hre.viem.getContractAt('Treasury', a.treasury);
  const btc = await hre.viem.getContractAt('MockERC20Decimals', a.btc);
  const vvest = await hre.viem.getContractAt('VVEST', a.vvest);
  const liq = await hre.viem.getContractAt(
    'UniV4LiquidityAdapter',
    a.liquidityAdapter,
  );

  const [live, seriesId] = await bonding.read.liveSeries();
  if (!live) {
    console.log('FAIL  no live bond series; create one first (npm run series:create:*)');
    process.exitCode = 1;
    return;
  }

  console.log('waiting for the TWAP to fill its window...');
  let price = 0n;
  for (let i = 0; i < 90; i += 1) {
    try {
      price = (await oracle.read.getPriceWad([a.strat, a.btc])) as bigint;
      if (price > 0n) break;
    } catch {
      /* not enough history yet */
    }
    await sleep(60_000);
    if (i % 5 === 0) console.log(`  still waiting (${i} min)`);
  }
  if (price === 0n) {
    console.log('FAIL  the oracle never became ready');
    process.exitCode = 1;
    return;
  }
  console.log('ok    the TWAP answers:', price.toString(), 'wei BTC per STRAT');

  // The leg swaps half of 6% of this.
  const amountIn = BTC / 50n;
  // Mined before the estimate reads `latest`, or it sees no allowance.
  if (d.mocks) {
    await waitForSuccess(
      await btc.write.mint([signer.account.address, amountIn]),
      'cbBTC mint',
    );
  } else if (((await btc.read.balanceOf([signer.account.address])) as bigint) < amountIn) {
    console.log(`FAIL  not enough cbBTC for a ${amountIn} sat bond (no mocks in this deployment)`);
    process.exitCode = 1;
    return;
  }
  await waitForSuccess(await btc.write.approve([a.bonding, amountIn]), 'cbBTC approve');

  const quoted = (await bonding.read.preview([seriesId, amountIn])) as bigint;
  const treasuryBps = (await bonding.read.treasuryBps()) as bigint;
  const treasuryBefore = (await treasury.read.btcBalance()) as bigint;
  const liqBefore = (await liq.read.positionLiquidity()) as bigint;

  const estimate = await publicClient.estimateContractGas({
    address: a.bonding,
    abi: bonding.abi,
    functionName: 'bond',
    args: [seriesId, amountIn, quoted, { maxBtcIn: 2n ** 256n - 1n, minStratOut: 0n }],
    account: signer.account,
  });
  console.log('  gas estimate for the bond:', estimate.toString());

  const receipt = await waitForSuccess(
    await bonding.write.bond([
      seriesId,
      amountIn,
      quoted,
      { maxBtcIn: 2n ** 256n - 1n, minStratOut: 0n },
    ]),
    'Bonding.bond',
  );
  console.log('  bond mined, gas used:', receipt.gasUsed.toString());

  const treasuryAfter = (await treasury.read.btcBalance()) as bigint;
  const liqAfter = (await liq.read.positionLiquidity()) as bigint;
  const held = (await btc.read.balanceOf([a.bonding])) as bigint;
  const promised = (await vvest.read.balanceOf([signer.account.address])) as bigint;

  const took = treasuryAfter - treasuryBefore;
  const expectedTake = (amountIn * treasuryBps) / BPS;
  console.log(
    took === expectedTake
      ? `ok    the Treasury took ${treasuryBps} bps: ${took} sat`
      : `FAIL  the Treasury took ${took} sat, expected ${expectedTake} (${treasuryBps} bps)`,
  );
  console.log(
    promised >= quoted
      ? `ok    VVEST covers the whole promise: ${promised / WAD} STRAT held, ${quoted / WAD} promised by this bond`
      : `FAIL  VVEST ${promised} vs quoted ${quoted}`,
  );
  console.log(
    liqAfter > liqBefore
      ? `ok    THE LIQUIDITY LEG LANDED on a plain gas estimate: position ${liqAfter}, ${held} sat dust`
      : `FAIL  the liquidity leg did not land: position ${liqAfter}, ${held} sat held back`,
  );
  if (took !== expectedTake || promised < quoted || liqAfter <= liqBefore) {
    process.exitCode = 1;
  }
}

main()
  .then(() => process.exit(process.exitCode ?? 0))
  .catch((e) => {
    console.error(e?.shortMessage ?? e?.message ?? e);
    process.exit(1);
  });
