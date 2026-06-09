import hre from 'hardhat';
import { deployUups } from '../_helpers';

export const WAD = 10n ** 18n;
export const BTC_UNIT = 10n ** 8n;

/// The contract's one-day epoch floor.
export const DEFAULT_EPOCH_DURATION = 24n * 3600n;
export const DEFAULT_EPOCH_RCAP = 2_000n * WAD;

export const DEFAULT_THF = WAD;

export const NAV_BTC_PER_STRAT = 100_000_000_000_000n;

export const USER_STAKE = 5_000n * WAD;

// Local mirror of the curve: net = NAV * THF * integral of max(0, 1 - (u / Rcap)^2) from R to R+x.

export function integralRateStrat(R: bigint, x: bigint, rcap: bigint): bigint {
  if (rcap === 0n || R >= rcap) return 0n;

  let end = R + x;
  if (end > rcap) end = rcap;

  const xEff = end > R ? end - R : 0n;
  if (xEff === 0n) return 0n;

  const t1 = (R * WAD) / rcap;
  const t2 = (end * WAD) / rcap;

  const dt = t2 - t1;
  const dCube = t2 * t2 * t2 - t1 * t1 * t1;

  const partA = (rcap * dt) / WAD;
  const partB = (rcap * dCube) / (3n * WAD * WAD * WAD);

  return partA > partB ? partA - partB : 0n;
}

export function expectedNetBtc(nav: bigint, thf: bigint, area: bigint): bigint {
  const btcAtNav = (area * nav) / WAD;
  return (btcAtNav * thf) / WAD;
}

export function expectedGrossBtc(nav: bigint, amount: bigint): bigint {
  return (amount * nav) / WAD;
}

export async function deployRedemptionFixture() {
  const clients = await hre.viem.getWalletClients();
  const [deployer, user, other] = clients;

  const strat = await hre.viem.deployContract('STRAT', [
    deployer.account.address, // holder (acts as treasury in these tests)
    50_000_000n * WAD,
  ]);

  const btc = await hre.viem.deployContract('MockERC20', ['cbBTC', 'cbBTC', 8]);

  const treasury = await hre.viem.deployContract('TreasuryMock');
  const staking = await hre.viem.deployContract('StakingMock', [
    deployer.account.address,
    strat.address,
  ]);

  const redemption = await deployUups('Redemption', [
    deployer.account.address, // owner_
    treasury.address, // treasury_
    staking.address, // staking_
    DEFAULT_EPOCH_DURATION, // epochDuration_
    DEFAULT_EPOCH_RCAP, // epochRcap_
  ]);

  await treasury.write.setNav([NAV_BTC_PER_STRAT], {
    account: deployer.account,
  });

  await treasury.write.setBTC([10n * WAD], {
    account: deployer.account,
  });

  await treasury.write.setBtcToken([btc.address], {
    account: deployer.account,
  });
  await treasury.write.setRedemption([redemption.address], {
    account: deployer.account,
  });
  await btc.write.mint([treasury.address, 10n * BTC_UNIT], {
    account: deployer.account,
  });

  // The Treasury settles redemptions, so it is the caller StakingMock accepts.
  await treasury.write.setStaking([staking.address], {
    account: deployer.account,
  });
  await staking.write.setRedemption([treasury.address], {
    account: deployer.account,
  });

  await strat.write.transfer([user.account.address, USER_STAKE], {
    account: deployer.account,
  });

  await strat.write.approve([staking.address, USER_STAKE], {
    account: user.account,
  });

  await staking.write.stake([USER_STAKE], {
    account: user.account,
  });

  return {
    deployer,
    user,
    other,
    strat,
    btc,
    treasury,
    staking,
    redemption,
  };
}
