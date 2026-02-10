import hre from 'hardhat';
import type { Address } from 'viem';

export const UNSTAKE_COOLDOWN = 7n * 24n * 3600n;

export const WAD = 10n ** 18n;
export const STRAT_MAX_SUPPLY = 50_000_000n * WAD;

export type StakeData = {
  position: { amount: bigint; start: bigint };
  factor: bigint;
};

export type StakingFixture = {
  deployer: any;
  treasury: any;
  user: any;
  strat: any;
  staking: any;

  thfMin: bigint;
  thfMax: bigint;
  thfMaxTime: bigint;

  fundUser: (amount?: bigint) => Promise<void>;
  approveUser: (amount?: bigint) => Promise<void>;
  stakeAsUser: (amount: bigint) => Promise<void>;
  getStake: (address: Address) => Promise<StakeData>;
};

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export const deployStrat = async (treasury: Address, _other?: Address) =>
  hre.viem.deployContract('STRAT', [treasury, STRAT_MAX_SUPPLY]);

export const deployStakingFixture = async (): Promise<StakingFixture> => {
  const clients = await hre.viem.getWalletClients();

  const deployer = clients[0];
  const treasury = clients[1];
  const user = clients[2];

  const thfMin = (WAD * 20n) / 100n; // 0.20
  const thfMax = WAD; // 1.00 (contract caps thfMax at WAD)
  const thfMaxTime = 1000n; // seconds

  const strat = await deployStrat(
    treasury.account.address as Address,
    deployer.account.address as Address,
  );

  const staking = await hre.viem.deployContract('Staking', [
    deployer.account.address as Address,
    strat.address as Address,
    treasury.account.address as Address,
    thfMin,
    thfMax,
    thfMaxTime,
    UNSTAKE_COOLDOWN,
  ]);

  const fundUser = async (amount: bigint = 10_000n * WAD): Promise<void> => {
    await strat.write.transfer([user.account.address as Address, amount], {
      account: treasury.account,
    });
  };

  const approveUser = async (amount: bigint = 10_000n * WAD): Promise<void> => {
    await strat.write.approve([staking.address as Address, amount], {
      account: user.account,
    });
  };

  const stakeAsUser = async (amount: bigint): Promise<void> => {
    await staking.write.stake([amount], { account: user.account });
  };

  const getStake = async (address: Address): Promise<StakeData> => {
    const [position, factor] = await staking.read.getStake([address]);
    return { position, factor };
  };

  await fundUser();
  await approveUser();

  return {
    deployer,
    treasury,
    user,
    strat,
    staking,
    thfMin,
    thfMax,
    thfMaxTime,
    fundUser,
    approveUser,
    stakeAsUser,
    getStake,
  };
};
