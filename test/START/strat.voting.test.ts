import { expect } from 'chai';
import hre from 'hardhat';

describe('STRAT — Voting (ERC20Votes)', () => {
  let deployer: any;
  let treasury: any;
  let user1: any;

  let strat: any;

  beforeEach(async () => {
    const clients = await hre.viem.getWalletClients();
    deployer = clients[0];
    treasury = clients[1];
    user1 = clients[2];

    strat = await hre.viem.deployContract('STRAT', [
      treasury.account.address,
      50_000_000n * 10n ** 18n,
    ]);
  });

  it('delegates voting power to self', async () => {
    await strat.write.delegate([treasury.account.address], {
      account: treasury.account,
    });

    const votes = await strat.read.getVotes([treasury.account.address]);
    const bal = await strat.read.balanceOf([treasury.account.address]);

    expect(votes).to.equal(bal);
  });

  it('updates voting power after transfer', async () => {
    const amount = 1_000n * 10n ** 18n;

    await strat.write.delegate([treasury.account.address], {
      account: treasury.account,
    });

    await strat.write.transfer([user1.account.address, amount], {
      account: treasury.account,
    });

    const votesAfter = await strat.read.getVotes([treasury.account.address]);
    const expectedVotes = 50_000_000n * 10n ** 18n - amount;

    expect(votesAfter).to.equal(expectedVotes);
  });

  it('delegation for user with zero balance gives zero voting power', async () => {
    await strat.write.delegate([user1.account.address], {
      account: user1.account,
    });

    const votes = await strat.read.getVotes([user1.account.address]);
    expect(votes).to.equal(0n);
  });
});
