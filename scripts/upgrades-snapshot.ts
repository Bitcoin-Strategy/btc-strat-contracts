import hre from 'hardhat';
import type { Address } from 'viem';

import { loadDeployment } from './lib/deployment';
import { getImplementation, UUPS_CONTRACTS } from './lib/proxy';
import { snapshotLayouts } from './lib/upgrades';

/**
//  * Stores the current build's storage layouts as the reference for a network. Run from the deployed commit
//  * when an upgrade was executed outside `upgrade.ts`.
//  *   npm run upgrades:snapshot -- --network robinhoodTestnet
//  */
async function main() {
  await hre.run('compile');

  const implementations: Partial<Record<string, string>> = {};
  try {
    const { addresses } = loadDeployment();
    for (const name of UUPS_CONTRACTS) {
      const key = name.charAt(0).toLowerCase() + name.slice(1);
      const proxy = addresses[key];
      if (proxy) {
        implementations[name] = await getImplementation(proxy as Address);
      }
    }
  } catch (error) {
    console.log(
      `No deployment file to read the implementations from (${String(error).split('\n')[0]}); ` +
        'the layouts are stored without implementation addresses.',
    );
  }

  console.log(
    'Storage layout reference written to',
    snapshotLayouts(hre.network.name, implementations),
  );
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
