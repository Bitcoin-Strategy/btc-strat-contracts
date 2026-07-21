import { expect } from 'chai';
import hre from 'hardhat';
import { type Address } from 'viem';

import {
  FEE_PIPS,
  PIPS_DENOM,
  claimBalance,
  deployBare,
  deployOracleFixture,
  swapExactIn,
  swapExactOut,
  whole,
  type OracleFixture,
} from '../Oracle/_v4';

const ZERO = '0x0000000000000000000000000000000000000000';

const TRADE = 1_000;

const balanceOf = async (token: Address, holder: Address): Promise<bigint> => {
  const erc20 = await hre.viem.getContractAt('MockERC20Decimals', token);
  return erc20.read.balanceOf([holder]);
};

const sellingStrat = (f: OracleFixture) => f.stratIsCurrency0;

describe('StratPoolHook — the fee it charges', () => {
  it('charges the token the trade receives, and leaves the other side alone', async () => {
    const f = await deployOracleFixture();

    await swapExactIn({
      swapRouter: f.swapRouter,
      key: f.key,
      zeroForOne: sellingStrat(f),
      amountIn: whole(f, sellingStrat(f), TRADE),
    });

    expect(await claimBalance(f.poolManager, f.feeVault, f.btc)).to.not.equal(
      0n,
    );
    expect(await claimBalance(f.poolManager, f.feeVault, f.strat)).to.equal(0n);
  });

  it('charges the other token when the trade goes the other way', async () => {
    const f = await deployOracleFixture();
    const buyingStrat = !sellingStrat(f);

    await swapExactIn({
      swapRouter: f.swapRouter,
      key: f.key,
      zeroForOne: buyingStrat,
      amountIn: whole(f, buyingStrat, TRADE),
    });

    expect(await claimBalance(f.poolManager, f.feeVault, f.strat)).to.not.equal(
      0n,
    );
    expect(await claimBalance(f.poolManager, f.feeVault, f.btc)).to.equal(0n);
  });

  it('takes exactly its share of the output, and the trader receives the rest', async () => {
    const f = await deployOracleFixture();
    const [trader] = await hre.viem.getWalletClients();
    const zeroForOne = sellingStrat(f);

    const before = await balanceOf(f.btc, trader.account.address);
    await swapExactIn({
      swapRouter: f.swapRouter,
      key: f.key,
      zeroForOne,
      amountIn: whole(f, zeroForOne, TRADE),
    });
    const received =
      (await balanceOf(f.btc, trader.account.address)) - before;
    const fee = await claimBalance(f.poolManager, f.feeVault, f.btc);

    const gross = received + fee;
    expect(fee).to.equal((gross * BigInt(FEE_PIPS)) / BigInt(PIPS_DENOM));
    expect(fee).to.not.equal(0n);
  });

  it('costs the trader exactly the fee, measured against the same pool without one', async () => {
    // Identical pools except for the fee, so the output gap is the fee.
    const withFee = await deployOracleFixture({ forceStratCurrency0: true });
    const withoutFee = await deployOracleFixture({
      forceStratCurrency0: true,
      feePips: 0,
    });
    const [trader] = await hre.viem.getWalletClients();

    const receivedFrom = async (f: OracleFixture): Promise<bigint> => {
      const before = await balanceOf(f.btc, trader.account.address);
      await swapExactIn({
        swapRouter: f.swapRouter,
        key: f.key,
        zeroForOne: true,
        amountIn: whole(f, true, TRADE),
      });
      return (await balanceOf(f.btc, trader.account.address)) - before;
    };

    const gross = await receivedFrom(withoutFee);
    const net = await receivedFrom(withFee);
    const fee = await claimBalance(
      withFee.poolManager,
      withFee.feeVault,
      withFee.btc,
    );

    expect(
      await claimBalance(
        withoutFee.poolManager,
        withoutFee.feeVault,
        withoutFee.btc,
      ),
    ).to.equal(0n);
    expect(gross - net).to.equal(fee);
    expect(fee).to.equal((gross * BigInt(FEE_PIPS)) / BigInt(PIPS_DENOM));
  });

  it('charges the input side when the trade is the one pinning its output', async () => {
    const f = await deployOracleFixture();
    const [trader] = await hre.viem.getWalletClients();
    const zeroForOne = sellingStrat(f);

    // Exact output: the fee is in the input token.
    const spentBefore = await balanceOf(f.strat, trader.account.address);
    await swapExactOut({
      swapRouter: f.swapRouter,
      key: f.key,
      zeroForOne,
      amountOut: whole(f, !zeroForOne, TRADE),
    });
    const spent =
      spentBefore - (await balanceOf(f.strat, trader.account.address));

    const fee = await claimBalance(f.poolManager, f.feeVault, f.strat);
    expect(fee).to.not.equal(0n);
    expect(await claimBalance(f.poolManager, f.feeVault, f.btc)).to.equal(0n);

    const poolInput = spent - fee;
    expect(fee).to.equal((poolInput * BigInt(FEE_PIPS)) / BigInt(PIPS_DENOM));
  });

  it('charges nothing at all when the fee is zero', async () => {
    const f = await deployOracleFixture({ feePips: 0 });

    await swapExactIn({
      swapRouter: f.swapRouter,
      key: f.key,
      zeroForOne: sellingStrat(f),
      amountIn: whole(f, sellingStrat(f), TRADE),
    });

    expect(await claimBalance(f.poolManager, f.feeVault, f.btc)).to.equal(0n);
    expect(await claimBalance(f.poolManager, f.feeVault, f.strat)).to.equal(0n);
  });

  it('rounds a trade too small to owe a whole unit down to nothing', async () => {
    const f = await deployOracleFixture();
    const zeroForOne = !f.stratIsCurrency0; // buy STRAT, so the fee is in 18-decimal STRAT

    await swapExactIn({
      swapRouter: f.swapRouter,
      key: f.key,
      zeroForOne,
      amountIn: 1n,
    });

    expect(await claimBalance(f.poolManager, f.feeVault, f.strat)).to.equal(0n);
  });

  it('refuses a fee above the corridor, and a fee with nowhere to go', async () => {
    const [, , feeSink] = await hre.viem.getWalletClients();

    await expect(deployBare({ feePips: 10_001 })).to.be.rejected;
    await expect(deployBare({ feePips: 500, feeVault: ZERO })).to.be.rejected;

    await deployBare({ feePips: 10_000, feeVault: feeSink.account.address });
    await deployBare({ feePips: 0, feeVault: ZERO });
  });

  it('keeps the corridor and the charged fee visible on chain', async () => {
    const f = await deployBare();
    const hook = await hre.viem.getContractAt('StratPoolHook', f.hook);

    expect(await hook.read.FEE_PIPS()).to.equal(FEE_PIPS);
    expect(await hook.read.MAX_FEE_PIPS()).to.equal(10_000);
    expect(await hook.read.PIPS_DENOM()).to.equal(PIPS_DENOM);
    expect((await hook.read.FEE_VAULT()).toLowerCase()).to.equal(
      f.feeVault.toLowerCase(),
    );
  });
});
