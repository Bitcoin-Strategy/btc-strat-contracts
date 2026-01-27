import { expect } from 'chai';
import hre from 'hardhat';
import {
  deployTreasuryFixture,
  wireRedemption,
  OUTFLOW_WINDOW,
  BTC_DECIMALS,
} from './_setupTreasury';

const BPS = 10_000n;

describe('Treasury — outflow surface', () => {
  it('the owner has no function that spends the balance', async () => {
    const { treasury } = await deployTreasuryFixture();

    const spenders = treasury.abi
      .filter(
        (f: any) =>
          f.type === 'function' &&
          f.stateMutability !== 'view' &&
          f.stateMutability !== 'pure',
      )
      .map((f: any) => f.name as string);

    expect(spenders.filter((n) => /^send/.test(n)).sort()).to.deep.equal([
      'sendStrat',
    ]);
    expect(spenders).to.include('redeem');

    expect(
      spenders.some((n) => /swap|convert|flush|rescue|withdraw/i.test(n)),
    ).to.equal(false);
    expect(treasury.abi.some((f: any) => f.name === 'swapRouter')).to.equal(
      false,
    );
    expect(
      treasury.abi.some((f: any) => /bondSwap/i.test(f.name ?? '')),
    ).to.equal(false);
  });

  it('the metered path refuses anything past the immutable ceiling', async () => {
    const { deployer, treasury, btc, strat } = await deployTreasuryFixture();
    const { payBtc } = await wireRedemption(treasury, strat);

    const held = 10n * BTC_DECIMALS;
    await btc.write.mint([treasury.address, held]);

    const budget = (held * 2_000n) / BPS;
    expect(await treasury.read.remainingBtcOutflow()).to.equal(budget);

    await expect(payBtc((budget + 1n) * 10n ** 10n)).to.be.rejectedWith(
      'OutflowCapExceeded',
    );

    await expect(
      treasury.write.setBtcOutflowBps([10_000], { account: deployer.account }),
    ).to.be.rejectedWith('OutflowRateAboveCeiling');
  });

  it('the bucket has no boundary to straddle: a second capacity has to be earned', async () => {
    const { deployer, treasury, btc, strat } = await deployTreasuryFixture();
    const { payBtc } = await wireRedemption(treasury, strat);

    const held = 100n * BTC_DECIMALS;
    await btc.write.mint([treasury.address, held]);

    // Where an aligned window used to roll; a bucket has nothing to reset.
    const publicClient = await hre.viem.getPublicClient();
    const now = BigInt((await publicClient.getBlock()).timestamp);
    const w = BigInt(OUTFLOW_WINDOW);
    const boundary = (now / w + 1n) * w;

    await hre.network.provider.send('evm_setNextBlockTimestamp', [
      // payBtc spans two blocks, so start a little earlier.
      Number(boundary - 4n),
    ]);
    await hre.network.provider.send('evm_mine');

    const first = await treasury.read.remainingBtcOutflow();
    expect(first).to.equal((held * 2_000n) / BPS);

    await payBtc(first * 10n ** 10n);
    expect(await treasury.read.remainingBtcOutflow()).to.equal(0n);

    await hre.network.provider.send('evm_setNextBlockTimestamp', [
      Number(boundary),
    ]);
    await hre.network.provider.send('evm_mine');

    // A second of refill is dust, not a fresh budget.
    const second = await treasury.read.remainingBtcOutflow();
    const capacityNow = ((held - first) * 2_000n) / BPS;
    expect(second * 1_000n < capacityNow, 'a rounding error, not a budget').to.equal(true);

    const drained = first + second;
    expect(
      (drained * BPS) / held <= 2_000n,
      'still inside the stated ceiling',
    ).to.equal(true);
  });

  it('refills linearly, and never past one capacity however long the wait', async () => {
    const { deployer, treasury, btc, strat } = await deployTreasuryFixture();
    const { payBtc } = await wireRedemption(treasury, strat);

    const held = 100n * BTC_DECIMALS;
    await btc.write.mint([treasury.address, held]);

    const capacity = (held * 2_000n) / BPS;
    await payBtc(capacity * 10n ** 10n);
    expect(await treasury.read.remainingBtcOutflow()).to.equal(0n);

    await hre.network.provider.send('evm_increaseTime', [
      Number(BigInt(OUTFLOW_WINDOW) / 2n),
    ]);
    await hre.network.provider.send('evm_mine');

    const remainingHeld = held - capacity;
    const capacityNow = (remainingHeld * 2_000n) / BPS;
    const half = await treasury.read.remainingBtcOutflow();
    expect(half > 0n).to.equal(true);
    expect(half < capacityNow).to.equal(true);

    // The bucket stops at one capacity.
    await hre.network.provider.send('evm_increaseTime', [
      Number(BigInt(OUTFLOW_WINDOW) * 10n),
    ]);
    await hre.network.provider.send('evm_mine');
    expect(await treasury.read.remainingBtcOutflow()).to.equal(capacityNow);
  });
});
