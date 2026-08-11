import { expect } from 'chai';
import hre from 'hardhat';
import {
  encodeFunctionData,
  getAddress,
  toFunctionSelector,
  zeroAddress,
} from 'viem';

import { expectCustomError } from '../_helpers';
import {
  GUARDIAN_PERIOD,
  Phase,
  THF_MAX_TIME,
  WAD,
  deployGovernanceFixture,
  impersonate,
  increaseTime,
} from './_setupGovernance';

/// Reaches the target and reverts there, not at the authority.
const acceptOwnershipCalldata = () =>
  encodeFunctionData({
    abi: [
      {
        type: 'function',
        name: 'acceptOwnership',
        stateMutability: 'nonpayable',
        inputs: [],
        outputs: [],
      },
    ],
    functionName: 'acceptOwnership',
    args: [],
  });

const upgradeCalldata = (impl: `0x${string}`) =>
  encodeFunctionData({
    abi: [
      {
        type: 'function',
        name: 'upgradeToAndCall',
        stateMutability: 'payable',
        inputs: [
          { name: 'newImplementation', type: 'address' },
          { name: 'data', type: 'bytes' },
        ],
        outputs: [],
      },
    ],
    functionName: 'upgradeToAndCall',
    args: [impl, '0x'],
  });

const transferOwnershipCalldata = (to: `0x${string}`) =>
  encodeFunctionData({
    abi: [
      {
        type: 'function',
        name: 'transferOwnership',
        stateMutability: 'nonpayable',
        inputs: [{ name: 'newOwner', type: 'address' }],
        outputs: [],
      },
    ],
    functionName: 'transferOwnership',
    args: [to],
  });

describe('ProtocolAuthority — three phases and selector routing', () => {
  describe('Deployment', () => {
    it('stores the configuration and starts in the Genesis phase', async () => {
      const f = await deployGovernanceFixture();

      expect(getAddress(await f.authority.read.admin())).to.equal(
        getAddress(f.admin.account.address),
      );
      expect(getAddress(await f.authority.read.PARAMS_TIMELOCK())).to.equal(
        getAddress(f.paramsTimelock.address),
      );
      expect(getAddress(await f.authority.read.UPGRADE_TIMELOCK())).to.equal(
        getAddress(f.upgradeTimelock.address),
      );
      expect(getAddress(await f.authority.read.guardian())).to.equal(
        getAddress(f.guardian),
      );
      expect(await f.authority.read.currentPhase()).to.equal(Phase.Genesis);
      expect(await f.authority.read.genesisFinalized()).to.equal(false);
      expect(await f.authority.read.genesisFinalizedAt()).to.equal(0n);
      expect(getAddress(await f.authority.read.controller())).to.equal(
        getAddress(f.admin.account.address),
      );
    });

    it('rejects a zero admin or timelock, and takes a zero guardian', async () => {
      const f = await deployGovernanceFixture();
      const ok = [
        f.admin.account.address,
        f.paramsTimelock.address,
        f.upgradeTimelock.address,
        f.guardian,
        GUARDIAN_PERIOD,
      ] as const;

      for (const i of [0, 1, 2]) {
        const args = [...ok];
        args[i] = zeroAddress as never;
        await expect(
          hre.viem.deployContract('ProtocolAuthority', args as never),
        ).to.be.rejected;
      }

      const noGuardian = [...ok];
      noGuardian[3] = zeroAddress as never;
      const authority = await hre.viem.deployContract(
        'ProtocolAuthority',
        noGuardian as never,
      );
      expect(await authority.read.guardian()).to.equal(zeroAddress);
    });
  });

  describe('Genesis phase', () => {
    it('only the admin executes, and the target error bubbles up unchanged', async () => {
      const f = await deployGovernanceFixture();
      const data = acceptOwnershipCalldata();

      for (const who of [f.deployer, f.user1]) {
        await expectCustomError(
          f.authority.write.execute([f.staking.address, data], {
            account: who.account,
          }),
          'NotController',
          'NotController(address,uint8)',
        );
      }

      // The admin gets through; the error is the target's own.
      await expectCustomError(
        f.authority.write.execute([f.staking.address, data], {
          account: f.admin.account,
        }),
        'OwnableUnauthorizedAccount',
        'OwnableUnauthorizedAccount(address)',
      );
    });

    it('the admin tunes parameters during the launch, because nothing else can', async () => {
      const f = await deployGovernanceFixture();
      const params = f.encodeSetThfParams(WAD / 10n, WAD, 1_111n);

      // There is no DAO yet, so the admin must be able to retune parameters.
      expect(await f.staking.read.thfMaxTime()).to.equal(THF_MAX_TIME);
      await f.authority.write.execute([f.staking.address, params], {
        account: f.admin.account,
      });
      expect(await f.staking.read.thfMaxTime()).to.equal(1_111n);

      await expectCustomError(
        f.authority.write.execute(
          [f.staking.address, upgradeCalldata(f.strat.address)],
          { account: f.admin.account },
        ),
        'NotUpgradeController',
        'NotUpgradeController(address)',
      );
      await expectCustomError(
        f.authority.write.execute(
          [
            f.staking.address,
            transferOwnershipCalldata(f.user1.account.address),
          ],
          { account: f.admin.account },
        ),
        'NotUpgradeController',
        'NotUpgradeController(address)',
      );
      expect(getAddress(await f.staking.read.owner())).to.equal(
        getAddress(f.authority.address),
      );

      await f.activateDaoPhase();
      await f.authority.write.execute(
        [f.staking.address, f.encodeSetThfParams(WAD / 10n, WAD, 2_222n)],
        { account: await impersonate(f.paramsTimelock.address) },
      );
      expect(await f.staking.read.thfMaxTime()).to.equal(2_222n);
    });

    it('the admin can never upgrade a module or move ownership away', async () => {
      const f = await deployGovernanceFixture();

      await expectCustomError(
        f.authority.write.execute(
          [f.staking.address, upgradeCalldata(f.strat.address)],
          { account: f.admin.account },
        ),
        'NotUpgradeController',
        'NotUpgradeController(address)',
      );

      await expectCustomError(
        f.authority.write.execute(
          [
            f.staking.address,
            transferOwnershipCalldata(f.admin.account.address),
          ],
          { account: f.admin.account },
        ),
        'NotUpgradeController',
        'NotUpgradeController(address)',
      );

      expect(getAddress(await f.staking.read.owner())).to.equal(
        getAddress(f.authority.address),
      );
    });

    it('transferAdmin works during Genesis and only for the admin', async () => {
      const f = await deployGovernanceFixture();

      await expectCustomError(
        f.authority.write.transferAdmin([f.user1.account.address], {
          account: f.user1.account,
        }),
        'NotController',
        'NotController(address,uint8)',
      );
      await expectCustomError(
        f.authority.write.transferAdmin([zeroAddress], {
          account: f.admin.account,
        }),
        'AddressZero',
      );

      await f.authority.write.transferAdmin([f.user1.account.address], {
        account: f.admin.account,
      });
      expect(getAddress(await f.authority.read.admin())).to.equal(
        getAddress(f.user1.account.address),
      );
    });

    it('executeBatch is atomic and validates its inputs', async () => {
      const f = await deployGovernanceFixture();
      const ok = f.encodeSetThfParams(WAD / 10n, WAD, 1_111n);
      const bad = f.encodeSetThfParams(WAD / 10n, WAD, 0n);

      await expectCustomError(
        f.authority.write.executeBatch([[], []], {
          account: f.admin.account,
        }),
        'EmptyBatch',
      );
      await expectCustomError(
        f.authority.write.executeBatch([[f.staking.address], []], {
          account: f.admin.account,
        }),
        'LengthMismatch',
      );

      await f.activateDaoPhase();
      const paramsTl = await impersonate(f.paramsTimelock.address);

      // As the upgrade timelock: for the parameter track an unlisted address is refused first.
      await expectCustomError(
        f.authority.write.execute([f.user1.account.address, ok], {
          account: await impersonate(f.upgradeTimelock.address),
        }),
        'TargetNotContract',
        'TargetNotContract(address)',
      );
      await expectCustomError(
        f.authority.write.execute([f.user1.account.address, ok], {
          account: paramsTl,
        }),
        'NotUpgradeController',
        'NotUpgradeController(address)',
      );

      const before = await f.staking.read.thfMaxTime();
      await expectCustomError(
        f.authority.write.executeBatch(
          [
            [f.staking.address, f.staking.address],
            [ok, bad],
          ],
          { account: paramsTl },
        ),
        'InvalidThfParams',
      );
      expect(await f.staking.read.thfMaxTime()).to.equal(before);
    });
  });

  describe('Finalization', () => {
    it('the admin finalizes, loses every right, and cannot do it twice', async () => {
      const f = await deployGovernanceFixture();

      await f.authority.write.finalizeGenesis({ account: f.admin.account });

      expect(await f.authority.read.genesisFinalized()).to.equal(true);
      expect(await f.authority.read.admin()).to.equal(zeroAddress);
      expect((await f.authority.read.genesisFinalizedAt()) > 0n).to.equal(true);

      await expectCustomError(
        f.authority.write.finalizeGenesis({ account: f.admin.account }),
        'GenesisAlreadyFinalized',
      );

      const data = f.encodeSetThfParams(WAD / 10n, WAD, 2_222n);
      await expectCustomError(
        f.authority.write.execute([f.staking.address, data], {
          account: f.admin.account,
        }),
        'NotController',
        'NotController(address,uint8)',
      );
      await expectCustomError(
        f.authority.write.transferAdmin([f.admin.account.address], {
          account: f.admin.account,
        }),
        'NotController',
        'NotController(address,uint8)',
      );
    });

    it('nobody but the admin can end Genesis, however long it runs', async () => {
      const f = await deployGovernanceFixture();

      for (const account of [f.user1.account, f.deployer.account]) {
        await expectCustomError(
          f.authority.write.finalizeGenesis({ account }),
          'NotController',
          'NotController(address,uint8)',
        );
      }

      await increaseTime(365n * 24n * 3600n);
      await expectCustomError(
        f.authority.write.finalizeGenesis({ account: f.user1.account }),
        'NotController',
        'NotController(address,uint8)',
      );
      expect(await f.authority.read.genesisFinalized()).to.equal(false);

      await f.authority.write.finalizeGenesis({ account: f.admin.account });
      expect(await f.authority.read.genesisFinalized()).to.equal(true);
      expect(await f.authority.read.admin()).to.equal(zeroAddress);
    });

    it('control changes hands inside one transaction: no gap, no overlap', async () => {
      const f = await deployGovernanceFixture();
      const data = f.encodeSetThfParams(WAD / 10n, WAD, 2_222n);
      const paramsTl = await impersonate(f.paramsTimelock.address);

      expect(await f.authority.read.currentPhase()).to.equal(Phase.Genesis);
      await expectCustomError(
        f.authority.write.execute([f.staking.address, data], {
          account: paramsTl,
        }),
        'NotController',
        'NotController(address,uint8)',
      );

      await f.authority.write.finalizeGenesis({ account: f.admin.account });

      expect(await f.authority.read.currentPhase()).to.equal(Phase.Dao);
      expect(await f.authority.read.admin()).to.equal(zeroAddress);
      expect(getAddress(await f.authority.read.controller())).to.equal(
        getAddress(f.paramsTimelock.address),
      );

      await expectCustomError(
        f.authority.write.execute([f.staking.address, data], {
          account: f.admin.account.address,
        }),
        'NotController',
        'NotController(address,uint8)',
      );
      await f.authority.write.execute([f.staking.address, data], {
        account: paramsTl,
      });
    });
  });

  describe('Dao phase', () => {
    it('both timelocks change parameters, and nobody else can', async () => {
      const f = await deployGovernanceFixture();
      await f.activateDaoPhase();

      const data = f.encodeSetThfParams(WAD / 10n, WAD, 3_333n);

      for (const who of [f.admin, f.user1]) {
        await expectCustomError(
          f.authority.write.execute([f.staking.address, data], {
            account: who.account,
          }),
          'NotController',
          'NotController(address,uint8)',
        );
      }

      const paramsTl = await impersonate(f.paramsTimelock.address);
      await f.authority.write.execute([f.staking.address, data], {
        account: paramsTl,
      });
      expect(await f.staking.read.thfMaxTime()).to.equal(3_333n);

      const upgradeTl = await impersonate(f.upgradeTimelock.address);
      await f.authority.write.execute(
        [f.staking.address, f.encodeSetThfParams(WAD / 10n, WAD, 4_444n)],
        { account: upgradeTl },
      );
      expect(await f.staking.read.thfMaxTime()).to.equal(4_444n);
    });

    it('only the upgrade timelock may upgrade or move ownership, never the params timelock', async () => {
      const f = await deployGovernanceFixture();
      await f.activateDaoPhase();

      const paramsTl = await impersonate(f.paramsTimelock.address);

      await expectCustomError(
        f.authority.write.execute(
          [f.staking.address, upgradeCalldata(f.strat.address)],
          { account: paramsTl },
        ),
        'NotUpgradeController',
        'NotUpgradeController(address)',
      );
      await expectCustomError(
        f.authority.write.execute(
          [
            f.staking.address,
            transferOwnershipCalldata(f.user1.account.address),
          ],
          { account: paramsTl },
        ),
        'NotUpgradeController',
        'NotUpgradeController(address)',
      );

      // Staking is not upgradeable, so the call fails in the target, not the authority.
      const upgradeTl = await impersonate(f.upgradeTimelock.address);
      await f.authority.write.execute(
        [f.staking.address, transferOwnershipCalldata(f.user2.account.address)],
        { account: upgradeTl },
      );
      expect(getAddress(await f.staking.read.pendingOwner())).to.equal(
        getAddress(f.user2.account.address),
      );
    });

    it('repointing a price feed is restricted like an upgrade, in every phase', async () => {
      const f = await deployGovernanceFixture();

      const base = await hre.viem.deployContract('MockERC20', ['B', 'B', 18]);
      const quote = await hre.viem.deployContract('MockERC20', ['Q', 'Q', 6]);
      const oracle = await hre.viem.deployContract('ProtocolOracle', [
        f.authority.address,
      ]);
      const adapter = await hre.viem.deployContract('PriceAdapterMock', [
        base.address,
        quote.address,
        10n ** 18n,
      ]);
      const setFeed = encodeFunctionData({
        abi: oracle.abi,
        functionName: 'setFeed',
        args: [base.address, quote.address, adapter.address],
      });

      // Unlisted functions are upgrade-only by default, including setters added later.
      const selector = toFunctionSelector('setFeed(address,address,address)');
      expect(
        await f.authority.read.paramsAllowed([oracle.address, selector]),
      ).to.equal(false);
      expect(
        await f.authority.read.restricted([oracle.address, selector]),
      ).to.equal(true);

      await expectCustomError(
        f.authority.write.execute([oracle.address, setFeed], {
          account: f.admin.account,
        }),
        'NotUpgradeController',
        'NotUpgradeController(address)',
      );

      await f.activateDaoPhase();
      const paramsTl = await impersonate(f.paramsTimelock.address);
      await expectCustomError(
        f.authority.write.execute([oracle.address, setFeed], {
          account: paramsTl,
        }),
        'NotUpgradeController',
        'NotUpgradeController(address)',
      );

      const upgradeTl = await impersonate(f.upgradeTimelock.address);
      await f.authority.write.execute([oracle.address, setFeed], {
        account: upgradeTl,
      });
      expect(
        getAddress(await oracle.read.feedOf([base.address, quote.address])),
      ).to.equal(getAddress(adapter.address));
    });

    it('the allowlist is bound to a contract, and widening costs an upgrade vote', async () => {
      const f = await deployGovernanceFixture();
      const selector = toFunctionSelector('setFeed(address,address,address)');

      // Allowance is per (target, selector), so a colliding selector elsewhere is not covered.
      await f.authority.write.allowParams([f.staking.address, selector], {
        account: f.admin.account,
      });
      expect(
        await f.authority.read.paramsAllowed([f.staking.address, selector]),
      ).to.equal(true);
      expect(
        await f.authority.read.paramsAllowed([f.strat.address, selector]),
      ).to.equal(false);

      for (const signature of [
        'upgradeToAndCall(address,bytes)',
        'transferOwnership(address)',
      ]) {
        await expectCustomError(
          f.authority.write.allowParams(
            [f.staking.address, toFunctionSelector(signature)],
            { account: f.admin.account },
          ),
          'SelectorNotDelegable',
          'SelectorNotDelegable(bytes4)',
        );
      }

      await f.activateDaoPhase();
      const paramsTl = await impersonate(f.paramsTimelock.address);
      const upgradeTl = await impersonate(f.upgradeTimelock.address);

      await expectCustomError(
        f.authority.write.allowParams([f.staking.address, '0xdeadbeef'], {
          account: paramsTl,
        }),
        'NotUpgradeController',
        'NotUpgradeController(address)',
      );
      await expectCustomError(
        f.authority.write.allowParams([f.staking.address, '0xdeadbeef'], {
          account: f.user1.account,
        }),
        'NotUpgradeController',
        'NotUpgradeController(address)',
      );
      await f.authority.write.allowParams([f.staking.address, '0xdeadbeef'], {
        account: upgradeTl,
      });
      expect(
        await f.authority.read.paramsAllowed([f.staking.address, '0xdeadbeef']),
      ).to.equal(true);

      // Narrowing is allowed on either track.
      await f.authority.write.restrict([f.staking.address, '0xdeadbeef'], {
        account: paramsTl,
      });
      expect(
        await f.authority.read.paramsAllowed([f.staking.address, '0xdeadbeef']),
      ).to.equal(false);
      await expectCustomError(
        f.authority.write.restrict([f.staking.address, '0xdeadbeef'], {
          account: f.user1.account,
        }),
        'NotController',
        'NotController(address,uint8)',
      );
    });

    it('a registered pair is reserved for the upgrade timelock in every phase', async () => {
      const f = await deployGovernanceFixture();
      const data = encodeFunctionData({
        abi: [
          {
            type: 'function',
            name: 'setLiquidityPosition',
            stateMutability: 'nonpayable',
            inputs: [{ name: 'liquidityPosition_', type: 'address' }],
            outputs: [],
          },
        ],
        functionName: 'setLiquidityPosition',
        args: [f.user1.account.address],
      });

      await f.authority.write.restrict(
        [
          f.staking.address,
          toFunctionSelector('setLiquidityPosition(address)'),
        ],
        { account: f.admin.account },
      );

      await expectCustomError(
        f.authority.write.execute([f.staking.address, data], {
          account: f.admin.account,
        }),
        'NotUpgradeController',
        'NotUpgradeController(address)',
      );

      await f.activateDaoPhase();
      const paramsTl = await impersonate(f.paramsTimelock.address);
      await expectCustomError(
        f.authority.write.execute([f.staking.address, data], {
          account: paramsTl,
        }),
        'NotUpgradeController',
        'NotUpgradeController(address)',
      );

      const upgradeTl = await impersonate(f.upgradeTimelock.address);
      const err = await f.authority.write
        .execute([f.staking.address, data], { account: upgradeTl })
        .then(
          () => null,
          (e: Error) => e,
        );
      expect(err).to.not.equal(null);
      expect(String(err)).to.not.include('NotUpgradeController');
    });
  });

  describe('Guardian', () => {
    it('the controller can set and drop the guardian, and after expiry only drop it', async () => {
      const f = await deployGovernanceFixture();

      await expectCustomError(
        f.authority.write.setGuardian([f.user1.account.address], {
          account: f.user1.account,
        }),
        'NotController',
        'NotController(address,uint8)',
      );

      await f.authority.write.setGuardian([f.user1.account.address], {
        account: f.admin.account,
      });
      expect(getAddress(await f.authority.read.guardian())).to.equal(
        getAddress(f.user1.account.address),
      );

      await increaseTime(GUARDIAN_PERIOD * 3n);
      expect(getAddress(await f.authority.read.guardian())).to.equal(
        getAddress(f.user1.account.address),
      );

      await f.activateDaoPhase();
      const paramsTl = await impersonate(f.paramsTimelock.address);
      await increaseTime(GUARDIAN_PERIOD + 1n);

      await expectCustomError(
        f.authority.write.setGuardian([f.user2.account.address], {
          account: paramsTl,
        }),
        'GuardianPeriodOver',
      );

      await f.authority.write.setGuardian([zeroAddress], {
        account: paramsTl,
      });
      expect(await f.authority.read.guardian()).to.equal(zeroAddress);
    });
  });
});
