import { expect } from 'chai';
import hre from 'hardhat';
import type { Address } from 'viem';

import { deployProtocol, type DeployResult } from '../../scripts/deploy';
import { deployPoolManager } from '../../scripts/lib/uniswap-v4-local';
import { ISOLATED } from './_profiles';

describe('Deploy — testnet routers', function () {
  this.timeout(300_000);

  let d: DeployResult;

  before(async () => {
    const poolManager = await deployPoolManager();
    d = await deployProtocol({ ...ISOLATED, poolManager });
  });

  it('no configured cbBTC means a mock token and the three Uniswap routers', async () => {
    expect(d.mocks, 'mocks').to.equal(true);
    expect(await d.btc.read.decimals(), 'cbBTC decimals').to.equal(8);
  });

  it('every router is deployed and has code', async () => {
    const publicClient = await hre.viem.getPublicClient();

    for (const [name, address] of [
      ['swapRouter', d.swapRouter],
      ['liquidityRouter', d.liquidityRouter],
      ['stateView', d.stateView],
    ] as const) {
      expect(address, name).to.not.equal(undefined);
      const code = await publicClient.getCode({
        address: address as Address,
      });
      expect(code, `${name} code`).to.not.equal(undefined);
      expect(code, `${name} code`).to.not.equal('0x');
    }
  });

  it('opened its one pool', () => {
    expect(d.poolsOpened.stratBtc, 'STRAT/cbBTC opened').to.equal(true);
  });
});
