import hre from 'hardhat';
import { formatUnits, parseUnits, type Address } from 'viem';

import { loadDeployment } from './lib/deployment';
import { waitForSuccess } from './lib/tx';

/**
//  * Testnet only: mints mock cbBTC into the Treasury. Raises NAV for every holder; irreversible.
//  *   FUND_BTC=600 [CONFIRM=yes] npx hardhat run scripts/fund-treasury.ts --network robinhoodTestnet
//  */
async function main(): Promise<number> {
  const deployment = loadDeployment();
  const a = deployment.addresses as Record<string, Address>;
  if (!deployment.mocks) {
    console.error(
      `${deployment.deployment} uses a real cbBTC; there is nothing to mint`,
    );
    return 1;
  }

  const raw = process.env.FUND_BTC?.trim() || '600';
  const amount = parseUnits(raw, 8);
  if (amount <= 0n) {
    console.error(`FUND_BTC must be a positive amount of cbBTC, got "${raw}"`);
    return 1;
  }

  const btc = await hre.viem.getContractAt('MockERC20Decimals', a.btc);
  const treasury = await hre.viem.getContractAt('Treasury', a.treasury);
  const bonding = await hre.viem.getContractAt('Bonding', a.bonding);

  const WAD = 10n ** 18n;
  const BTC_TO_WAD = 10n ** 10n; // cbBTC has 8 decimals
  const before = (await btc.read.balanceOf([a.treasury])) as bigint;
  const navBefore = (await treasury.read.navBtcPerStrat()) as bigint;
  const backing = (await treasury.read.backingSupply()) as bigint;
  const navAfter =
    backing === 0n ? 0n : ((before + amount) * BTC_TO_WAD * WAD) / backing;

  console.log(' Minting mock cbBTC into the Treasury.');
  console.log(`   treasury:      ${a.treasury}`);
  console.log(
    `   cbBTC:         ${formatUnits(before, 8)} -> ${formatUnits(before + amount, 8)}`,
  );
  console.log(`   backingSupply: ${formatUnits(backing, 18)} STRAT`);
  console.log(
    `   NAV:           ${formatUnits(navBefore, 18)} -> ${formatUnits(navAfter, 18)} BTC per STRAT`,
  );
  if (backing === 0n) {
    console.log(
      '   nothing has been sold yet, so NAV stays 0 until it has; the first sales then share all of this bitcoin',
    );
  }

  const [live, seriesId] = await bonding.read.liveSeries();
  if (live) {
    const series = await bonding.read.getSeries([seriesId]);
    const net = (await bonding.read.netBtcPerStratWad([
      series.priceBtcPerStrat,
    ])) as bigint;
    console.log(
      `   live series ${seriesId} nets ${formatUnits(net, 18)} BTC per STRAT: ` +
        (net >= navAfter
          ? 'still clears the new NAV'
          : 'UNDER the new NAV. It keeps selling (the floor is checked only when a series is opened), and no series at or under this price can be opened again (PriceBelowNav)'),
    );
  } else {
    console.log(
      '   no live series; the next one has to net at least the new NAV after proceeds routing',
    );
  }

  if (process.env.CONFIRM !== 'yes') {
    console.log(
      '\n Refusing without CONFIRM=yes (dry look only, nothing sent).',
    );
    return 1;
  }

  await waitForSuccess(
    await btc.write.mint([a.treasury, amount]),
    'cbBTC mint',
  );
  await waitForSuccess(
    await treasury.write.syncTreasury(),
    'Treasury.syncTreasury',
  );
  const after = (await btc.read.balanceOf([a.treasury])) as bigint;

  console.log(
    `\nPASS  Treasury cbBTC: ${formatUnits(before, 8)} -> ${formatUnits(after, 8)}`,
  );
  console.log(
    `PASS  NAV: ${formatUnits((await treasury.read.navBtcPerStrat()) as bigint, 18)} BTC per STRAT`,
  );
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
