import hre from 'hardhat';
import { formatUnits, parseUnits, type Address } from 'viem';
import { z } from 'zod';

import { loadDeployment } from './lib/deployment';
import { waitForSuccess } from './lib/tx';

/// No bounds of its own: the contract's oracle floors decide.
const LIQ_SWEEP = {
  maxBtcIn: 2n ** 256n - 1n,
  minStratOut: 0n,
} as const;

const envSchema = z.object({
  BOND_BTC: z.string().default('0.001'),
});

async function main(): Promise<number> {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    console.error(
      'BOND_BTC must be a decimal amount, e.g. BOND_BTC=0.001',
    );
    return 1;
  }

  const deployment = loadDeployment();
  const a = deployment.addresses;

  const [deployer] = await hre.viem.getWalletClients();
  const publicClient = await hre.viem.getPublicClient();
  const me = deployer.account.address;

  const bonding = await hre.viem.getContractAt('Bonding', a.bonding as Address);
  const vvest = await hre.viem.getContractAt('VVEST', a.vvest as Address);
  const vault = await hre.viem.getContractAt(
    'VestingVault',
    a.vestingVault as Address,
  );
  const btc = await hre.viem.getContractAt(
    'MockERC20Decimals',
    a.btc as Address,
  );

  const [live, seriesId] = await bonding.read.liveSeries();
  if (!live) {
    console.log(
      'no live bond series; create one first (npm run series:create:*)',
    );
    return 2;
  }

  const amountIn = parseUnits(parsed.data.BOND_BTC, 8);

  console.log(` series ${seriesId}: ${formatUnits(amountIn, 8)} cbBTC in`);

  if (deployment.mocks) {
    await waitForSuccess(await btc.write.mint([me, amountIn]), 'cbBTC mint');
  } else {
    const balance = await btc.read.balanceOf([me]);
    if (balance < amountIn) {
      console.error(
        `not enough cbBTC: have ${balance}, need ${amountIn} (no mocks in this deployment)`,
      );
      return 1;
    }
  }
  await waitForSuccess(
    await btc.write.approve([a.bonding as Address, amountIn]),
    'cbBTC approve',
  );

  const promised = await bonding.read.preview([seriesId, amountIn]);
  const vvestBefore = await vvest.read.balanceOf([me]);
  const treasuryBefore = await btc.read.balanceOf([a.treasury as Address]);
  const vestsBefore = await vault.read.vestCount([me]);

  // The price is fixed, so anything below the preview is a fault.
  await waitForSuccess(
    await bonding.write.bond([seriesId, amountIn, promised, LIQ_SWEEP]),
    'Bonding.bond',
  );

  const vvestDelta = (await vvest.read.balanceOf([me])) - vvestBefore;
  const treasuryDelta =
    (await btc.read.balanceOf([a.treasury as Address])) - treasuryBefore;
  const vestsDelta = (await vault.read.vestCount([me])) - vestsBefore;

  const checks: Array<[string, boolean, string]> = [
    [
      'VVEST minted == preview',
      vvestDelta === promised,
      `${formatUnits(vvestDelta, 18)} vs ${formatUnits(promised, 18)} STRAT`,
    ],
    [
      'Treasury cbBTC grew',
      treasuryDelta > 0n,
      `+${formatUnits(treasuryDelta, 8)} cbBTC`,
    ],
    ['vest created', vestsDelta === 1n, `vestCount +${vestsDelta}`],
  ];

  let failed = 0;
  for (const [spec, ok, detail] of checks) {
    if (!ok) failed += 1;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${spec.padEnd(24)} ${detail}`);
  }

  console.log(failed === 0 ? '\nPASS  bond smoke' : '\nFAIL  bond smoke');
  return failed === 0 ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
