import { expect } from 'chai';
import hre from 'hardhat';
import { encodeFunctionData, zeroAddress, zeroHash } from 'viem';

import { expectCustomError } from '../_helpers';
import { increaseTime } from './_setupGovernance';

/** A self-call may not grant proposer or admin roles to ordinary addresses or shorten the delay; a wiring admin may. */
describe('StratTimelock — a proposal cannot vote itself permanent', function () {
  this.timeout(300_000);

  const DELAY = 100n;

  const deploy = async () => {
    const [deployer] = await hre.viem.getWalletClients();
    const timelock = await hre.viem.deployContract('StratTimelock', [
      DELAY,
      [deployer.account.address],
      [zeroAddress],
      deployer.account.address,
    ]);
    return { deployer, timelock };
  };

  const selfCall = async (
    timelock: Awaited<ReturnType<typeof deploy>>['timelock'],
    data: `0x${string}`,
  ) => {
    // The current delay: one test lengthens it.
    const delay = await timelock.read.getMinDelay();
    await timelock.write.schedule([
      timelock.address,
      0n,
      data,
      zeroHash,
      zeroHash,
      delay,
    ]);
    await increaseTime(delay + 1n);
    return timelock.write.execute([
      timelock.address,
      0n,
      data,
      zeroHash,
      zeroHash,
    ]);
  };

  const grant = (
    timelock: Awaited<ReturnType<typeof deploy>>['timelock'],
    role: `0x${string}`,
    account: `0x${string}`,
  ) =>
    encodeFunctionData({
      abi: timelock.abi,
      functionName: 'grantRole',
      args: [role, account],
    });

  it('refuses to grant itself a standing proposer or admin', async () => {
    const { deployer, timelock } = await deploy();
    const PROPOSER_ROLE = await timelock.read.PROPOSER_ROLE();
    const ADMIN_ROLE = await timelock.read.DEFAULT_ADMIN_ROLE();

    for (const role of [PROPOSER_ROLE, ADMIN_ROLE]) {
      await expectCustomError(
        selfCall(timelock, grant(timelock, role, deployer.account.address)),
        'RoleNotSelfGrantable',
        'RoleNotSelfGrantable(bytes32)',
      );
    }
  });

  it('still grants the roles that are not an escalation', async () => {
    const { deployer, timelock } = await deploy();
    const CANCELLER_ROLE = await timelock.read.CANCELLER_ROLE();

    await selfCall(
      timelock,
      grant(timelock, CANCELLER_ROLE, deployer.account.address),
    );
    expect(
      await timelock.read.hasRole([CANCELLER_ROLE, deployer.account.address]),
    ).to.equal(true);
  });

  it('leaves the deployment path alone: an outside admin may still wire a proposer', async () => {
    const { deployer, timelock } = await deploy();
    const PROPOSER_ROLE = await timelock.read.PROPOSER_ROLE();
    const [, other] = await hre.viem.getWalletClients();

    // Not a self-call, so allowed: this is how a deployment wires governors.
    await timelock.write.grantRole([PROPOSER_ROLE, other.account.address], {
      account: deployer.account,
    });
    expect(
      await timelock.read.hasRole([PROPOSER_ROLE, other.account.address]),
    ).to.equal(true);
  });

  it('may lengthen its own delay but never shorten it past the launch value', async () => {
    const { timelock } = await deploy();
    const setDelay = (value: bigint) =>
      encodeFunctionData({
        abi: timelock.abi,
        functionName: 'updateDelay',
        args: [value],
      });

    expect(await timelock.read.MIN_DELAY_FLOOR()).to.equal(DELAY);

    for (const shorter of [0n, DELAY - 1n]) {
      await expectCustomError(
        selfCall(timelock, setDelay(shorter)),
        'DelayBelowFloor',
        'DelayBelowFloor(uint256,uint256)',
      );
    }

    await selfCall(timelock, setDelay(DELAY * 3n));
    expect(await timelock.read.getMinDelay()).to.equal(DELAY * 3n);

    await selfCall(timelock, setDelay(DELAY));
    expect(await timelock.read.getMinDelay()).to.equal(DELAY);
  });
});
