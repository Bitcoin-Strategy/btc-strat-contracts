import { expect } from 'chai';
import hre from 'hardhat';
import { deployTreasuryContract } from './_setupTreasury';

const WAD = 10n ** 18n;
const BTC_DECIMALS = 10n ** 8n;

describe('Treasury — Balance Handling', () => {
  const setup = async () => {
    const clients = await hre.viem.getWalletClients();
    const deployer = clients[0];
    const user = clients[1];

    const btc = await hre.viem.deployContract('MockERC20', [
      'cbBTC',
      'cbBTC',
      8,
    ]);
    const strat = await hre.viem.deployContract('MockERC20', [
      'STRAT',
      'STRAT',
      18,
    ]);

    const treasury = await deployTreasuryContract(
      deployer.account.address,
      btc.address,
      strat.address,
    );

    return { deployer, user, btc, strat, treasury };
  };

  it('tracks the raw BTC balance', async () => {
    const { user, btc, treasury } = await setup();

    await btc.write.mint([user.account.address, 5n * BTC_DECIMALS]);
    await btc.write.transfer([treasury.address, 2n * BTC_DECIMALS], {
      account: user.account,
    });

    expect(await treasury.read.btcBalance()).to.equal(2n * BTC_DECIMALS);
  });

  /// Other tokens are not backing and have no way out.
  it('counts no asset but BTC, even when another token sits on the address', async () => {
    const { user, treasury } = await setup();

    const stray = await hre.viem.deployContract('MockERC20', [
      'Stray',
      'STRAY',
      6,
    ]);
    await stray.write.mint([user.account.address, 100_000n * 10n ** 6n]);
    await stray.write.transfer([treasury.address, 50_000n * 10n ** 6n], {
      account: user.account,
    });

    expect(await stray.read.balanceOf([treasury.address])).to.equal(
      50_000n * 10n ** 6n,
    );
    expect(await treasury.read.treasuryBtc()).to.equal(0n);
    expect(await treasury.read.btcBalance()).to.equal(0n);
  });

  it('treasuryBtc() normalizes the 8-decimal balance to BTC WAD', async () => {
    const { user, btc, treasury } = await setup();

    await btc.write.mint([user.account.address, 1n * BTC_DECIMALS]);
    await btc.write.transfer([treasury.address, 1n * BTC_DECIMALS], {
      account: user.account,
    });

    expect(await treasury.read.treasuryBtc()).to.equal(1n * WAD);
  });

  /// At deployment nothing is sold, so NAV must answer instead of dividing by zero.
  it('reports no backing and no NAV while the whole supply is still dormant', async () => {
    const { btc, strat, treasury } = await setup();

    await strat.write.transfer([treasury.address, await strat.read.totalSupply()]);
    await btc.write.mint([treasury.address, 10n * BTC_DECIMALS]);

    expect(await treasury.read.backingSupply()).to.equal(0n);
    expect(await treasury.read.navBtcPerStrat()).to.equal(0n);
    expect(await treasury.read.redeemCapacity()).to.equal(0n);
  });

  it('counts only what has left the Treasury, token by token', async () => {
    const { user, btc, strat, treasury } = await setup();

    const supply = await strat.read.totalSupply();
    await strat.write.transfer([treasury.address, supply]);
    await btc.write.mint([treasury.address, 4n * BTC_DECIMALS]);
    expect(await treasury.read.backingSupply()).to.equal(0n);

    // Fresh STRAT to a holder: all of it counts.
    await strat.write.mint([user.account.address, 1_000n * WAD]);
    expect(await treasury.read.backingSupply()).to.equal(1_000n * WAD);
    expect(await treasury.read.navBtcPerStrat()).to.equal(
      (4n * WAD * WAD) / (1_000n * WAD),
    );

    await strat.write.transfer([treasury.address, 500n * WAD], {
      account: user.account,
    });
    expect(await treasury.read.backingSupply()).to.equal(500n * WAD);
  });

  it('emits TreasuryUpdated when syncTreasury() is called', async () => {
    const { user, btc, treasury } = await setup();

    await btc.write.mint([user.account.address, 3n * BTC_DECIMALS]);
    await btc.write.transfer([treasury.address, 3n * BTC_DECIMALS], {
      account: user.account,
    });

    const txHash = await treasury.write.syncTreasury({ account: user.account });

    const publicClient = await hre.viem.getPublicClient();
    const receipt = await publicClient.waitForTransactionReceipt({
      hash: txHash,
    });

    const events = await treasury.getEvents.TreasuryUpdated({
      fromBlock: receipt.blockNumber,
      toBlock: receipt.blockNumber,
    });

    expect(events.length).to.equal(1);
    expect(events[0].args.btcBalance).to.equal(3n * BTC_DECIMALS);
  });
});
