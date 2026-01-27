import { expect } from 'chai';
import hre from 'hardhat';
import { getAddress, parseEventLogs, zeroAddress, type Address } from 'viem';
import {
  deployTreasuryFixture,
  WAD,
  BTC_DECIMALS,
  deployTreasuryContract,
  wireRedemption,
} from './_setupTreasury';

/// Runtime answering any call with one zero word, all the Treasury asks of a vault at wiring.
const VAULT_ANSWERS_ZERO = '0x600060005260206000f3' as const;

describe('Treasury — Extra Coverage', () => {
  const fundTreasury = async (params: {
    btcRaw: bigint;
    funder: any;
    btc: any;
    treasury: any;
  }): Promise<void> => {
    const { btcRaw, funder, btc, treasury } = params;
    if (btcRaw === 0n) return;

    await btc.write.mint([funder.account.address as Address, btcRaw]);
    await btc.write.transfer([treasury.address as Address, btcRaw], {
      account: funder.account,
    });
  };

  it('constructor reverts if any token address is zero', async () => {
    const clients = await hre.viem.getWalletClients();
    const owner = clients[0];
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

    await expect(
      deployTreasuryContract(
        owner.account.address as Address,
        zeroAddress,
        strat.address as Address,
      ),
    ).to.be.rejected;

    await expect(
      deployTreasuryContract(
        owner.account.address as Address,
        btc.address as Address,
        zeroAddress,
      ),
    ).to.be.rejected;
  });

  it('navBtcPerStrat() returns 0 if STRAT supply is 0', async () => {
    const { treasury } = await deployTreasuryFixture();
    const nav = await treasury.read.navBtcPerStrat();
    expect(nav).to.equal(0n);
  });

  it('navBtcPerStrat() returns BTC-per-STRAT when supply > 0', async () => {
    const { user, btc, strat, treasury } = await deployTreasuryFixture();

    await strat.write.mint([user.account.address as Address, 100n * WAD]);

    await fundTreasury({
      btcRaw: 1n * BTC_DECIMALS,
      funder: user,
      btc,
      treasury,
    });

    const nav = await treasury.read.navBtcPerStrat();

    const supply = await strat.read.totalSupply();
    const treasuryBtcWad = await treasury.read.treasuryBtc();
    const expected = (treasuryBtcWad * WAD) / supply;
    expect(nav).to.equal(expected);
  });

  it('setRedemptionContract: onlyOwner, zero checks, one-time set', async () => {
    const { deployer, user, treasury } = await deployTreasuryFixture();
    const clients = await hre.viem.getWalletClients();
    const redemption = clients[3];
    const bonding = clients[4];

    await expect(
      treasury.write.setRedemptionContract(
        [redemption.account.address as Address],
        { account: user.account },
      ),
    ).to.be.rejected;

    await expect(
      treasury.write.setRedemptionContract([zeroAddress], {
        account: deployer.account,
      }),
    ).to.be.rejected;

    await treasury.write.setRedemptionContract(
      [redemption.account.address as Address],
      { account: deployer.account },
    );

    expect(getAddress(await treasury.read.redemptionContract())).to.equal(
      getAddress(redemption.account.address),
    );

    await expect(
      treasury.write.setRedemptionContract(
        [clients[5].account.address as Address],
        { account: deployer.account },
      ),
    ).to.be.rejected;
  });

  it('setVestingVaultOnce: zero, a vault that cannot answer, set once, then blocks', async () => {
    const { deployer, treasury } = await deployTreasuryFixture();
    const clients = await hre.viem.getWalletClients();
    const vault = await hre.viem.deployContract('VestingMock', []);

    await expect(
      treasury.write.setVestingVaultOnce([zeroAddress], {
        account: deployer.account,
      }),
    ).to.be.rejected;

    // The wiring is permanent, so a vault that cannot answer is refused now.
    await expect(
      treasury.write.setVestingVaultOnce(
        [clients[6].account.address as Address],
        { account: deployer.account },
      ),
    ).to.be.rejected;

    await treasury.write.setVestingVaultOnce([vault.address], {
      account: deployer.account,
    });

    expect(getAddress(await treasury.read.vestingVault())).to.equal(
      getAddress(vault.address),
    );

    await expect(
      treasury.write.setVestingVaultOnce([vault.address], {
        account: deployer.account,
      }),
    ).to.be.rejected;
  });

  it('setVestingVaultOnce grants no allowance: the vault has to ask and every ask is metered', async () => {
    const { deployer, strat, treasury } = await deployTreasuryFixture();
    const clients = await hre.viem.getWalletClients();
    const vault = clients[6];
    const user = clients[7];

    // An account, so the test can send from it; code is placed at its address.
    await hre.network.provider.send('hardhat_setCode', [
      vault.account.address,
      VAULT_ANSWERS_ZERO,
    ]);

    await treasury.write.setVestingVaultOnce(
      [vault.account.address as Address],
      { account: deployer.account },
    );

    expect(
      await strat.read.allowance([
        treasury.address as Address,
        vault.account.address as Address,
      ]),
    ).to.equal(0n);

    await strat.write.mint([treasury.address as Address, 1_000n * WAD]);

    await expect(
      treasury.write.sendStrat([user.account.address as Address, 1n * WAD], {
        account: deployer.account,
      }),
    ).to.be.rejected;

    // Capped by the STRAT window budget (10% of the balance).
    await expect(
      treasury.write.sendStrat([user.account.address as Address, 200n * WAD], {
        account: vault.account,
      }),
    ).to.be.rejected;

    await treasury.write.sendStrat(
      [user.account.address as Address, 50n * WAD],
      { account: vault.account },
    );
    expect(
      await strat.read.balanceOf([user.account.address as Address]),
    ).to.equal(50n * WAD);
  });

  it('ownership is two-step and can never be renounced', async () => {
    const { deployer, user, treasury } = await deployTreasuryFixture();

    await expect(
      treasury.write.renounceOwnership({ account: deployer.account }),
    ).to.be.rejectedWith('RenounceOwnershipDisabled');

    await treasury.write.transferOwnership([user.account.address as Address], {
      account: deployer.account,
    });

    expect(getAddress(await treasury.read.owner())).to.equal(
      getAddress(deployer.account.address),
    );
    expect(getAddress(await treasury.read.pendingOwner())).to.equal(
      getAddress(user.account.address),
    );

    await treasury.write.acceptOwnership({ account: user.account });
    expect(getAddress(await treasury.read.owner())).to.equal(
      getAddress(user.account.address),
    );
  });

  it('redeem: refuses to run unwired, and emits one balance snapshot per settlement', async () => {
    const { user, btc, strat, treasury } = await deployTreasuryFixture();

    await expect(
      treasury.write.redeem([1n * WAD, 0n], { account: user.account }),
    ).to.be.rejectedWith('NotAuthorized');

    const { payBtc } = await wireRedemption(treasury, strat);
    await fundTreasury({
      btcRaw: 10n * BTC_DECIMALS,
      funder: user,
      btc,
      treasury,
    });

    const txHash = (await payBtc(1n * WAD)) as `0x${string}`;
    const publicClient = await hre.viem.getPublicClient();
    const receipt = await publicClient.waitForTransactionReceipt({
      hash: txHash,
    });
    const events = await treasury.getEvents.TreasuryUpdated({
      fromBlock: receipt.blockNumber,
      toBlock: receipt.blockNumber,
    });
    expect(events.length).to.equal(1);
  });
});
