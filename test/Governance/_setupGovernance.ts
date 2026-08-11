import hre from 'hardhat';
import {
  encodeFunctionData,
  keccak256,
  toBytes,
  toFunctionSelector,
  zeroAddress,
  type Address,
} from 'viem';

export const WAD = 10n ** 18n;
export const STRAT_MAX_SUPPLY = 50_000_000n * WAD;

export const PARAMS_DELAY = 60n; // params timelock, seconds
export const UPGRADE_DELAY = 120n; // upgrade timelock, seconds
export const GUARDIAN_PERIOD = 365n * 24n * 3600n;
/// Zero here; the lookback has its own suite.
export const VOTE_LOOKBACK = 0n;
export const LATE_QUORUM_EXTENSION = 0;

// Seconds, not blocks; Hardhat mines one second per block.
export const VOTING_DELAY = 1;
export const VOTING_PERIOD = 10;
export const PROPOSAL_THRESHOLD = 0n;
export const QUORUM_VOTES = 1_000n * WAD;
export const UPGRADE_QUORUM_VOTES = 2_000n * WAD;
export const SIMPLE_MAJORITY_BPS = 5_001n;
export const SUPERMAJORITY_BPS = 6_667n;

export const THF_MIN = WAD / 5n; // 0.2
export const THF_MAX = WAD; // 1.0
export const THF_MAX_TIME = 1_000n;
export const UNSTAKE_COOLDOWN = 600n;

export enum ProposalState {
  Pending,
  Active,
  Canceled,
  Defeated,
  Succeeded,
  Queued,
  Expired,
  Executed,
}

export enum Phase {
  Genesis,
  Dao,
}

export const VOTE_AGAINST = 0;
export const VOTE_FOR = 1;
export const VOTE_ABSTAIN = 2;

export const mineBlocks = async (n: number): Promise<void> => {
  await hre.network.provider.send('hardhat_mine', ['0x' + n.toString(16)]);
};

export const increaseTime = async (seconds: bigint): Promise<void> => {
  await hre.network.provider.send('evm_increaseTime', [Number(seconds)]);
  await hre.network.provider.send('evm_mine');
};

export const impersonate = async (address: Address): Promise<Address> => {
  await hre.network.provider.send('hardhat_impersonateAccount', [address]);
  await hre.network.provider.send('hardhat_setBalance', [
    address,
    '0x' + (100n * WAD).toString(16),
  ]);
  return address;
};

export const descriptionHash = (description: string) =>
  keccak256(toBytes(description));

/// Control layer in Genesis: Staking, two timelocks, two governors and the authority.
export async function deployGovernanceFixture(
  opts: { guardian?: Address } = {},
) {
  const clients = await hre.viem.getWalletClients();
  const [deployer, admin, user1, user2, other, guardianSigner] = clients;
  const publicClient = await hre.viem.getPublicClient();

  const guardian = opts.guardian ?? guardianSigner.account.address;

  const strat = await hre.viem.deployContract('STRAT', [
    deployer.account.address,
    STRAT_MAX_SUPPLY,
  ]);

  const staking = await hre.viem.deployContract('Staking', [
    deployer.account.address,
    strat.address,
    deployer.account.address, // premium reserve
    THF_MIN,
    THF_MAX,
    THF_MAX_TIME,
    UNSTAKE_COOLDOWN,
  ]);

  const paramsTimelock = await hre.viem.deployContract('StratTimelock', [
    PARAMS_DELAY,
    [],
    [],
    deployer.account.address,
  ]);
  const upgradeTimelock = await hre.viem.deployContract('StratTimelock', [
    UPGRADE_DELAY,
    [],
    [],
    deployer.account.address,
  ]);

  const authority = await hre.viem.deployContract('ProtocolAuthority', [
    admin.account.address,
    paramsTimelock.address,
    upgradeTimelock.address,
    guardian,
    GUARDIAN_PERIOD,
  ]);

  const paramsGovernor = await hre.viem.deployContract('StratGovernor', [
    'STRAT Governor',
    strat.address,
    paramsTimelock.address,
    authority.address,
    VOTING_DELAY,
    VOTING_PERIOD,
    PROPOSAL_THRESHOLD,
    QUORUM_VOTES,
    QUORUM_VOTES,
    SIMPLE_MAJORITY_BPS,
    VOTE_LOOKBACK,
    LATE_QUORUM_EXTENSION,
  ]);
  const upgradeGovernor = await hre.viem.deployContract('StratGovernor', [
    'STRAT Upgrade Governor',
    strat.address,
    upgradeTimelock.address,
    authority.address,
    VOTING_DELAY,
    VOTING_PERIOD,
    PROPOSAL_THRESHOLD,
    UPGRADE_QUORUM_VOTES,
    UPGRADE_QUORUM_VOTES,
    SUPERMAJORITY_BPS,
    VOTE_LOOKBACK,
    LATE_QUORUM_EXTENSION,
  ]);

  const PROPOSER_ROLE = await paramsTimelock.read.PROPOSER_ROLE();
  const CANCELLER_ROLE = await paramsTimelock.read.CANCELLER_ROLE();
  const EXECUTOR_ROLE = await paramsTimelock.read.EXECUTOR_ROLE();
  const ADMIN_ROLE = await paramsTimelock.read.DEFAULT_ADMIN_ROLE();

  // Mirrors deploy.ts role wiring.
  for (const [timelock, governor, isParams] of [
    [paramsTimelock, paramsGovernor, true],
    [upgradeTimelock, upgradeGovernor, false],
  ] as const) {
    await timelock.write.grantRole([PROPOSER_ROLE, governor.address]);
    await timelock.write.grantRole([CANCELLER_ROLE, governor.address]);
    await timelock.write.grantRole([EXECUTOR_ROLE, zeroAddress]);
    await timelock.write.grantRole([CANCELLER_ROLE, authority.address]);
    if (isParams) {
      await timelock.write.grantRole([ADMIN_ROLE, upgradeTimelock.address]);
    }
    await timelock.write.renounceRole([ADMIN_ROLE, deployer.account.address]);
  }

  await staking.write.transferOwnership([authority.address]);
  await authority.write.execute(
    [
      staking.address,
      encodeFunctionData({
        abi: staking.abi,
        functionName: 'acceptOwnership',
        args: [],
      }),
    ],
    { account: admin.account },
  );

  // One allowlisted call; tests rely on everything else being upgrade-only.
  await authority.write.allowParams(
    [
      staking.address,
      toFunctionSelector(
        staking.abi.find(
          (entry) => entry.type === 'function' && entry.name === 'setThfParams',
        ) as never,
      ),
    ],
    { account: admin.account },
  );

  for (const u of [user1, user2, other]) {
    await strat.write.transfer([u.account.address, 100_000n * WAD], {
      account: deployer.account,
    });
    await strat.write.approve([staking.address, 100_000n * WAD], {
      account: u.account,
    });
  }

  const encodeSetThfParams = (
    thfMin: bigint,
    thfMax: bigint,
    thfMaxTime: bigint,
  ) =>
    encodeFunctionData({
      abi: staking.abi,
      functionName: 'setThfParams',
      args: [thfMin, thfMax, thfMaxTime],
    });

  const encodeAuthorityExecute = (target: Address, data: `0x${string}`) =>
    encodeFunctionData({
      abi: authority.abi,
      functionName: 'execute',
      args: [target, data],
    });

  const activateDaoPhase = async () => {
    await authority.write.finalizeGenesis({ account: admin.account });
  };

  return {
    publicClient,
    deployer,
    admin,
    user1,
    user2,
    other,
    guardianSigner,
    guardian,
    strat,
    staking,
    paramsTimelock,
    upgradeTimelock,
    authority,
    paramsGovernor,
    upgradeGovernor,
    guardianPeriod: GUARDIAN_PERIOD,
    encodeSetThfParams,
    encodeAuthorityExecute,
    activateDaoPhase,
  };
}
