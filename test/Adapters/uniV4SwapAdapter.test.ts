import { expect } from 'chai';
import hre from 'hardhat';
import { type Address } from 'viem';

import { balanceOf, deployVenue, hop, whole, type Venue } from './_venue';

const ZERO = '0x0000000000000000000000000000000000000000';

const deployAdapter = async (v: Venue) =>
  hre.viem.deployContract('UniV4SwapAdapter', [
    v.poolManager,
    [v.btc.address, v.strat.address],
    [v.strat.address, v.btc.address],
    [
      [hop(v.stratBtc, v.btc.address)],
      [hop(v.stratBtc, v.strat.address)],
    ],
  ]);

/// Multi-hop STRAT -> MID -> cbBTC: unused by the protocol but still supported.
const deployMultiHopAdapter = async (v: Venue) =>
  hre.viem.deployContract('UniV4SwapAdapter', [
    v.poolManager,
    [v.strat.address],
    [v.btc.address],
    [[hop(v.stratMid, v.strat.address), hop(v.midBtc, v.mid.address)]],
  ]);

describe('UniV4SwapAdapter — routing', () => {
  it('swaps a single hop and delivers the output to the recipient', async () => {
    const v = await deployVenue();
    const [, recipient] = await hre.viem.getWalletClients();
    const adapter = await deployAdapter(v);

    const btc = await hre.viem.getContractAt(
      'MockERC20Decimals',
      v.btc.address,
    );
    const amountIn = whole(v.btc, 1);
    await btc.write.approve([adapter.address, amountIn]);

    await adapter.write.swap([
      v.btc.address,
      v.strat.address,
      amountIn,
      0n,
      recipient.account.address,
    ]);

    const received = await balanceOf(
      v.strat.address,
      recipient.account.address,
    );
    const expected = whole(v.strat, 50_000);
    expect(received > (expected * 95n) / 100n).to.equal(true);
    expect(received < expected).to.equal(true);

    expect(await balanceOf(v.btc.address, adapter.address)).to.equal(0n);
    expect(await balanceOf(v.strat.address, adapter.address)).to.equal(0n);
  });

  it('swaps the other way through the same pool', async () => {
    const v = await deployVenue();
    const [, recipient] = await hre.viem.getWalletClients();
    const adapter = await deployAdapter(v);

    const strat = await hre.viem.getContractAt(
      'MockERC20Decimals',
      v.strat.address,
    );
    const amountIn = whole(v.strat, 50_000);
    await strat.write.approve([adapter.address, amountIn]);

    await adapter.write.swap([
      v.strat.address,
      v.btc.address,
      amountIn,
      0n,
      recipient.account.address,
    ]);

    const received = await balanceOf(v.btc.address, recipient.account.address);
    const expected = whole(v.btc, 1);
    expect(received > (expected * 95n) / 100n).to.equal(true);
    expect(received < expected).to.equal(true);
  });

  it('routes two hops through the intermediate currency without ever moving it', async () => {
    const v = await deployVenue();
    const [, recipient] = await hre.viem.getWalletClients();
    const adapter = await deployMultiHopAdapter(v);

    const strat = await hre.viem.getContractAt(
      'MockERC20Decimals',
      v.strat.address,
    );
    const amountIn = whole(v.strat, 5_000);
    await strat.write.approve([adapter.address, amountIn]);

    const managerMidBefore = await balanceOf(v.mid.address, v.poolManager);

    await adapter.write.swap([
      v.strat.address,
      v.btc.address,
      amountIn,
      0n,
      recipient.account.address,
    ]);

    const received = await balanceOf(v.btc.address, recipient.account.address);
    const expected = (whole(v.btc, 1) * 10n) / 100n;
    expect(received > (expected * 90n) / 100n).to.equal(true);

    // The intermediate leg netted to zero inside the unlock.
    expect(await balanceOf(v.mid.address, v.poolManager)).to.equal(
      managerMidBefore,
    );
    expect(await balanceOf(v.mid.address, adapter.address)).to.equal(0n);
  });

  it('exposes the hops it was built with', async () => {
    const v = await deployVenue();
    const adapter = await deployAdapter(v);
    const multiHop = await deployMultiHopAdapter(v);

    const hops = (await adapter.read.routeHops([
      v.strat.address,
      v.btc.address,
    ])) as readonly { zeroForOne: boolean }[];
    expect(hops.length).to.equal(1);

    expect(
      (
        (await multiHop.read.routeHops([
          v.strat.address,
          v.btc.address,
        ])) as readonly { zeroForOne: boolean }[]
      ).length,
    ).to.equal(2);

    expect(
      ((await adapter.read.routeHops([v.btc.address, v.mid.address])) as [])
        .length,
    ).to.equal(0);
  });
});

describe('UniV4SwapAdapter — what it refuses', () => {
  it('refuses a pair it has no route for', async () => {
    const v = await deployVenue();
    const [, recipient] = await hre.viem.getWalletClients();
    const adapter = await deployAdapter(v);

    await expect(
      adapter.write.swap([
        v.btc.address,
        v.mid.address,
        1n,
        0n,
        recipient.account.address,
      ]),
    ).to.be.rejectedWith('NoRoute');
  });

  it('holds the swap to the floor the caller passed in', async () => {
    const v = await deployVenue();
    const [, recipient] = await hre.viem.getWalletClients();
    const adapter = await deployAdapter(v);

    const btc = await hre.viem.getContractAt(
      'MockERC20Decimals',
      v.btc.address,
    );
    const amountIn = whole(v.btc, 1);
    await btc.write.approve([adapter.address, amountIn * 2n]);

    await expect(
      adapter.write.swap([
        v.btc.address,
        v.strat.address,
        amountIn,
        whole(v.strat, 100_000),
        recipient.account.address,
      ]),
    ).to.be.rejectedWith('InsufficientOutput');

    await adapter.write.swap([
      v.btc.address,
      v.strat.address,
      amountIn,
      0n,
      recipient.account.address,
    ]);
  });

  it('refuses a route whose hops do not chain together', async () => {
    const v = await deployVenue();

    await expect(
      hre.viem.deployContract('UniV4SwapAdapter', [
        v.poolManager,
        [v.strat.address],
        [v.btc.address],
        [[hop(v.midBtc, v.mid.address)]],
      ]),
    ).to.be.rejectedWith('RouteNotConnected');

    await expect(
      hre.viem.deployContract('UniV4SwapAdapter', [
        v.poolManager,
        [v.strat.address],
        [v.btc.address],
        [[hop(v.stratMid, v.strat.address)]],
      ]),
    ).to.be.rejectedWith('RouteNotConnected');
  });

  it('refuses empty or mismatched route arrays, and a zero manager', async () => {
    const v = await deployVenue();

    await expect(
      hre.viem.deployContract('UniV4SwapAdapter', [
        ZERO,
        [v.btc.address],
        [v.strat.address],
        [[hop(v.stratBtc, v.btc.address)]],
      ]),
    ).to.be.rejectedWith('AddressZero');

    await expect(
      hre.viem.deployContract('UniV4SwapAdapter', [
        v.poolManager,
        [v.btc.address],
        [v.strat.address, v.mid.address],
        [[hop(v.stratBtc, v.btc.address)]],
      ]),
    ).to.be.rejectedWith('InvalidRoutes');

    await expect(
      hre.viem.deployContract('UniV4SwapAdapter', [
        v.poolManager,
        [v.btc.address],
        [v.strat.address],
        [[]],
      ]),
    ).to.be.rejectedWith('InvalidRoutes');
  });

  it('refuses an unlock callback that did not come from the pool manager', async () => {
    const v = await deployVenue();
    const adapter = await deployAdapter(v);

    await expect(adapter.write.unlockCallback(['0x'])).to.be.rejectedWith(
      'NotPoolManager',
    );
  });
});

describe('UniV4SwapAdapter — through a hooked pool', () => {
  it('receives the output net of whatever the pool hook kept', async () => {
    // The hook takes its fee from the unspecified currency; the adapter must report what is left.
    const { deployOracleFixture } = await import('../Oracle/_v4');
    const f = await deployOracleFixture({ forceStratCurrency0: true });
    const [, recipient] = await hre.viem.getWalletClients();

    const adapter = await hre.viem.deployContract('UniV4SwapAdapter', [
      f.poolManager,
      [f.strat],
      [f.btc],
      [[{ key: f.key, zeroForOne: true }]],
    ]);

    const strat = await hre.viem.getContractAt('MockERC20Decimals', f.strat);
    const amountIn = 1_000n * 10n ** 18n;
    await strat.write.approve([adapter.address, amountIn]);

    await adapter.write.swap([
      f.strat,
      f.btc,
      amountIn,
      0n,
      recipient.account.address,
    ]);

    const received = await balanceOf(f.btc, recipient.account.address);
    expect(received > 0n).to.equal(true);

    const { claimBalance } = await import('../Oracle/_v4');
    expect(
      await claimBalance(f.poolManager, f.feeVault as Address, f.btc),
    ).to.not.equal(0n);
    expect(await balanceOf(f.btc, adapter.address)).to.equal(0n);
  });
});
