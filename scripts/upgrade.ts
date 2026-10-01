import hre from 'hardhat';
import { encodeFunctionData, getAddress, type Abi, type Address } from 'viem';

import {
  UUPS_CONTRACTS,
  deployImplementation,
  encodeUpgradeToAndCall,
  getImplementation,
  type UupsName,
} from './lib/proxy';
import {
  readLayoutReferences,
  validateUpgrade,
  writeLayoutReference,
} from './lib/upgrades';

/**
//  * Validates and deploys a new module implementation and prints the upgrade proposal. Executes only
//  * when the signer is the upgrade timelock (e.g. a local fork).
//  *   UPGRADE_CONTRACT=Bonding UPGRADE_PROXY=0x... npm run upgrade -- --network sepolia
//  *   Optional: UPGRADE_CALLDATA, UPGRADE_GOVERNOR, UPGRADE_SKIP_REFERENCE=1, UPGRADE_DRY_RUN=1
//  */

const env = (name: string) => process.env[name]?.trim() || undefined;

async function main() {
  const name = env('UPGRADE_CONTRACT') as UupsName | undefined;
  const proxyEnv = env('UPGRADE_PROXY');
  if (!name || !UUPS_CONTRACTS.includes(name)) {
    throw new Error(
      `UPGRADE_CONTRACT must be one of the replaceable modules: ${UUPS_CONTRACTS.join(', ')}. ` +
        'STRAT, VVEST, Treasury, Staking and the governance layer have no upgrade path by design.',
    );
  }
  if (!proxyEnv) throw new Error('UPGRADE_PROXY is required');
  const proxy = getAddress(proxyEnv);
  const extraCalldata = (env('UPGRADE_CALLDATA') ?? '0x') as `0x${string}`;
  const dryRun = env('UPGRADE_DRY_RUN') === '1';
  const network = hre.network.name;

  const [signer] = await hre.viem.getWalletClients();
  const publicClient = await hre.viem.getPublicClient();

  console.log('='.repeat(60));
  console.log(` UPGRADE ${name} @ ${proxy} (${network})`);
  console.log('='.repeat(60));

  // 1. Upgrade safety and storage compatibility.
  console.log('\n Validating upgrade safety...');
  const referenceNetwork =
    env('UPGRADE_SKIP_REFERENCE') === '1' || network === 'hardhat'
      ? undefined
      : network;
  const { layout, solcVersion } = validateUpgrade(name, { referenceNetwork });
  console.log(
    ' OK: upgrade safe, storage layout compatible with the deployed version.',
  );

  // 2. Every UUPS module shares `proxiableUUID`, so the recorded implementation is what ties the proxy to the contract.
  const current = await getImplementation(proxy);
  if (referenceNetwork) {
    const recorded = readLayoutReferences(referenceNetwork)[name]?.implementation;
    if (recorded && getAddress(recorded) !== getAddress(current)) {
      throw new Error(
        `${proxy} runs implementation ${current}, but upgrades/${referenceNetwork}.json records ` +
          `${recorded} for ${name}: wrong proxy, wrong UPGRADE_CONTRACT, or a reference that ` +
          `missed an upgrade (npm run upgrades:snapshot -- --network ${referenceNetwork}).`,
      );
    }
    if (!recorded) {
      console.log(
        ` Note: upgrades/${referenceNetwork}.json records no implementation for ${name}, so the ` +
          'proxy could not be matched to the reference.',
      );
    }
  }

  // 3. New implementation.
  const implementation = await deployImplementation(name);
  const abi = implementation.abi as Abi;
  console.log('\n Current implementation:', current);
  console.log(' New implementation:    ', implementation.address);

  const upgradeCalldata = encodeUpgradeToAndCall(
    abi,
    implementation.address,
    extraCalldata,
  );

  // 4. Who may run it.
  const owner = (await publicClient.readContract({
    address: proxy,
    abi,
    functionName: 'owner',
  })) as Address;

  const authorityAbi = (await hre.artifacts.readArtifact('ProtocolAuthority'))
    .abi as Abi;

  let upgradeTimelock: Address | undefined;
  try {
    upgradeTimelock = (await publicClient.readContract({
      address: owner,
      abi: authorityAbi,
      functionName: 'UPGRADE_TIMELOCK',
    })) as Address;
  } catch {
    upgradeTimelock = undefined; // owner is not a ProtocolAuthority yet
  }

  const authorityCalldata = encodeFunctionData({
    abi: authorityAbi,
    functionName: 'execute',
    args: [proxy, upgradeCalldata],
  });

  console.log('\n Proxy owner:', owner);
  if (upgradeTimelock) {
    console.log(
      ' Upgrade timelock (the only caller allowed):',
      upgradeTimelock,
    );
  }

  console.log('\n Calldata, innermost first:');
  console.log('  1. target = proxy, upgradeToAndCall');
  console.log('    ', upgradeCalldata);
  console.log('  2. target = ProtocolAuthority, execute');
  console.log('    ', authorityCalldata);

  const governor = env('UPGRADE_GOVERNOR');
  if (governor) {
    const governorAbi = (await hre.artifacts.readArtifact('StratGovernor'))
      .abi as Abi;
    const description = `Upgrade ${name} to ${implementation.address}`;
    console.log('  3. target = upgrade governor, propose');
    console.log(
      '    ',
      encodeFunctionData({
        abi: governorAbi,
        functionName: 'propose',
        args: [[owner], [0n], [authorityCalldata], description],
      }),
    );
    console.log('     description:', JSON.stringify(description));
  } else {
    console.log(
      '  (set UPGRADE_GOVERNOR to also print the ready-made propose() payload)',
    );
  }

  const canExecute =
    upgradeTimelock !== undefined &&
    getAddress(upgradeTimelock) === getAddress(signer.account.address);

  if (dryRun || !canExecute) {
    console.log(
      dryRun
        ? '\n Dry run: nothing executed.'
        : '\n The signer is not the upgrade timelock, as expected on a live network.\n' +
            ' Submit the payload above as a proposal on the upgrade governor.',
    );
    return;
  }

  console.log('\n Executing upgrade as the upgrade timelock...');
  const hash = await signer.writeContract({
    address: owner,
    abi: authorityAbi,
    functionName: 'execute',
    args: [proxy, upgradeCalldata],
  });
  await publicClient.waitForTransactionReceipt({ hash });

  // 5. Verification and layout reference.
  const after = await getImplementation(proxy);
  if (getAddress(after) !== getAddress(implementation.address)) {
    throw new Error(
      `Implementation slot is ${after}, expected ${implementation.address}`,
    );
  }
  console.log(' Upgraded. Implementation slot:', after);

  if (network !== 'hardhat') {
    const file = writeLayoutReference(network, name, {
      layout,
      solcVersion,
      implementation: implementation.address,
    });
    console.log(' Storage layout reference updated:', file);
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
