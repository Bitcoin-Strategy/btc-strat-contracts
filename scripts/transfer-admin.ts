import hre from 'hardhat';
import { formatEther, getAddress, isAddress, type Abi, type Address } from 'viem';

import { loadDeployment } from './lib/deployment';
import { revertName } from './lib/errors';

/**
//  * Hands the Genesis admin to another address. Immediate, no acceptance step, Genesis only.
//  *   NEW_ADMIN=0x... [CONFIRM=yes] npx hardhat run scripts/transfer-admin.ts --network robinhoodTestnet
//  */

const PHASES = ['Genesis', 'Dao'] as const;

async function main(): Promise<number> {
  const deployment = loadDeployment();
  const a = deployment.addresses;

  const [deployer] = await hre.viem.getWalletClients();
  const publicClient = await hre.viem.getPublicClient();
  const me = getAddress(deployer.account.address);

  const raw = process.env.NEW_ADMIN?.trim();
  if (!raw || !isAddress(raw)) {
    console.error(
      `NEW_ADMIN must be an address, got ${raw ? `"${raw}"` : 'nothing'}`,
    );
    return 1;
  }
  const newAdmin = getAddress(raw);

  const authority = await hre.viem.getContractAt(
    'ProtocolAuthority',
    a.authority as Address,
  );
  const authorityAbi = (await hre.artifacts.readArtifact('ProtocolAuthority'))
    .abi as Abi;

  const admin = getAddress((await authority.read.admin()) as Address);
  const phase = await authority.read.currentPhase();
  const guardian = (await authority.read.guardian()) as Address;

  // An admin that cannot pay gas is lost until the DAO takes over.
  const code = await publicClient.getCode({ address: newAdmin });
  const isContract = !!code && code !== '0x';
  const balance = await publicClient.getBalance({ address: newAdmin });

  console.log(' Transferring the Genesis admin. There is no acceptance step.');
  console.log(`   authority:   ${a.authority}`);
  console.log(`   phase:       ${PHASES[phase] ?? phase}`);
  console.log(`   admin now:   ${admin}`);
  console.log(`   this wallet: ${me}`);
  console.log(`   admin after: ${newAdmin}`);
  console.log(
    `   recipient:   ${isContract ? 'a contract' : 'an ordinary account'}, holds ${formatEther(balance)} ETH`,
  );
  console.log(`   guardian:    ${guardian} (unchanged by this)`);
  console.log(
    '   unchanged:   every protocol contract stays owned by ProtocolAuthority',
  );

  if (phase !== 0) {
    console.error(
      '\nGenesis is already finalized: there is no admin to transfer, and the parameter timelock is the controller.',
    );
    return 1;
  }

  if (admin.toLowerCase() !== me.toLowerCase()) {
    console.error(
      `\nonly the current admin can transfer the role: authority.admin() is ${admin}, this wallet is ${me}`,
    );
    return 1;
  }

  if (newAdmin.toLowerCase() === admin.toLowerCase()) {
    console.error('\nNEW_ADMIN is already the admin; nothing to do.');
    return 1;
  }

  if (isContract) {
    console.log(
      '\n  The recipient is a contract. It will only be able to act as admin if it can send\n' +
        '  transactions of its own (a multisig can; a contract with no execution path cannot).',
    );
  }
  if (balance === 0n) {
    console.log(
      '\n  The recipient holds no ETH. Every admin action — parameters, series, finalization —\n' +
        '  is a transaction it has to pay for.',
    );
  }

  // Simulate first: a revert here costs nothing.
  try {
    await publicClient.simulateContract({
      account: me,
      address: a.authority as Address,
      abi: authorityAbi,
      functionName: 'transferAdmin',
      args: [newAdmin],
    });
  } catch (error) {
    console.error(
      `\ntransferAdmin would revert: ${revertName(error, [authorityAbi])}`,
    );
    return 1;
  }

  if (process.env.CONFIRM !== 'yes') {
    console.log(
      '\n Refusing without CONFIRM=yes (dry look only, nothing sent).',
    );
    return 1;
  }

  try {
    await publicClient.waitForTransactionReceipt({
      hash: await authority.write.transferAdmin([newAdmin]),
    });
  } catch (error) {
    console.error(
      `transferAdmin reverted: ${revertName(error, [authorityAbi])}`,
    );
    return 1;
  }

  const adminAfter = getAddress((await authority.read.admin()) as Address);
  const controllerAfter = (await authority.read.controller()) as Address;

  console.log(`PASS  admin: ${admin} -> ${adminAfter}`);
  console.log(`PASS  controller: ${controllerAfter}`);

  if (adminAfter.toLowerCase() !== newAdmin.toLowerCase()) {
    console.error(
      'the admin on chain is not the address that was asked for; do not proceed',
    );
    return 1;
  }

  console.log(
    `\n ${me} can no longer act as admin. Only ${adminAfter} can transfer the role onward or finalize Genesis.`,
  );
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
