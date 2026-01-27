import { expect } from 'chai';
import hre from 'hardhat';
import type { Address } from 'viem';

/// Runtime answering any call with one zero word, all the Treasury asks of a vault.
const VAULT_ANSWERS_ZERO = '0x600060005260206000f3' as const;

import { expectCustomError } from '../_helpers';
import {
  MAX_BTC_OUTFLOW_BPS,
  MAX_STRAT_OUTFLOW_BPS,
  OUTFLOW_WINDOW,
  WAD,
  deployTreasuryContract,
  wireRedemption,
} from './_setupTreasury';

const BTC_UNIT = 10n ** 8n;
const BTC_WAD_PER_UNIT = 10n ** 10n; // 8 decimals -> WAD

const warp = async (seconds: number) => {
  await hre.network.provider.send('evm_increaseTime', [seconds]);
  await hre.network.provider.send('evm_mine');
};

describe('Treasury — immutable outflow budget', () => {
  const setup = async (opts: { finalized?: boolean } = {}) => {
    const [deployer, , vault, recipient] = await hre.viem.getWalletClients();

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

    const authority = await hre.viem.deployContract('AuthorityMock', []);
    if (opts.finalized !== false) {
      await authority.write.setGenesisFinalized([true]);
    }

    const treasury = await deployTreasuryContract(
      deployer.account.address,
      btc.address,
      strat.address,
      { authority: authority.address },
    );

    const wiring = await wireRedemption(treasury, strat);
    // NAV reads `outstandingStrat` from this address, and the tests send from it, so code is placed at an account.
    await hre.network.provider.send('hardhat_setCode', [
      vault.account.address,
      VAULT_ANSWERS_ZERO,
    ]);
    await treasury.write.setVestingVaultOnce([
      vault.account.address as Address,
    ]);

    await btc.write.mint([treasury.address as Address, 100n * BTC_UNIT]);
    await strat.write.mint([treasury.address as Address, 1_000_000n * WAD]);

    return {
      deployer,
      ...wiring,
      vault,
      recipient,
      btc,
      strat,
      authority,
      treasury,
    };
  };

  it('publishes its ceilings and starts at them', async () => {
    const { treasury } = await setup();

    expect(await treasury.read.OUTFLOW_WINDOW()).to.equal(OUTFLOW_WINDOW);
    expect(await treasury.read.MAX_BTC_OUTFLOW_BPS()).to.equal(
      MAX_BTC_OUTFLOW_BPS,
    );
    expect(await treasury.read.MAX_STRAT_OUTFLOW_BPS()).to.equal(
      MAX_STRAT_OUTFLOW_BPS,
    );
    expect(await treasury.read.btcOutflowBps()).to.equal(MAX_BTC_OUTFLOW_BPS);
    expect(await treasury.read.stratOutflowBps()).to.equal(
      MAX_STRAT_OUTFLOW_BPS,
    );
  });

  it('rejects a nonsensical ceiling at deployment', async () => {
    const [deployer] = await hre.viem.getWalletClients();
    const token = await hre.viem.deployContract('MockERC20', ['T', 'T', 18]);
    const authority = await hre.viem.deployContract('AuthorityMock', []);

    for (const bad of [
      { outflowWindow: 0 },
      { maxBtcOutflowBps: 0 },
      { maxBtcOutflowBps: 10_001 },
      { maxStratOutflowBps: 0 },
      { maxStratOutflowBps: 10_001 },
    ]) {
      await expect(
        deployTreasuryContract(
          deployer.account.address,
          token.address,
          token.address,
          { authority: authority.address, ...bad },
        ),
      ).to.be.rejected;
    }
  });

  it('refuses every BTC payout until Genesis is finalized', async () => {
    const { treasury, staker, payBtc, authority, btc } = await setup({
      finalized: false,
    });

    expect(await treasury.read.redemptionOpensAt()).to.equal(0n);
    expect(await treasury.read.redemptionOpen()).to.equal(false);

    await expectCustomError(
      payBtc(1n * WAD),
      'RedemptionNotOpen',
      'RedemptionNotOpen(uint256)',
    );

    await authority.write.setGenesisFinalized([true]);
    await payBtc(1n * WAD);
    expect(
      await btc.read.balanceOf([staker.account.address as Address]),
    ).to.equal(1n * BTC_UNIT);
  });

  it('caps BTC at one capacity, and earns the next one back over a window', async () => {
    const { treasury, staker, payBtc, btc } = await setup();

    const balance = await treasury.read.btcBalance();
    const budget = (balance * BigInt(MAX_BTC_OUTFLOW_BPS)) / 10_000n;
    expect(await treasury.read.remainingBtcOutflow()).to.equal(budget);

    await expectCustomError(
      payBtc((budget + 1n) * BTC_WAD_PER_UNIT),
      'OutflowCapExceeded',
      'OutflowCapExceeded(uint256,uint256)',
    );

    // A couple of blocks of refill land between the payouts.
    const half = budget / 2n;
    await payBtc(half * BTC_WAD_PER_UNIT);
    expect(
      (await treasury.read.remainingBtcOutflow()) >= budget - half,
    ).to.equal(true);

    await payBtc((budget - half) * BTC_WAD_PER_UNIT);
    const leftInBucket = await treasury.read.remainingBtcOutflow();
    expect(leftInBucket * 1_000n < budget, 'dust, not a budget').to.equal(true);

    await expectCustomError(
      payBtc(budget * BTC_WAD_PER_UNIT),
      'OutflowCapExceeded',
      'OutflowCapExceeded(uint256,uint256)',
    );

    await warp(OUTFLOW_WINDOW);
    const left = await treasury.read.btcBalance();
    expect(left).to.equal(balance - budget);
    expect(await treasury.read.remainingBtcOutflow()).to.equal(
      (left * BigInt(MAX_BTC_OUTFLOW_BPS)) / 10_000n,
    );

    expect(
      await btc.read.balanceOf([staker.account.address as Address]),
    ).to.equal(budget);
  });

  it('caps STRAT the same way and only answers the wired vault', async () => {
    const { treasury, vault, recipient, deployer, strat } = await setup();

    const balance = await strat.read.balanceOf([treasury.address as Address]);
    const budget = (balance * BigInt(MAX_STRAT_OUTFLOW_BPS)) / 10_000n;
    expect(await treasury.read.remainingStratOutflow()).to.equal(budget);

    await expectCustomError(
      treasury.write.sendStrat(
        [recipient.account.address as Address, 1n * WAD],
        { account: deployer.account },
      ),
      'NotAuthorized',
    );

    await expectCustomError(
      treasury.write.sendStrat(
        [recipient.account.address as Address, budget + 1n],
        { account: vault.account },
      ),
      'OutflowCapExceeded',
      'OutflowCapExceeded(uint256,uint256)',
    );

    await treasury.write.sendStrat(
      [recipient.account.address as Address, budget],
      { account: vault.account },
    );
    expect(
      await strat.read.balanceOf([recipient.account.address as Address]),
    ).to.equal(budget);
    expect(await treasury.read.remainingStratOutflow()).to.equal(0n);
  });

  it('governance may tighten the rate but can never raise it past the ceiling', async () => {
    const { treasury, deployer } = await setup();

    await expectCustomError(
      treasury.write.setBtcOutflowBps([MAX_BTC_OUTFLOW_BPS + 1], {
        account: deployer.account,
      }),
      'OutflowRateAboveCeiling',
      'OutflowRateAboveCeiling(uint16,uint16)',
    );
    await expectCustomError(
      treasury.write.setStratOutflowBps([MAX_STRAT_OUTFLOW_BPS + 1], {
        account: deployer.account,
      }),
      'OutflowRateAboveCeiling',
      'OutflowRateAboveCeiling(uint16,uint16)',
    );

    await treasury.write.setBtcOutflowBps([100], {
      account: deployer.account,
    });
    expect(await treasury.read.btcOutflowBps()).to.equal(100);

    const balance = await treasury.read.btcBalance();
    expect(await treasury.read.remainingBtcOutflow()).to.equal(
      (balance * 100n) / 10_000n,
    );

    await treasury.write.setBtcOutflowBps([0], { account: deployer.account });
    expect(await treasury.read.remainingBtcOutflow()).to.equal(0n);
    await treasury.write.setBtcOutflowBps([MAX_BTC_OUTFLOW_BPS], {
      account: deployer.account,
    });
    expect(await treasury.read.remainingBtcOutflow()).to.equal(
      (balance * BigInt(MAX_BTC_OUTFLOW_BPS)) / 10_000n,
    );
  });

  it('has no escape hatch: two metered exits and nothing else', async () => {
    const { treasury } = await setup();
    const names = (treasury.abi as readonly { name?: string }[])
      .map((i) => i.name)
      .filter(Boolean) as string[];

    for (const forbidden of [
      'withdraw',
      'rescue',
      'sweep',
      'transferOut',
      'emergencyWithdraw',
      // A replaced Redemption module used to be able to call this.
      'sendBtc',
    ]) {
      expect(names, `Treasury must not expose ${forbidden}`).to.not.include(
        forbidden,
      );
    }
    expect(names).to.include('redeem');
    expect(names).to.include('sendStrat');
  });
});
