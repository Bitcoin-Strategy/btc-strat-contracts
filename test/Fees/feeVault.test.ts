import { expect } from 'chai';
import hre from 'hardhat';
import { type Address } from 'viem';

import { claimBalance, swapExactIn, whole } from '../Oracle/_v4';
import {
  BTC_PER_STRAT_WAD,
  STRAT_TO_BTC_RATE,
  deployFeeFixture,
  tokenAt,
  vaultAt,
  type FeeFixture,
} from './_fees';

const WAD = 10n ** 18n;
const BPS = 10_000n;
const BTC_TO_WAD = 10n ** 10n;

const TRADE = 1_000;

const accrueFees = async (f: FeeFixture) => {
  for (const zeroForOne of [true, false]) {
    await swapExactIn({
      swapRouter: f.swapRouter,
      key: f.key,
      zeroForOne,
      amountIn: whole(f, zeroForOne, TRADE),
    });
  }
};

/// Only the STRAT side is priced; cbBTC counts at face value.
const expectedBtc = (strat: bigint, btc: bigint): bigint =>
  (strat * BTC_PER_STRAT_WAD) / WAD / BTC_TO_WAD + btc;

const balanceOf = async (token: Address, holder: Address): Promise<bigint> =>
  (await tokenAt(token)).read.balanceOf([holder]);

describe('FeeVault — harvest', () => {
  it('converts the STRAT side, keeps the BTC side as it is, pays the caller and sends the rest to the Treasury', async () => {
    const f = await deployFeeFixture();
    const [, keeper] = await hre.viem.getWalletClients();
    const vault = await vaultAt(f.vault);
    await accrueFees(f);

    const stratClaims = await claimBalance(f.poolManager, f.vault, f.strat);
    const btcClaims = await claimBalance(f.poolManager, f.vault, f.btc);
    expect(stratClaims).to.not.equal(0n);
    expect(btcClaims).to.not.equal(0n);
    expect(await balanceOf(f.strat, f.vault)).to.equal(0n);

    const [pendingStrat, pendingBtc] = await vault.read.pendingFees();
    expect(pendingStrat).to.equal(stratClaims);
    expect(pendingBtc).to.equal(btcClaims);

    const [quoted, quotedReward, ready] = await vault.read.quoteHarvest();
    expect(quoted).to.equal(expectedBtc(stratClaims, btcClaims));
    expect(ready).to.equal(true);

    const treasuryMock = await hre.viem.getContractAt(
      'TreasuryMock',
      f.treasury,
    );
    const syncBefore = await treasuryMock.read.syncCalls();

    await vault.write.harvest([0n], { account: keeper.account });

    const reward = await balanceOf(f.btc, keeper.account.address);
    const toTreasury = await balanceOf(f.btc, f.treasury);

    expect(reward + toTreasury).to.equal(quoted);
    expect(reward).to.equal(quotedReward);
    expect(reward).to.equal((quoted * 25n) / BPS);

    expect(await balanceOf(f.btc, f.vault)).to.equal(0n);
    expect(await claimBalance(f.poolManager, f.vault, f.strat)).to.equal(0n);
    expect(await claimBalance(f.poolManager, f.vault, f.btc)).to.equal(0n);
    expect(await balanceOf(f.strat, f.vault)).to.equal(0n);
    expect(await balanceOf(f.btc, f.vault)).to.equal(0n);

    expect(await treasuryMock.read.syncCalls()).to.equal(syncBefore + 1n);
  });

  it('harvests a single currency when only one side has traded', async () => {
    const f = await deployFeeFixture();
    const vault = await vaultAt(f.vault);

    await swapExactIn({
      swapRouter: f.swapRouter,
      key: f.key,
      zeroForOne: true,
      amountIn: whole(f, true, TRADE),
    });

    const [pendingStrat, pendingBtc] = await vault.read.pendingFees();
    expect(pendingStrat === 0n || pendingBtc === 0n).to.equal(true);

    await vault.write.harvest([0n]);
    expect(await balanceOf(f.btc, f.treasury)).to.not.equal(0n);
  });

  it('keeps the caller reward inside both of its bounds', async () => {
    const f = await deployFeeFixture();
    const [, keeper] = await hre.viem.getWalletClients();
    const vault = await vaultAt(f.vault);
    await accrueFees(f);

    const [quoted] = await vault.read.quoteHarvest();
    const ceiling = (quoted * 25n) / BPS / 2n;

    // The ceiling, not the share, is what the caller gets.
    await vault.write.setHarvestReward([25, ceiling]);
    await vault.write.harvest([0n], { account: keeper.account });

    expect(await balanceOf(f.btc, keeper.account.address)).to.equal(ceiling);
  });

  it('refuses a reward above the corridor, whoever asks', async () => {
    const f = await deployFeeFixture();
    const vault = await vaultAt(f.vault);
    expect(await vault.read.MAX_HARVEST_REWARD_BPS()).to.equal(200);

    await expect(vault.write.setHarvestReward([201, 0n])).to.be.rejectedWith(
      'InvalidConfig',
    );
    await vault.write.setHarvestReward([200, 0n]);
  });

  it('waits until a harvest is worth the spread it will pay', async () => {
    const f = await deployFeeFixture();
    const vault = await vaultAt(f.vault);
    await accrueFees(f);

    const [quoted] = await vault.read.quoteHarvest();
    await vault.write.setMinHarvestBtc([quoted + 1n]);

    const [, , ready] = await vault.read.quoteHarvest();
    expect(ready).to.equal(false);
    await expect(vault.write.harvest([0n])).to.be.rejectedWith(
      'BelowHarvestThreshold',
    );

    await vault.write.setMinHarvestBtc([quoted]);
    await vault.write.harvest([0n]);
  });

  it('refuses to harvest nothing', async () => {
    const f = await deployFeeFixture();
    const vault = await vaultAt(f.vault);

    await expect(vault.write.harvest([0n])).to.be.rejectedWith(
      'BelowHarvestThreshold',
    );
  });

  it('forwards BTC that reached it by some other route, rather than stranding it', async () => {
    const f = await deployFeeFixture();
    const vault = await vaultAt(f.vault);
    const btc = await tokenAt(f.btc);

    await btc.write.mint([f.vault, 50_000n]);

    const [quoted] = await vault.read.quoteHarvest();
    expect(quoted).to.equal(50_000n);

    await vault.write.harvest([0n]);
    expect(await balanceOf(f.btc, f.vault)).to.equal(0n);
    expect(await balanceOf(f.btc, f.treasury)).to.not.equal(0n);
  });

  it('fails closed while the oracle cannot price what it holds', async () => {
    const f = await deployFeeFixture();
    const vault = await vaultAt(f.vault);
    const oracle = await hre.viem.getContractAt('PriceOracleMock', f.oracle);
    await accrueFees(f);

    // A fresh pool has no full TWAP window yet.
    await oracle.write.setBroken([f.strat, f.btc, true]);
    await expect(vault.write.harvest([0n])).to.be.rejectedWith('FeedBroken');

    const [pendingStrat] = await vault.read.pendingFees();
    expect(pendingStrat).to.not.equal(0n);

    await oracle.write.setBroken([f.strat, f.btc, false]);
    await vault.write.harvest([0n]);
  });
});

describe('FeeVault — what a permissionless harvest cannot do', () => {
  it('holds the conversion to a floor the caller does not choose', async () => {
    const f = await deployFeeFixture();
    const vault = await vaultAt(f.vault);
    const executor = await hre.viem.getContractAt(
      'SwapExecutorMock',
      f.executor,
    );
    await accrueFees(f);

    await executor.write.setRate([
      f.strat,
      f.btc,
      (STRAT_TO_BTC_RATE * 95n) / 100n,
    ]);

    // Asking for nothing does not lower the oracle floor.
    await expect(vault.write.harvest([0n])).to.be.rejected;

    await executor.write.setRate([f.strat, f.btc, STRAT_TO_BTC_RATE]);
    await vault.write.harvest([0n]);
  });

  it('lets the caller tighten the floor, never loosen it', async () => {
    const f = await deployFeeFixture();
    const vault = await vaultAt(f.vault);
    await accrueFees(f);

    const [quoted] = await vault.read.quoteHarvest();

    await expect(vault.write.harvest([quoted + 1n])).to.be.rejectedWith(
      'HarvestBelowMin',
    );
    await vault.write.harvest([quoted]);
  });

  it('catches an adapter that takes the tokens and reports a swap it did not make', async () => {
    const f = await deployFeeFixture();
    const vault = await vaultAt(f.vault);
    const executor = await hre.viem.getContractAt(
      'SwapExecutorMock',
      f.executor,
    );
    await accrueFees(f);

    await executor.write.setLie([true]);

    await expect(vault.write.harvest([0n])).to.be.rejectedWith(
      'HarvestBelowMin',
    );
  });

  it('refuses to run while the module is paused', async () => {
    const f = await deployFeeFixture();
    const vault = await vaultAt(f.vault);
    await accrueFees(f);

    await vault.write.pause();
    await expect(vault.write.harvest([0n])).to.be.rejectedWith('EnforcedPause');

    await vault.write.unpause();
    await vault.write.harvest([0n]);
  });
});

describe('FeeVault — claims', () => {
  it('lets anyone realise the claims without converting anything', async () => {
    const f = await deployFeeFixture();
    const [, outsider] = await hre.viem.getWalletClients();
    const vault = await vaultAt(f.vault);
    await accrueFees(f);

    const stratClaims = await claimBalance(f.poolManager, f.vault, f.strat);
    const btcClaims = await claimBalance(f.poolManager, f.vault, f.btc);

    await vault.write.redeemClaims({ account: outsider.account });

    expect(await balanceOf(f.strat, f.vault)).to.equal(stratClaims);
    expect(await balanceOf(f.btc, f.vault)).to.equal(btcClaims);
    expect(await claimBalance(f.poolManager, f.vault, f.strat)).to.equal(0n);

    await vault.write.redeemClaims();
    const [pendingStrat, pendingBtc] = await vault.read.pendingFees();
    expect(pendingStrat).to.equal(stratClaims);
    expect(pendingBtc).to.equal(btcClaims);
  });

  it('harvests fees that were redeemed earlier just the same', async () => {
    const f = await deployFeeFixture();
    const vault = await vaultAt(f.vault);
    await accrueFees(f);

    const [quoted] = await vault.read.quoteHarvest();
    await vault.write.redeemClaims();
    await vault.write.harvest([0n]);

    expect(await balanceOf(f.btc, f.treasury)).to.not.equal(0n);
    expect(await balanceOf(f.btc, f.vault)).to.equal(0n);
    expect(quoted).to.not.equal(0n);
  });

  it('refuses an unlock callback that did not come from the pool manager', async () => {
    const f = await deployFeeFixture();
    const vault = await vaultAt(f.vault);

    await expect(vault.write.unlockCallback(['0x'])).to.be.rejectedWith(
      'NotPoolManager',
    );
  });
});

describe('FeeVault — configuration', () => {
  it('is wired to the pool, the Treasury and the venue it was given', async () => {
    const f = await deployFeeFixture();
    const vault = await vaultAt(f.vault);

    expect((await vault.read.poolManager()).toLowerCase()).to.equal(
      f.poolManager.toLowerCase(),
    );
    expect((await vault.read.treasury()).toLowerCase()).to.equal(
      f.treasury.toLowerCase(),
    );
    expect((await vault.read.btcToken()).toLowerCase()).to.equal(
      f.btc.toLowerCase(),
    );
    expect(await vault.read.harvestSlippageBps()).to.equal(100);
    expect(await vault.read.harvestRewardBps()).to.equal(25);
  });

  it('lets only the owner move the parameters', async () => {
    const f = await deployFeeFixture();
    const [, outsider] = await hre.viem.getWalletClients();
    const vault = await vaultAt(f.vault);

    // Thunks, so no rejection goes unhandled.
    for (const call of [
      () =>
        vault.write.setHarvestReward([50, 0n], { account: outsider.account }),
      () =>
        vault.write.setHarvestSlippageBps([200], {
          account: outsider.account,
        }),
      () => vault.write.setMinHarvestBtc([1n], { account: outsider.account }),
      () =>
        vault.write.setSwapExecutor([f.executor], {
          account: outsider.account,
        }),
    ]) {
      await expect(call()).to.be.rejectedWith('OwnableUnauthorizedAccount');
    }
  });

  it('keeps the slippage allowance inside its corridor', async () => {
    const f = await deployFeeFixture();
    const vault = await vaultAt(f.vault);
    const max = await vault.read.MAX_HARVEST_SLIPPAGE_BPS();

    await expect(
      vault.write.setHarvestSlippageBps([max + 1]),
    ).to.be.rejectedWith('InvalidConfig');
    await vault.write.setHarvestSlippageBps([max]);
    expect(await vault.read.harvestSlippageBps()).to.equal(max);
  });

  it('can be repointed at a new venue without an upgrade', async () => {
    const f = await deployFeeFixture();
    const vault = await vaultAt(f.vault);
    const replacement = await hre.viem.deployContract('SwapExecutorMock', []);
    await replacement.write.setRate([f.strat, f.btc, STRAT_TO_BTC_RATE]);

    await accrueFees(f);
    await vault.write.setSwapExecutor([replacement.address]);
    await vault.write.harvest([0n]);

    expect(await replacement.read.swapCount()).to.not.equal(0n);
    expect(await balanceOf(f.btc, f.treasury)).to.not.equal(0n);
  });
});
