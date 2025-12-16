import { expect } from 'chai';
import hre from 'hardhat';
import { zeroAddress } from 'viem';

describe('VVEST — Non-Transferable Vesting Token', () => {
  let deployer: any;
  let bonding: any;
  let user1: any;
  let user2: any;

  let vvest: any;

  beforeEach(async () => {
    const clients = await hre.viem.getWalletClients();
    deployer = clients[0];
    bonding = clients[1]; // stand-in Bonding contract
    user1 = clients[2];
    user2 = clients[3];

    vvest = await hre.viem.deployContract('VVEST', [
      bonding.account.address, // minter
      bonding.account.address, // burner (test convenience)
    ]);
  });

  describe('Deployment', () => {
    it('rejects zero minter or burner', async () => {
      await expect(
        hre.viem.deployContract('VVEST', [
          zeroAddress,
          bonding.account.address,
        ]),
      ).to.be.rejectedWith('AddressZero');
      await expect(
        hre.viem.deployContract('VVEST', [
          bonding.account.address,
          zeroAddress,
        ]),
      ).to.be.rejectedWith('AddressZero');
    });

    it('has no admin: roles are frozen forever', async () => {
      const ADMIN_ROLE = await vvest.read.DEFAULT_ADMIN_ROLE();
      const MINTER_ROLE = await vvest.read.MINTER_ROLE();

      expect(
        await vvest.read.hasRole([ADMIN_ROLE, deployer.account.address]),
      ).to.equal(false);
      expect(
        await vvest.read.hasRole([ADMIN_ROLE, bonding.account.address]),
      ).to.equal(false);

      await expect(
        vvest.write.grantRole([MINTER_ROLE, user1.account.address], {
          account: deployer.account,
        }),
      ).to.be.rejected;
      await expect(
        vvest.write.revokeRole([MINTER_ROLE, bonding.account.address], {
          account: bonding.account,
        }),
      ).to.be.rejected;
    });
  });

  describe('Minting', () => {
    it('allows only bonding contract to mint', async () => {
      const amount = 1000n * 10n ** 18n;

      await vvest.write.mint([user1.account.address, amount], {
        account: bonding.account,
      });

      const bal = await vvest.read.balanceOf([user1.account.address]);
      expect(bal).to.equal(amount);

      await expect(
        vvest.write.mint([user1.account.address, amount], {
          account: user1.account,
        }),
      ).to.be.rejectedWith('NotAuthorized');
    });
  });

  describe('Non-transferability', () => {
    beforeEach(async () => {
      await vvest.write.mint([user1.account.address, 100n], {
        account: bonding.account,
      });
    });

    it('reverts transfer', async () => {
      await expect(
        vvest.write.transfer([user2.account.address, 10n], {
          account: user1.account,
        }),
      ).to.be.rejectedWith('NonTransferable');
    });

    it('reverts transferFrom', async () => {
      await expect(
        vvest.write.transferFrom(
          [user1.account.address, user2.account.address, 10n],
          { account: user2.account },
        ),
      ).to.be.rejectedWith('NonTransferable');
    });

    it('reverts approve', async () => {
      await expect(
        vvest.write.approve([user2.account.address, 10n], {
          account: user1.account,
        }),
      ).to.be.rejectedWith('NonTransferable');
    });
  });

  describe('Burning / Adjust after claim', () => {
    it('allows burner to burn user balance', async () => {
      await vvest.write.mint([user1.account.address, 500n], {
        account: bonding.account,
      });

      await vvest.write.burn([user1.account.address, 300n], {
        account: bonding.account,
      });

      const bal = await vvest.read.balanceOf([user1.account.address]);
      expect(bal).to.equal(200n);

      await expect(
        vvest.write.burn([user1.account.address, 1n], {
          account: user1.account,
        }),
      ).to.be.rejectedWith('NotAuthorized');
    });
  });

  describe('View functions sanity', () => {
    it('reports correct balances', async () => {
      await vvest.write.mint([user1.account.address, 100n], {
        account: bonding.account,
      });

      const bal = await vvest.read.balanceOf([user1.account.address]);
      expect(bal).to.equal(100n);

      const bal2 = await vvest.read.balanceOf([user2.account.address]);
      expect(bal2).to.equal(0n);
    });

    it('totalSupply changes after mint and burn', async () => {
      await vvest.write.mint([user1.account.address, 200n], {
        account: bonding.account,
      });

      let ts = await vvest.read.totalSupply();
      expect(ts).to.equal(200n);

      await vvest.write.burn([user1.account.address, 50n], {
        account: bonding.account,
      });

      ts = await vvest.read.totalSupply();
      expect(ts).to.equal(150n);
    });
  });
});
