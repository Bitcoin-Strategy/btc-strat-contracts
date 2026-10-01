import hre from 'hardhat';
import { type Abi, type Address } from 'viem';

import { loadDeployment } from './lib/deployment';
import { revertName } from './lib/errors';
import { reservedCalls, sealGenesis } from './lib/seal-genesis';
import { waitForSuccess } from './lib/tx';

const PHASES = ['Genesis', 'Dao'] as const;

async function main(): Promise<number> {
  const deployment = loadDeployment();
  const a = deployment.addresses;

  const [deployer] = await hre.viem.getWalletClients();
  const publicClient = await hre.viem.getPublicClient();
  const me = deployer.account.address;

  const authority = await hre.viem.getContractAt(
    'ProtocolAuthority',
    a.authority as Address,
  );
  const authorityAbi = (await hre.artifacts.readArtifact('ProtocolAuthority'))
    .abi as Abi;

  const admin = (await authority.read.admin()) as Address;
  const phase = await authority.read.currentPhase();

  const treasury = await hre.viem.getContractAt(
    'Treasury',
    a.treasury as Address,
  );
  const redemptionDelay = BigInt(await treasury.read.REDEMPTION_DELAY());
  const bonding = await hre.viem.getContractAt('Bonding', a.bonding as Address);
  const sealTargets = {
    authority: a.authority as Address,
    bonding: a.bonding as Address,
    premiumSales: a.premiumSales as Address,
  };
  const reserved = await reservedCalls(sealTargets);
  const seriesCount = await bonding.read.nextSeriesId();

  console.log(' Finalizing Genesis. This cannot be undone.');
  console.log(`   authority:        ${a.authority}`);
  console.log(`   admin (revoked):  ${admin}`);
  console.log(`   phase:            ${PHASES[phase] ?? phase}`);
  console.log('   DAO takes over:   in this transaction');
  console.log(
    `   redemption opens: ${redemptionDelay}s after finalization (REDEMPTION_DELAY)`,
  );
  console.log(
    '   afterwards:       every owner-only call goes through a governor proposal',
  );
  // F-06: STRAT-selling calls move to the upgrade track before the admin is revoked.
  console.log(' First, as the admin (add-only, permanent):');
  if (seriesCount > 0) {
    const id = seriesCount - 1;
    const s = await bonding.read.getSeries([id]);
    console.log(
      `   series ${id}:         capacity ${s.capacityMstrat} -> ${s.filledMstrat} (what has been sold), closed`,
    );
  }
  for (const { label, target, selector } of reserved) {
    const already = await authority.read.restricted([target, selector]);
    console.log(
      `   reserve:          ${label} (${selector})${already ? ' — already reserved' : ''}`,
    );
  }

  if (process.env.CONFIRM !== 'yes') {
    console.log(
      '\n Refusing without CONFIRM=yes (dry look only, nothing sent).',
    );
    return 1;
  }

  if (admin.toLowerCase() !== me.toLowerCase()) {
    console.error(
      `only the Genesis admin can finalize: authority.admin() is ${admin}, this wallet is ${me}`,
    );
    return 1;
  }

  try {
    await sealGenesis(sealTargets, me);
  } catch (error) {
    console.error(
      `sealing Genesis failed, nothing finalized: ${revertName(error, [authorityAbi])}`,
    );
    return 1;
  }

  // Simulate first: a revert here costs nothing.
  try {
    await publicClient.simulateContract({
      account: me,
      address: a.authority as Address,
      abi: authorityAbi,
      functionName: 'finalizeGenesis',
      args: [],
    });
  } catch (error) {
    console.error(
      `finalizeGenesis would revert: ${revertName(error, [authorityAbi])}`,
    );
    return 1;
  }

  try {
    await waitForSuccess(
      await authority.write.finalizeGenesis(),
      'ProtocolAuthority.finalizeGenesis',
    );
  } catch (error) {
    console.error(
      `finalizeGenesis reverted: ${revertName(error, [authorityAbi])}`,
    );
    return 1;
  }

  const adminAfter = await authority.read.admin();
  const phaseAfter = await authority.read.currentPhase();
  console.log(`PASS  admin: ${admin} -> ${adminAfter}`);
  console.log(
    `PASS  phase: ${PHASES[phase] ?? phase} -> ${PHASES[phaseAfter] ?? phaseAfter}`,
  );
  for (const { label, target, selector } of reserved) {
    if (!(await authority.read.restricted([target, selector]))) {
      console.error(`FAIL  ${label} is not reserved for the upgrade timelock`);
      return 1;
    }
    console.log(`PASS  ${label}: upgrade timelock only`);
  }
  if (seriesCount > 0) {
    const id = seriesCount - 1;
    const remaining = await bonding.read.getRemainingCapacity([id]);
    if (remaining !== 0n) {
      console.error(`FAIL  series ${id} still has ${remaining} to sell`);
      return 1;
    }
    console.log(`PASS  series ${id}: nothing left to reactivate`);
  }
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
