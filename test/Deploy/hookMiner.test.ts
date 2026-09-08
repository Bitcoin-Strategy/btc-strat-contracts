import { expect } from 'chai';
import hre from 'hardhat';
import { encodeDeployData, getAddress, zeroAddress } from 'viem';

import {
  deployHook,
  mineHookSalt,
  STRAT_POOL_HOOK_FLAGS,
} from '../../scripts/lib/hook-miner';

/** Anyone with the init code can deploy the hook first; the deployment must reuse it. */
describe('Deploy — hook miner', function () {
  this.timeout(120_000);

  const initCodeFor = async (authorized: `0x${string}`) => {
    const artifact = await hre.artifacts.readArtifact('StratPoolHook');
    const [deployer] = await hre.viem.getWalletClients();
    return encodeDeployData({
      abi: artifact.abi,
      bytecode: artifact.bytecode as `0x${string}`,
      // `BaseHook` only checks the address bits, so the pool manager can be anything.
      args: [deployer.account.address, authorized, 100, zeroAddress, 0],
    });
  };

  it('mines the same address for the same init code', async () => {
    const [, someone] = await hre.viem.getWalletClients();
    const initCode = await initCodeFor(someone.account.address);
    const first = mineHookSalt({ initCode, flags: STRAT_POOL_HOOK_FLAGS });
    const second = mineHookSalt({ initCode, flags: STRAT_POOL_HOOK_FLAGS });
    expect(second).to.deep.equal(first);
  });

  it('reuses a hook that already sits at the mined address instead of failing', async () => {
    const [, someone] = await hre.viem.getWalletClients();
    const initCode = await initCodeFor(someone.account.address);

    const first = await deployHook({ initCode, flags: STRAT_POOL_HOOK_FLAGS });
    const second = await deployHook({ initCode, flags: STRAT_POOL_HOOK_FLAGS });

    expect(second.address).to.equal(first.address);
    const publicClient = await hre.viem.getPublicClient();
    const code = await publicClient.getCode({ address: second.address });
    expect(code).to.not.equal(undefined);
    expect(code).to.not.equal('0x');
    const hook = await hre.viem.getContractAt('StratPoolHook', second.address);
    expect(await hook.read.authorized()).to.equal(
      getAddress(someone.account.address),
    );
  });
});
