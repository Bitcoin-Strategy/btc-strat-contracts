import { expect } from 'chai';
import hre from 'hardhat';
import { zeroAddress } from 'viem';

describe('STRAT — Transfers', () => {
  let deployer: any;
  let treasury: any;
  let user1: any;
  let user2: any;

  let strat: any;

  beforeEach(async () => {
    const clients = await hre.viem.getWalletClients();
    deployer = clients[0];
    treasury = clients[1];
    user1 = clients[2];
    user2 = clients[3];

    strat = await hre.viem.deployContract('STRAT', [
      treasury.account.address,
      50_000_000n * 10n ** 18n,
    ]);
  });

  it('allows normal transfer between accounts', async () => {
    const amount = 100n * 10n ** 18n;

    await strat.write.transfer([user1.account.address, amount], {
      account: treasury.account,
    });

    const bal = await strat.read.balanceOf([user1.account.address]);
    expect(bal).to.equal(amount);
  });

  it('fails when transferring more than balance', async () => {
    const amount = 123n * 10n ** 18n;

    await expect(
      strat.write.transfer([user2.account.address, amount], {
        account: user1.account,
      }),
    ).to.be.rejected;
  });

  it('fails when transferring to zero address', async () => {
    const amount = 10n * 10n ** 18n;

    await expect(
      strat.write.transfer([zeroAddress, amount], {
        account: treasury.account,
      }),
    ).to.be.rejected;
  });
});
