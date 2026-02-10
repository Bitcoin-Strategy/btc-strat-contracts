import { expect } from 'chai';
import hre from 'hardhat';
import { getAddress, zeroAddress, type Address } from 'viem';
import {
  UNSTAKE_COOLDOWN,
  WAD,
  deployStakingFixture,
  deployStrat,
} from './_setupStaking';

describe('Staking — Admin / Unstake / Redeem Coverage', () => {
  describe('Constructor validation', () => {
    it('reverts with zero strat token', async () => {
      const clients = await hre.viem.getWalletClients();
      const owner = clients[0];
      const treasury = clients[1];

      await expect(
        hre.viem.deployContract('Staking', [
          owner.account.address as Address,
          zeroAddress,
          treasury.account.address as Address,
          (WAD * 20n) / 100n,
          WAD,
          1000n,
          WAD,
          UNSTAKE_COOLDOWN,
        ]),
      ).to.be.rejected;
    });

    it('reverts with zero premium reserve', async () => {
      const clients = await hre.viem.getWalletClients();
      const owner = clients[0];
      const treasury = clients[1];

      const strat = await deployStrat(
        treasury.account.address as Address,
        owner.account.address as Address,
      );

      await expect(
        hre.viem.deployContract('Staking', [
          owner.account.address as Address,
          strat.address as Address,
          zeroAddress,
          (WAD * 20n) / 100n,
          WAD,
          1000n,
          WAD,
          UNSTAKE_COOLDOWN,
        ]),
      ).to.be.rejected;
    });

    it('reverts with invalid THF params: maxTime=0', async () => {
      const clients = await hre.viem.getWalletClients();
      const owner = clients[0];
      const treasury = clients[1];

      const strat = await deployStrat(
        treasury.account.address as Address,
        owner.account.address as Address,
      );

      await expect(
        hre.viem.deployContract('Staking', [
          owner.account.address as Address,
          strat.address as Address,
          treasury.account.address as Address,
          (WAD * 20n) / 100n,
          WAD,
          0n,
          WAD,
          UNSTAKE_COOLDOWN,
        ]),
      ).to.be.rejected;
    });

    it('reverts with invalid THF params: max < min', async () => {
      const clients = await hre.viem.getWalletClients();
      const owner = clients[0];
      const treasury = clients[1];

      const strat = await deployStrat(
        treasury.account.address as Address,
        owner.account.address as Address,
      );

      await expect(
        hre.viem.deployContract('Staking', [
          owner.account.address as Address,
          strat.address as Address,
          treasury.account.address as Address,
          WAD,
          WAD / 2n,
          1000n,
          WAD,
          UNSTAKE_COOLDOWN,
        ]),
      ).to.be.rejected;
    });

    it('reverts with invalid THF params: neutral out of range', async () => {
      const clients = await hre.viem.getWalletClients();
      const owner = clients[0];
      const treasury = clients[1];

      const strat = await deployStrat(
        treasury.account.address as Address,
        owner.account.address as Address,
      );

      await expect(
        hre.viem.deployContract('Staking', [
          owner.account.address as Address,
          strat.address as Address,
          treasury.account.address as Address,
          WAD / 2n,
          WAD,
          1000n,
          0n,
          UNSTAKE_COOLDOWN,
        ]),
      ).to.be.rejected;

      await expect(
        hre.viem.deployContract('Staking', [
          owner.account.address as Address,
          strat.address as Address,
          treasury.account.address as Address,
          WAD / 2n,
          (WAD * 80n) / 100n,
          1000n,
          WAD,
          UNSTAKE_COOLDOWN,
        ]),
      ).to.be.rejected;
    });
  });

  describe('Admin setters', () => {
    it('setRedeemer: onlyOwner, rejects zero, sets once, then blocks', async () => {
      const { staking, deployer, user } = await deployStakingFixture();
      const clients = await hre.viem.getWalletClients();
      const redemption = clients[4];

      await expect(
        staking.write.setRedeemer([redemption.account.address], {
          account: user.account,
        }),
      ).to.be.rejected;

      await expect(
        staking.write.setRedeemer([zeroAddress], {
          account: deployer.account,
        }),
      ).to.be.rejected;

      await staking.write.setRedeemer([redemption.account.address], {
        account: deployer.account,
      });

      const saved = await staking.read.redeemer();
      expect(getAddress(saved)).to.equal(
        getAddress(redemption.account.address),
      );

      await expect(
        staking.write.setRedeemer([clients[5].account.address], {
          account: deployer.account,
        }),
      ).to.be.rejected;
    });

    it('setThfParams: onlyOwner, rejects invalid, updates on valid', async () => {
      const { staking, deployer, user } = await deployStakingFixture();

      await expect(
        staking.write.setThfParams([1n, 2n, 3n], {
          account: user.account,
        }),
      ).to.be.rejected;

      await expect(
        staking.write.setThfParams([WAD / 2n, WAD, 0n], {
          account: deployer.account,
        }),
      ).to.be.rejected;

      await expect(
        staking.write.setThfParams([0n, WAD, 1000n], {
          account: deployer.account,
        }),
      ).to.be.rejected;

      await expect(
        staking.write.setThfParams([WAD, WAD / 2n, 1000n], {
          account: deployer.account,
        }),
      ).to.be.rejected;

      // Above 1.0 a redemption would be quoted above the backing it burns.
      await expect(
        staking.write.setThfParams([WAD / 2n, WAD + 1n, 1000n], {
          account: deployer.account,
        }),
      ).to.be.rejected;

      const newMin = (WAD * 10n) / 100n;
      const newMax = (WAD * 90n) / 100n;
      const newMaxTime = 777n;

      await staking.write.setThfParams([newMin, newMax, newMaxTime], {
        account: deployer.account,
      });

      expect(await staking.read.thfMin()).to.equal(newMin);
      expect(await staking.read.thfMax()).to.equal(newMax);
      expect(await staking.read.thfMaxTime()).to.equal(newMaxTime);
    });
  });

  describe('Unstake', () => {
    it('reverts requestUnstake(0)', async () => {
      const { staking, user } = await deployStakingFixture();

      await expect(staking.write.requestUnstake([0n], { account: user.account })).to.be
        .rejected;
    });

    it('reverts if requesting more than staked', async () => {
      const { staking, user } = await deployStakingFixture();

      await expect(staking.write.requestUnstake([1n * WAD], { account: user.account }))
        .to.be.rejected;
    });

    it('a partial request keeps the start timestamp and updates the totals', async () => {
      const { staking, user, getStake } = await deployStakingFixture();
      const amount = 1000n * WAD;

      await staking.write.stake([amount], { account: user.account });
      const before = await getStake(user.account.address);

      const totalBefore = await staking.read.totalStaked();

      await staking.write.requestUnstake([400n * WAD], { account: user.account });

      const after = await getStake(user.account.address);
      const totalAfter = await staking.read.totalStaked();

      expect(after.position.amount).to.equal(600n * WAD);
      expect(after.position.start).to.equal(before.position.start);
      expect(totalBefore - totalAfter).to.equal(400n * WAD);
    });

    it('a full request resets start to 0 and clears the position', async () => {
      const { staking, user, getStake } = await deployStakingFixture();
      const amount = 500n * WAD;

      await staking.write.stake([amount], { account: user.account });

      const totalBefore = await staking.read.totalStaked();
      await staking.write.requestUnstake([amount], { account: user.account });

      const totalAfter = await staking.read.totalStaked();
      const after = await getStake(user.account.address);

      expect(totalBefore - totalAfter).to.equal(amount);
      expect(after.position.amount).to.equal(0n);
      expect(after.position.start).to.equal(0n);
    });
  });

  describe('redeemToPremiumReserve', () => {
    it('reverts if caller is not redemption', async () => {
      const { staking, user } = await deployStakingFixture();

      await expect(
        staking.write.redeemToPremiumReserve([user.account.address, 1n], {
          account: user.account,
        }),
      ).to.be.rejected;
    });

    it('reverts on amount=0 and insufficient stake', async () => {
      const { staking, deployer, user } = await deployStakingFixture();
      const clients = await hre.viem.getWalletClients();
      const redemption = clients[4];

      await staking.write.setRedeemer([redemption.account.address], {
        account: deployer.account,
      });

      await expect(
        staking.write.redeemToPremiumReserve([user.account.address, 0n], {
          account: redemption.account,
        }),
      ).to.be.rejected;

      await expect(
        staking.write.redeemToPremiumReserve([user.account.address, 1n * WAD], {
          account: redemption.account,
        }),
      ).to.be.rejected;
    });

    it('moves stake to premium reserve (partial), updates totals, keeps start', async () => {
      const { staking, deployer, user, treasury, getStake, strat } =
        await deployStakingFixture();
      const clients = await hre.viem.getWalletClients();
      const redemption = clients[4];

      await staking.write.setRedeemer([redemption.account.address], {
        account: deployer.account,
      });

      const stakeAmount = 1000n * WAD;
      await staking.write.stake([stakeAmount], { account: user.account });

      const beforePos = await getStake(user.account.address);
      const totalBefore = await staking.read.totalStaked();

      // The fixture's premium reserve is the treasury wallet.
      const reserveBalBefore = await strat.read.balanceOf([
        treasury.account.address,
      ]);

      const redeemAmount = 300n * WAD;
      await staking.write.redeemToPremiumReserve(
        [user.account.address, redeemAmount],
        {
          account: redemption.account,
        },
      );

      const afterPos = await getStake(user.account.address);
      const totalAfter = await staking.read.totalStaked();

      const reserveBalAfter = await strat.read.balanceOf([
        treasury.account.address,
      ]);

      expect(afterPos.position.amount).to.equal(stakeAmount - redeemAmount);
      expect(afterPos.position.start).to.equal(beforePos.position.start);

      expect(totalBefore - totalAfter).to.equal(redeemAmount);
      expect(reserveBalAfter - reserveBalBefore).to.equal(redeemAmount);
    });

    it('full redeem resets start to 0', async () => {
      const { staking, deployer, user, getStake } =
        await deployStakingFixture();
      const clients = await hre.viem.getWalletClients();
      const redemption = clients[4];

      await staking.write.setRedeemer([redemption.account.address], {
        account: deployer.account,
      });

      const stakeAmount = 600n * WAD;
      await staking.write.stake([stakeAmount], { account: user.account });

      const before = await getStake(user.account.address);
      expect(before.position.start > 0n).to.equal(true);

      await staking.write.redeemToPremiumReserve(
        [user.account.address, stakeAmount],
        {
          account: redemption.account,
        },
      );

      const after = await getStake(user.account.address);
      expect(after.position.amount).to.equal(0n);
      expect(after.position.start).to.equal(0n);
    });
  });
});
