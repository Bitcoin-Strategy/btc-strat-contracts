import { expect } from 'chai';
import hre from 'hardhat';
import type { Address } from 'viem';

import { deployProtocol } from '../../scripts/deploy';
import { deployPoolManager } from '../../scripts/lib/uniswap-v4-local';
import { ISOLATED } from './_profiles';

/** Regression: the chunked loop once stopped at 256 when asked for 300. */
describe('Deploy — observation cardinality', function () {
  this.timeout(300_000);

  let poolManager: Address;

  before(async () => {
    poolManager = await deployPoolManager();
  });

  const cardinalityNext = async (hook: Address, poolId: `0x${string}`) => {
    const contract = await hre.viem.getContractAt('StratPoolHook', hook);
    const [, , next] = await contract.read.observationState([poolId]);
    return next;
  };

  for (const target of [300, 64, 257]) {
    it(`buys exactly ${target} slots when asked for ${target}`, async () => {
      const d = await deployProtocol({
        ...ISOLATED,
        poolManager,
        observationCardinality: target,
      });
      expect(
        await cardinalityNext(d.poolHook, d.stratBtcPoolId as `0x${string}`),
      ).to.equal(target);
    });
  }
});
