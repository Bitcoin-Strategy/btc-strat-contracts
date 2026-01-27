import hre from 'hardhat';
import type { Address } from 'viem';

export const WAD = 10n ** 18n;
export const BTC_DECIMALS = 10n ** 8n;

export const OUTFLOW_WINDOW = 7 * 24 * 3600;
export const MAX_BTC_OUTFLOW_BPS = 2_000;
export const MAX_STRAT_OUTFLOW_BPS = 1_000;

export type TreasuryFixture = {
  deployer: any;
  user: any;
  btc: any;
  strat: any;
  authority: any;
  treasury: any;
};

/// Genesis is finalized by default; pass `finalized: false` to test the gate.
export const deployTreasuryContract = async (
  owner: Address,
  btc: Address,
  strat: Address,
  opts: {
    finalized?: boolean;
    outflowWindow?: number;
    maxBtcOutflowBps?: number;
    maxStratOutflowBps?: number;
    redemptionDelay?: number;
    maxRedeemBpsPerWindow?: number;
    authority?: Address;
  } = {},
) => {
  let authorityAddress = opts.authority;
  if (!authorityAddress) {
    const authority = await hre.viem.deployContract('AuthorityMock', []);
    if (opts.finalized !== false) {
      await authority.write.setGenesisFinalized([true]);
    }
    authorityAddress = authority.address;
  }

  return hre.viem.deployContract('Treasury', [
    owner,
    authorityAddress,
    btc,
    strat,
    opts.outflowWindow ?? OUTFLOW_WINDOW,
    opts.maxBtcOutflowBps ?? MAX_BTC_OUTFLOW_BPS,
    opts.maxStratOutflowBps ?? MAX_STRAT_OUTFLOW_BPS,
    opts.redemptionDelay ?? 0,
    opts.maxRedeemBpsPerWindow ?? MAX_REDEEM_BPS_PER_WINDOW,
  ]);
};

/// The whole supply per window, for the BTC bucket tests.
export const MAX_REDEEM_BPS_PER_WINDOW = 10_000;

export const MAX_PAYOUT_BPS = 9_500n;

export type RedemptionWiring = {
  quote: any;
  staking: any;
  reserve: Address;
  staker: any;
  payBtc: (btcWad: bigint, opts?: { minNetBtc?: bigint }) => Promise<unknown>;
};

/// Wires a quote module standing in for Redemption and a StakingMock. Redemption and staking must be unwired.
export const wireRedemption = async (
  treasury: any,
  strat: any,
  opts: { stakerStrat?: bigint } = {},
): Promise<RedemptionWiring> => {
  const clients = await hre.viem.getWalletClients();
  const deployer = clients[0];
  const staker = clients[8];
  const reserve = clients[9].account.address as Address;

  const quote = await hre.viem.deployContract('RedemptionQuoteMock', []);
  const staking = await hre.viem.deployContract('StakingMock', [
    deployer.account.address,
    strat.address,
  ]);
  await staking.write.setTreasury([reserve]);
  await staking.write.setRedemption([treasury.address]);

  await treasury.write.setRedemptionContract([quote.address]);
  await treasury.write.setStakingOnce([staking.address]);

  // MockERC20 mints a billion to its deployer, so NAV is small.
  const stakerStrat = opts.stakerStrat ?? 1_000_000_000n * WAD;
  await strat.write.mint([staker.account.address, stakerStrat]);
  await strat.write.approve([staking.address, stakerStrat], {
    account: staker.account,
  });
  await staking.write.stake([stakerStrat], { account: staker.account });

  const payBtc = async (btcWad: bigint, o: { minNetBtc?: bigint } = {}) => {
    const nav: bigint = await treasury.read.navBtcPerStrat();
    // A 0.01% margin so the ceiling rounding never clips the quote.
    const exact = (btcWad * WAD * 10_000n) / (nav * MAX_PAYOUT_BPS);
    const strat_ = exact + exact / 10_000n + 1n;
    await quote.write.setQuote([0n, btcWad]);
    return treasury.write.redeem([strat_, o.minNetBtc ?? 0n], {
      account: staker.account,
    });
  };

  return { quote, staking, reserve, staker, payBtc };
};

export const deployTreasuryFixture = async (): Promise<TreasuryFixture> => {
  const clients = await hre.viem.getWalletClients();
  const deployer = clients[0];
  const user = clients[1];

  const btc = await hre.viem.deployContract('MockERC20', ['cbBTC', 'cbBTC', 8]);
  const strat = await hre.viem.deployContract('MockERC20', [
    'STRAT',
    'STRAT',
    18,
  ]);

  const authority = await hre.viem.deployContract('AuthorityMock', []);
  await authority.write.setGenesisFinalized([true]);

  const treasury = await deployTreasuryContract(
    deployer.account.address,
    btc.address,
    strat.address,
    { authority: authority.address },
  );

  return { deployer, user, btc, strat, authority, treasury };
};
