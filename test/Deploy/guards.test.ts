import { expect } from 'chai';
import hre from 'hardhat';

import { deployProtocol } from '../../scripts/deploy';
import { resolveProfile } from '../../scripts/lib/profiles';
import { ISOLATED } from './_profiles';

describe('Deploy — fail-fast guards', function () {
  this.timeout(300_000);

  it('refuses a deployment with no PoolManager configured', async () => {
    await expect(
      deployProtocol({ ...ISOLATED, poolManager: undefined }),
    ).to.be.rejectedWith(/Missing UNISWAP_V4_POOL_MANAGER/);
  });

  it('refuses a PoolManager address with no code behind it', async () => {
    const [, someone] = await hre.viem.getWalletClients();
    await expect(
      deployProtocol({ ...ISOLATED, poolManager: someone.account.address }),
    ).to.be.rejectedWith(/has no code/);
  });

  // Explicit profile: `undefined` would fall through to a local DEPLOY_PROFILE.
  it('refuses an empty or unknown profile, and knows the three real ones', () => {
    expect(() => resolveProfile('')).to.throw(/DEPLOY_PROFILE must be/);
    expect(() => resolveProfile('x')).to.throw(/DEPLOY_PROFILE must be/);
    expect(resolveProfile('prod')).to.equal('prod');
    expect(resolveProfile('demo')).to.equal('demo');
    expect(resolveProfile('sim')).to.equal('sim');
  });
});
