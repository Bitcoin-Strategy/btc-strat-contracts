import { runDeploy } from './deploy';
import { resolveProfile } from './lib/profiles';
import { deployPoolManager } from './lib/uniswap-v4-local';

async function main() {
  const poolManager = await deployPoolManager();
  console.log(' local PoolManager deployed:', poolManager);

  await runDeploy({ poolManager }, { profile: resolveProfile() });
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
