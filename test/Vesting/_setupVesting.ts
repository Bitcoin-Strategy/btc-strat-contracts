import hre from 'hardhat';
import type { Abi, Address } from 'viem';

import { deployUups } from '../_helpers';

const WAD = 10n ** 18n;

type Deployed = {
  address: Address;
  abi: Abi;
};

type Fixture = {
  publicClient: any;
  deployer: any;
  bonding: any;
  user: any;
  strat: any;
  vvest: any;
  treasury: any;
  vault: Deployed;
};

export const nowTs = async (): Promise<bigint> => {
  const block = await hre.network.provider.send('eth_getBlockByNumber', [
    'latest',
    false,
  ]);
  return BigInt(block.timestamp);
};

export const mineTo = async (timestamp: bigint): Promise<void> => {
  await hre.network.provider.send('evm_setNextBlockTimestamp', [
    Number(timestamp),
  ]);
  await hre.network.provider.send('evm_mine');
};

/// Claims are paid by the treasury mock, as in production.
export const deployVestingFixture = async (): Promise<Fixture> => {
  const publicClient = await hre.viem.getPublicClient();
  const clients = await hre.viem.getWalletClients();

  const deployer = clients[0];
  const bonding = clients[1];
  const user = clients[3];

  const strat = await hre.viem.deployContract('MockERC20', [
    'STRAT',
    'STRAT',
    18,
  ]);
  const vvest = await hre.viem.deployContract('VVESTMock', []);
  const treasury = await hre.viem.deployContract('TreasuryMock', []);

  const vaultContract = await deployUups('VestingVault', [
    deployer.account.address, // owner
    strat.address, // STRAT
    treasury.address, // treasury holding the backing
  ]);
  const vault: Deployed = {
    address: vaultContract.address as Address,
    abi: vaultContract.abi as Abi,
  };

  await vaultContract.write.setBondingOnce([bonding.account.address]);
  await vaultContract.write.setVvestOnce([vvest.address]);
  await vvest.write.setBurner([vault.address]);

  await treasury.write.setStratTokenContract([strat.address]);
  await treasury.write.setVestingVault([vault.address]);
  await strat.write.mint([treasury.address, 10_000_000n * WAD]);

  return {
    publicClient,
    deployer,
    bonding,
    user,
    strat,
    vvest,
    treasury,
    vault,
  };
};

export const helpers = { WAD, nowTs, mineTo };
