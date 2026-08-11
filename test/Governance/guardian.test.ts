import { expect } from 'chai';
import hre from 'hardhat';
import { encodeFunctionData, getAddress, zeroAddress } from 'viem';

import { deployProtocol, type DeployResult } from '../../scripts/deploy';
import { deployPoolManager } from '../../scripts/lib/uniswap-v4-local';
import { ISOLATED } from '../Deploy/_profiles';

const HOUR = 3600;

const warp = async (seconds: number) => {
  await hre.network.provider.send('evm_increaseTime', [seconds]);
  await hre.network.provider.send('evm_mine');
};

/// The guardian can pause and cancel, never move value, and its rights expire on their own,
/// counted from Genesis finalization.
describe('ProtocolAuthority — the guardian expires on its own', function () {
  this.timeout(300_000);

  let d: DeployResult;
  let guardian: any;
  let outsider: any;

  before(async () => {
    const clients = await hre.viem.getWalletClients();
    guardian = clients[5];
    outsider = clients[6];

    const poolManager = await deployPoolManager();
    d = await deployProtocol({
      ...ISOLATED,
      poolManager,
      guardian: guardian.account.address,
      guardianPeriodSeconds: BigInt(2 * HOUR),
    });
  });

  it('is a different address from the admin, and is named by the authority', async () => {
    expect(getAddress(await d.authority.read.guardian())).to.equal(
      getAddress(guardian.account.address),
    );
    expect(getAddress(await d.authority.read.appointedGuardian())).to.equal(
      getAddress(guardian.account.address),
    );
    expect(await d.authority.read.guardian()).to.not.equal(
      await d.authority.read.admin(),
    );
  });

  it('can stop a module but never restart it, and outsiders can do neither', async () => {
    await expect(d.bonding.write.pause({ account: outsider.account })).to.be
      .rejected;

    await d.bonding.write.pause({ account: guardian.account });
    expect(await d.bonding.read.paused()).to.equal(true);

    // Unpausing is the owner's.
    await expect(d.bonding.write.unpause({ account: guardian.account })).to.be
      .rejected;

    await d.authority.write.execute([
      d.bonding.address,
      encodeFunctionData({
        abi: d.bonding.abi,
        functionName: 'unpause',
        args: [],
      }),
    ]);
    expect(await d.bonding.read.paused()).to.equal(false);
  });

  it('can never move value, change a parameter or upgrade anything', async () => {
    const a = { account: guardian.account };

    await expect(
      d.authority.write.execute(
        [
          d.bonding.address,
          encodeFunctionData({
            abi: d.bonding.abi,
            functionName: 'setProceedsRouting',
            args: [2_000, 200],
          }),
        ],
        a,
      ),
    ).to.be.rejected;

    await expect(d.treasury.write.redeem([10n ** 18n, 0n], a)).to.be.rejected;
    await expect(
      d.staking.write.redeemToPremiumReserve(
        [guardian.account.address, 10n ** 18n],
        a,
      ),
    ).to.be.rejected;
    await expect(d.treasury.write.setBtcOutflowBps([1], a)).to.be.rejected;
  });

  it('does not expire while Genesis is open, however long that lasts', async () => {
    await warp(8 * HOUR);
    expect(getAddress(await d.authority.read.guardian())).to.equal(
      getAddress(guardian.account.address),
    );
    expect(await d.authority.read.GUARDIAN_EXPIRY()).to.equal(2n ** 64n - 1n);
  });

  it('stops being anyone a period after finalization, with no vote at all', async () => {
    // Last in the file: finalizing revokes the admin.
    await d.authority.write.finalizeGenesis();
    const expiry = await d.authority.read.GUARDIAN_EXPIRY();
    expect(expiry).to.equal(
      (await d.authority.read.genesisFinalizedAt()) +
        (await d.authority.read.GUARDIAN_PERIOD()),
    );

    const now = (await d.publicClient.getBlock()).timestamp;
    await warp(Number(expiry - now) + 1);

    expect(await d.authority.read.guardian()).to.equal(zeroAddress);
    expect(getAddress(await d.authority.read.appointedGuardian())).to.equal(
      getAddress(guardian.account.address),
    );

    await expect(d.bonding.write.pause({ account: guardian.account })).to.be
      .rejected;
    expect(await d.bonding.read.paused()).to.equal(false);

    await expect(
      d.authority.write.execute([
        d.authority.address,
        encodeFunctionData({
          abi: d.authority.abi,
          functionName: 'setGuardian',
          args: [outsider.account.address],
        }),
      ]),
    ).to.be.rejected;
  });
});
