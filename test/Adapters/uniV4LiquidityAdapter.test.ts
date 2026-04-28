import { expect } from 'chai';
import hre from 'hardhat';
import { type Address } from 'viem';

import {
  TICK_SPACING,
  balanceOf,
  deployVenue,
  swapExactIn,
  whole,
  type Venue,
} from './_venue';

const ZERO = '0x0000000000000000000000000000000000000000';

const deployAdapter = async (v: Venue, controller: Address) => {
  const adapter = await hre.viem.deployContract('UniV4LiquidityAdapter', [
    v.poolManager,
    v.stratBtc,
    controller,
  ]);

  for (const token of [v.strat.address, v.btc.address]) {
    const erc20 = await hre.viem.getContractAt('MockERC20Decimals', token);
    await erc20.write.approve([adapter.address, 2n ** 255n]);
  }
  return adapter;
};

const ordered = (v: Venue, stratAmount: bigint, btcAmount: bigint) =>
  v.stratBtc.currency0.toLowerCase() === v.strat.address.toLowerCase()
    ? ([stratAmount, btcAmount] as const)
    : ([btcAmount, stratAmount] as const);

/// The two sides are ten decimals and 50,000x apart, so size trades in STRAT terms.
const tradeIn = (v: Venue, spendsStrat: boolean, stratUnits: number): bigint =>
  spendsStrat
    ? whole(v.strat, stratUnits)
    : BigInt(stratUnits) * 2_000n; // 0.00002 cbBTC a STRAT, in raw 8-decimal units

describe('UniV4LiquidityAdapter — the position', () => {
  it('is bound to the pool it was given, at full range', async () => {
    const v = await deployVenue();
    const [deployer] = await hre.viem.getWalletClients();
    const adapter = await deployAdapter(v, deployer.account.address);

    expect((await adapter.read.token0()).toLowerCase()).to.equal(
      v.stratBtc.currency0.toLowerCase(),
    );
    expect((await adapter.read.token1()).toLowerCase()).to.equal(
      v.stratBtc.currency1.toLowerCase(),
    );
    expect(await adapter.read.TICK_SPACING()).to.equal(TICK_SPACING);

    expect(await adapter.read.TICK_LOWER()).to.equal(-887220);
    expect(await adapter.read.TICK_UPPER()).to.equal(887220);
    expect(await adapter.read.positionLiquidity()).to.equal(0n);
  });

  it('takes only what the liquidity costs and leaves the rest with the controller', async () => {
    const v = await deployVenue();
    const [deployer] = await hre.viem.getWalletClients();
    const controller = deployer.account.address;
    const adapter = await deployAdapter(v, controller);

    const [amount0, amount1] = ordered(
      v,
      whole(v.strat, 1_000_000),
      whole(v.btc, 1) / 10n,
    );

    const strat0 = await balanceOf(v.strat.address, controller);
    const btc0 = await balanceOf(v.btc.address, controller);

    await adapter.write.addLiquidity([amount0, amount1]);

    const spentStrat = strat0 - (await balanceOf(v.strat.address, controller));
    const spentBtc = btc0 - (await balanceOf(v.btc.address, controller));

    expect(await adapter.read.positionLiquidity()).to.not.equal(0n);
    expect(spentBtc > 0n).to.equal(true);
    // The cbBTC side binds.
    expect(spentStrat < whole(v.strat, 1_000_000)).to.equal(true);

    expect(await balanceOf(v.strat.address, adapter.address)).to.equal(0n);
    expect(await balanceOf(v.btc.address, adapter.address)).to.equal(0n);
  });

  it('reports what it actually pulled', async () => {
    const v = await deployVenue();
    const [deployer] = await hre.viem.getWalletClients();
    const controller = deployer.account.address;
    const adapter = await deployAdapter(v, controller);
    const publicClient = await hre.viem.getPublicClient();

    const [amount0, amount1] = ordered(
      v,
      whole(v.strat, 50_000),
      whole(v.btc, 1),
    );

    const before0 = await balanceOf(
      v.stratBtc.currency0 as Address,
      controller,
    );
    const hash = await adapter.write.addLiquidity([amount0, amount1]);
    await publicClient.waitForTransactionReceipt({ hash });
    const spent0 =
      before0 - (await balanceOf(v.stratBtc.currency0 as Address, controller));

    const logs = await publicClient.getContractEvents({
      address: adapter.address,
      abi: adapter.abi,
      eventName: 'LiquidityAdded',
    });
    const last = logs[logs.length - 1].args as {
      amount0: bigint;
      liquidity: bigint;
    };

    expect(last.amount0).to.equal(spent0);
    expect(last.liquidity > 0n).to.equal(true);
  });

  it('adds nothing when the offer is too small to make any liquidity', async () => {
    const v = await deployVenue();
    const [deployer] = await hre.viem.getWalletClients();
    const adapter = await deployAdapter(v, deployer.account.address);

    await adapter.write.addLiquidity([0n, 0n]);
    expect(await adapter.read.positionLiquidity()).to.equal(0n);
  });
});

describe('UniV4LiquidityAdapter — fees', () => {
  it('collects what the position earned, to the controller', async () => {
    const v = await deployVenue();
    const [deployer] = await hre.viem.getWalletClients();
    const controller = deployer.account.address;
    const adapter = await deployAdapter(v, controller);

    const [amount0, amount1] = ordered(
      v,
      whole(v.strat, 50_000),
      whole(v.btc, 1),
    );
    await adapter.write.addLiquidity([amount0, amount1]);

    for (const zeroForOne of [true, false, true]) {
      await swapExactIn({
        swapRouter: v.swapRouter,
        key: v.stratBtc,
        zeroForOne,
        amountIn: tradeIn(
          v,
          zeroForOne
            ? v.stratBtc.currency0.toLowerCase() ===
                v.strat.address.toLowerCase()
            : v.stratBtc.currency1.toLowerCase() ===
                v.strat.address.toLowerCase(),
          1_000,
        ),
      });
    }

    const strat0 = await balanceOf(v.strat.address, controller);
    const btc0 = await balanceOf(v.btc.address, controller);

    await adapter.write.collectFees([controller]);

    const gainedStrat = (await balanceOf(v.strat.address, controller)) - strat0;
    const gainedBtc = (await balanceOf(v.btc.address, controller)) - btc0;

    expect(gainedStrat > 0n).to.equal(true);
    expect(gainedBtc > 0n).to.equal(true);

    const strat1 = await balanceOf(v.strat.address, controller);
    await adapter.write.collectFees([controller]);
    expect(await balanceOf(v.strat.address, controller)).to.equal(strat1);

    expect(await adapter.read.positionLiquidity()).to.not.equal(0n);
  });
});

describe('UniV4LiquidityAdapter — access', () => {
  it('lets nobody but the controller add or collect', async () => {
    const v = await deployVenue();
    const [deployer, outsider] = await hre.viem.getWalletClients();
    const adapter = await deployAdapter(v, deployer.account.address);

    await expect(
      adapter.write.addLiquidity([1n, 1n], { account: outsider.account }),
    ).to.be.rejectedWith('NotController');

    await expect(
      adapter.write.collectFees([deployer.account.address], {
        account: outsider.account,
      }),
    ).to.be.rejectedWith('NotController');
  });

  it('refuses to send fees anywhere but the controller', async () => {
    const v = await deployVenue();
    const [deployer, outsider] = await hre.viem.getWalletClients();
    const adapter = await deployAdapter(v, deployer.account.address);

    await expect(
      adapter.write.collectFees([outsider.account.address]),
    ).to.be.rejectedWith('InvalidRecipient');
  });

  it('refuses an unlock callback that did not come from the pool manager', async () => {
    const v = await deployVenue();
    const [deployer] = await hre.viem.getWalletClients();
    const adapter = await deployAdapter(v, deployer.account.address);

    await expect(adapter.write.unlockCallback(['0x'])).to.be.rejectedWith(
      'NotPoolManager',
    );
  });

  it('refuses a zero manager or controller', async () => {
    const v = await deployVenue();
    const [deployer] = await hre.viem.getWalletClients();

    await expect(
      hre.viem.deployContract('UniV4LiquidityAdapter', [
        ZERO,
        v.stratBtc,
        deployer.account.address,
      ]),
    ).to.be.rejectedWith('AddressZero');

    await expect(
      hre.viem.deployContract('UniV4LiquidityAdapter', [
        v.poolManager,
        v.stratBtc,
        ZERO,
      ]),
    ).to.be.rejectedWith('AddressZero');
  });
});
