import { expect } from 'chai';
import hre from 'hardhat';
import type { Address } from 'viem';

import { deployProtocol } from '../../scripts/deploy';
import { deployPoolManager } from '../../scripts/lib/uniswap-v4-local';
import { isPoolInitialized, poolId } from '../../scripts/lib/v4-keys';
import { ISOLATED } from './_profiles';

describe('Deploy — ensurePool', function () {
  this.timeout(300_000);

  let poolManager: Address;

  before(async () => {
    poolManager = await deployPoolManager();
  });

  it('opens the pool it needs and recognizes one that is already open', async () => {
    const first = await deployProtocol({ ...ISOLATED, poolManager });
    expect(first.poolsOpened.stratBtc, 'first run opened STRAT/cbBTC').to.equal(
      true,
    );

    // Fresh STRAT and hook, so this is a different pool.
    const second = await deployProtocol({
      ...ISOLATED,
      poolManager,
      btc: first.btc.address,
    });

    expect(second.stratBtcPoolId, 'a different pool').to.not.equal(
      first.stratBtcPoolId,
    );
    expect(second.poolsOpened.stratBtc, 'and it opened it').to.equal(true);
  });

  it('leaves the pool to the launcher when one is configured', async () => {
    const [deployer] = await hre.viem.getWalletClients();

    const d = await deployProtocol({
      ...ISOLATED,
      poolManager,
      hookAuthorized: deployer.account.address,
    });

    expect(d.poolsOpened.stratBtc, 'not opened here').to.equal(false);

    // A pool opened early could never be graduated into: `validateHook` refuses an existing pool.
    const publicClient = await hre.viem.getPublicClient();
    expect(
      await isPoolInitialized(publicClient, poolManager, d.stratBtcKey),
      'the canonical pool is untouched on chain',
    ).to.equal(false);

    const hook = await hre.viem.getContractAt(
      'StratPoolHook',
      d.poolHook as Address,
    );
    const [, cardinality] = (await hook.read.observationState([
      poolId(d.stratBtcKey) as never,
    ])) as [number, number, number];
    expect(cardinality, 'no observation ring bought').to.equal(0);
  });

  it('stops the deployment when the pool refuses to open', async () => {
    await expect(
      deployProtocol({ ...ISOLATED, poolManager, tickSpacingStratBtc: 0 }),
    ).to.be.rejectedWith(/PoolInitializeFailed: STRAT\/cbBTC/);
  });
});
