import hre from 'hardhat';
import { type Address } from 'viem';

import { deployUups } from '../../scripts/lib/proxy';
import { deployOracleFixture, type OracleFixture } from '../Oracle/_v4';

/// The oracle and the swap mock agree on this price; tests that want a bad conversion move the adapter rate.
export const BTC_PER_STRAT_WAD = 2n * 10n ** 13n;

export const BTC_DECIMALS = 8;

/// Output units per 1e18 input units: 1 STRAT = 2000 raw cbBTC.
export const STRAT_TO_BTC_RATE = 2_000n;

export type FeeFixture = OracleFixture & {
  vault: Address;
  treasury: Address;
  oracle: Address;
  executor: Address;
};

/// A real pool and hook paying into a real FeeVault; Treasury, oracle and venue are mocked.
export async function deployFeeFixture(
  opts: { feePips?: number; owner?: Address } = {},
): Promise<FeeFixture> {
  const [deployer] = await hre.viem.getWalletClients();
  const owner = opts.owner ?? deployer.account.address;

  let vault!: Address;
  let treasury!: Address;
  let oracle!: Address;
  let executor!: Address;

  const fixture = await deployOracleFixture({
    feePips: opts.feePips,
    deployFeeVault: async (context) => {
      const treasuryMock = await hre.viem.deployContract('TreasuryMock', []);
      const oracleMock = await hre.viem.deployContract('PriceOracleMock', []);
      const executorMock = await hre.viem.deployContract(
        'SwapExecutorMock',
        [],
      );

      const feeVault = await deployUups('FeeVault', [
        owner,
        context.poolManager,
        treasuryMock.address,
        context.strat,
        context.btc,
        oracleMock.address,
        executorMock.address,
      ]);

      treasury = treasuryMock.address;
      oracle = oracleMock.address;
      executor = executorMock.address;
      vault = feeVault.address;
      return feeVault.address;
    },
  });

  const oracleMock = await hre.viem.getContractAt('PriceOracleMock', oracle);
  await oracleMock.write.setPrice([
    fixture.strat,
    fixture.btc,
    BTC_PER_STRAT_WAD,
  ]);

  const treasuryMock = await hre.viem.getContractAt('TreasuryMock', treasury);
  await treasuryMock.write.setBtcToken([fixture.btc]);

  const executorMock = await hre.viem.getContractAt(
    'SwapExecutorMock',
    executor,
  );
  await executorMock.write.setRate([
    fixture.strat,
    fixture.btc,
    STRAT_TO_BTC_RATE,
  ]);

  return { ...fixture, vault, treasury, oracle, executor };
}

export const vaultAt = (address: Address) =>
  hre.viem.getContractAt('FeeVault', address);

export const tokenAt = (address: Address) =>
  hre.viem.getContractAt('MockERC20Decimals', address);
