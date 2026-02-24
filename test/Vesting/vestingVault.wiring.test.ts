import { expect } from 'chai';
import hre from 'hardhat';
import { deployUups } from '../_helpers';
import { keccak256, toBytes, zeroAddress } from 'viem';

const WAD = 10n ** 18n;

/// Hardhat sometimes reports interface-declared errors as unrecognized selectors.
const expectCustomError = async (
  promise: Promise<unknown>,
  errorName: string,
): Promise<void> => {
  const selector = keccak256(toBytes(`${errorName}()`)).slice(0, 10);
  try {
    await promise;
  } catch (error: any) {
    const text = [
      error?.message,
      error?.shortMessage,
      error?.details,
      error?.cause?.message,
      error?.cause?.details,
    ]
      .filter(Boolean)
      .join('\n');
    expect(
      text.includes(errorName) || text.includes(selector),
      `expected ${errorName} (${selector}), got: ${text.slice(0, 200)}`,
    ).to.equal(true);
    return;
  }
  expect.fail(`Expected revert: ${errorName}`);
};

describe('VestingVault — one-time wiring', () => {
  const deployVault = async () => {
    const [deployer, bonding, , user] = await hre.viem.getWalletClients();
    const strat = await hre.viem.deployContract('MockERC20', [
      'STRAT',
      'STRAT',
      18,
    ]);
    const vvest = await hre.viem.deployContract('VVESTMock', []);
    const treasury = await hre.viem.deployContract('TreasuryMock', []);
    const vault = await deployUups('VestingVault', [
      deployer.account.address,
      strat.address,
      treasury.address,
    ]);
    await vvest.write.setBurner([vault.address]);
    await treasury.write.setStratTokenContract([strat.address]);
    await treasury.write.setVestingVault([vault.address]);
    await strat.write.mint([treasury.address, 1_000_000n * WAD]);
    return { deployer, bonding, treasury, user, strat, vvest, vault };
  };

  it('initializer rejects a zero STRAT or treasury address', async () => {
    const [deployer] = await hre.viem.getWalletClients();
    const strat = await hre.viem.deployContract('MockERC20', [
      'STRAT',
      'STRAT',
      18,
    ]);
    const treasury = await hre.viem.deployContract('TreasuryMock', []);

    await expect(
      deployUups('VestingVault', [
        deployer.account.address,
        zeroAddress,
        treasury.address,
      ]),
    ).to.be.rejectedWith('AddressZero');
    await expect(
      deployUups('VestingVault', [
        deployer.account.address,
        strat.address,
        zeroAddress,
      ]),
    ).to.be.rejectedWith('AddressZero');
  });

  it('createVest is impossible before bonding is wired, claim before VVEST is wired', async () => {
    const { deployer, bonding, user, vvest, vault } = await deployVault();
    const now = BigInt(
      (await (await hre.viem.getPublicClient()).getBlock()).timestamp,
    );

    // Simulated so viem decodes the custom error.
    await expectCustomError(
      vault.simulate.createVest(
        [user.account.address, 100n * WAD, now, now + 100n, 0],
        { account: bonding.account },
      ),
      'NotBonding',
    );

    await vault.write.setBondingOnce([bonding.account.address], {
      account: deployer.account,
    });
    await vault.write.createVest(
      [user.account.address, 100n * WAD, now, now + 100n, 0],
      { account: bonding.account },
    );

    await hre.network.provider.send('evm_increaseTime', [200]);
    await hre.network.provider.send('evm_mine');

    await expectCustomError(
      vault.simulate.claim([[0n]], { account: user.account }),
      'VvestNotSet',
    );

    await vault.write.setVvestOnce([vvest.address], {
      account: deployer.account,
    });
    await vvest.write.mint([user.account.address, 100n * WAD]);

    await vault.write.claim([[0n]], { account: user.account });
    expect(await vault.read.totalClaimedStrat()).to.equal(100n * WAD);
  });

  it('setters are onlyOwner, reject zero and can only be called once', async () => {
    const { deployer, bonding, user, vvest, vault } = await deployVault();

    await expect(
      vault.write.setBondingOnce([bonding.account.address], {
        account: user.account,
      }),
    ).to.be.rejected;
    await expect(
      vault.write.setBondingOnce([zeroAddress], { account: deployer.account }),
    ).to.be.rejectedWith('AddressZero');

    await vault.write.setBondingOnce([bonding.account.address], {
      account: deployer.account,
    });
    await expect(
      vault.write.setBondingOnce([user.account.address], {
        account: deployer.account,
      }),
    ).to.be.rejectedWith('AlreadySet');

    await expect(
      vault.write.setVvestOnce([zeroAddress], { account: deployer.account }),
    ).to.be.rejectedWith('AddressZero');
    await vault.write.setVvestOnce([vvest.address], {
      account: deployer.account,
    });
    await expect(
      vault.write.setVvestOnce([vvest.address], { account: deployer.account }),
    ).to.be.rejectedWith('AlreadySet');
  });
});
