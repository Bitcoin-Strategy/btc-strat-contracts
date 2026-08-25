import { expect } from 'chai';
import hre from 'hardhat';

import { deployTreasuryContract } from '../Treasury/_setupTreasury';

const WAD = 10n ** 18n;
const STAKED = 1_000n * WAD;

/// The preview must gate on the staked position, not the wallet.
describe('ProtocolReader — redemption preview is gated on the stake (unit)', () => {
  const setup = async () => {
    const [deployer, user] = await hre.viem.getWalletClients();

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
    const vvest = await hre.viem.deployContract('MockERC20', [
      'VVEST',
      'VVEST',
      18,
    ]);

    const treasury = await deployTreasuryContract(
      deployer.account.address,
      btc.address,
      strat.address,
    );
    await btc.write.mint([treasury.address, 2n * 10n ** 8n]);
    await strat.write.mint([deployer.account.address, 1_000_000n * WAD]);

    const vestingVault = await hre.viem.deployContract('VestingMock', []);
    const staking = await hre.viem.deployContract('StakingMock', [
      deployer.account.address,
      strat.address,
    ]);
    const redemption = await hre.viem.deployContract('RedemptionMock', [
      staking.address,
    ]);

    const reader = await hre.viem.deployContract('ProtocolReader', [
      treasury.address,
      vestingVault.address,
      staking.address,
      redemption.address,
      strat.address,
      vvest.address,
      btc.address,
      strat.address,
      strat.address,
      strat.address,
      strat.address,
    ]);

    await staking.write.mockSetStake([user.account.address, STAKED, 1n]);
    await redemption.write.mockSetPreview([
      user.account.address,
      7n * WAD, // grossBtc
      1n * WAD, // basePenaltyBtc
      1n * WAD, // effPenaltyBtc
      0n, // thfBonusBtc
      6n * WAD, // netBtc
      WAD, // timeHeldFactor
      42n, // epoch
      100n * WAD, // remainingRcap
    ]);

    return { deployer, user, reader, strat };
  };

  it('previews an amount the user has staked, with an empty wallet', async () => {
    const { user, reader, strat } = await setup();

    expect(await strat.read.balanceOf([user.account.address])).to.equal(0n);

    const data = await reader.read.getRedemptionData([
      user.account.address,
      STAKED,
    ]);
    expect(data.userStakedBalance).to.equal(STAKED);
    expect(data.userStratBalance).to.equal(0n);
    expect(data.netBtc).to.equal(6n * WAD);
    expect(data.grossBtc).to.equal(7n * WAD);
    expect(data.epoch).to.equal(42n);
    expect(data.remainingRcap).to.equal(100n * WAD);
  });

  it('returns zeros for an amount above the stake, and still reports the stake', async () => {
    const { user, reader } = await setup();

    const data = await reader.read.getRedemptionData([
      user.account.address,
      STAKED + 1n,
    ]);
    expect(data.userStakedBalance).to.equal(STAKED);
    expect(data.netBtc).to.equal(0n);
    expect(data.grossBtc).to.equal(0n);
    expect(data.epoch).to.equal(0n);
    expect(data.remainingRcap).to.equal(0n);
  });

  it('returns zeros for a zero amount', async () => {
    const { user, reader } = await setup();

    const data = await reader.read.getRedemptionData([
      user.account.address,
      0n,
    ]);
    expect(data.userStakedBalance).to.equal(STAKED);
    expect(data.netBtc).to.equal(0n);
  });

  it('gates the same way inside getAllUserData', async () => {
    const { user, reader } = await setup();

    const [, , , ok] = await reader.read.getAllUserData([
      user.account.address,
      STAKED,
    ]);
    expect(ok.userStakedBalance).to.equal(STAKED);
    expect(ok.userStratBalance).to.equal(0n);
    expect(ok.netBtc).to.equal(6n * WAD);

    const [, , , tooMuch] = await reader.read.getAllUserData([
      user.account.address,
      STAKED + 1n,
    ]);
    expect(tooMuch.userStakedBalance).to.equal(STAKED);
    expect(tooMuch.netBtc).to.equal(0n);
  });

  it('shows nothing to a user with no stake, however much STRAT the wallet holds', async () => {
    const { deployer, reader, strat } = await setup();

    const wallet = await strat.read.balanceOf([deployer.account.address]);
    expect(wallet > 0n).to.equal(true);

    const data = await reader.read.getRedemptionData([
      deployer.account.address,
      WAD,
    ]);
    expect(data.userStakedBalance).to.equal(0n);
    expect(data.netBtc).to.equal(0n);
  });
});
