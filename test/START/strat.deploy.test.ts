import { expect } from 'chai';
import hre from 'hardhat';
import { zeroAddress } from 'viem';

const WAD = 10n ** 18n;
const MAX_SUPPLY = 50_000_000n * WAD;

describe('STRAT — Deployment', () => {
  let holder: any;

  beforeEach(async () => {
    const clients = await hre.viem.getWalletClients();
    holder = clients[1];
  });

  it('mints the initial supply to the holder', async () => {
    const strat = await hre.viem.deployContract('STRAT', [
      holder.account.address,
      MAX_SUPPLY,
    ]);

    expect(await strat.read.totalSupply()).to.equal(MAX_SUPPLY);
    expect(await strat.read.balanceOf([holder.account.address])).to.equal(
      MAX_SUPPLY,
    );
    expect(await strat.read.name()).to.equal('STRAT Token');
    expect(await strat.read.symbol()).to.equal('STRAT');
    expect(await strat.read.MAX_SUPPLY()).to.equal(MAX_SUPPLY);
  });

  it('allows an initial supply below the cap and has no mint function', async () => {
    const strat = await hre.viem.deployContract('STRAT', [
      holder.account.address,
      1_000n * WAD,
    ]);

    expect(await strat.read.totalSupply()).to.equal(1_000n * WAD);
    expect(
      (strat.abi as readonly { name?: string }[]).some(
        (item) => item.name === 'mint' || item.name === 'owner',
      ),
    ).to.equal(false);
  });

  it('reverts when holder is zero', async () => {
    await expect(
      hre.viem.deployContract('STRAT', [zeroAddress, MAX_SUPPLY]),
    ).to.be.rejectedWith('STRAT: holder zero');
  });

  it('reverts when initial supply exceeds MAX_SUPPLY', async () => {
    await expect(
      hre.viem.deployContract('STRAT', [
        holder.account.address,
        MAX_SUPPLY + 1n,
      ]),
    ).to.be.rejectedWith('STRAT: invalid initial supply');
  });
});
