import { expect } from 'chai';
import hre from 'hardhat';

import { deployTreasuryContract } from '../Treasury/_setupTreasury';

const WAD = 10n ** 18n;

/// Money figures are decimals-independent; only `btcBalance` is in raw token units.
describe('ProtocolReader — decimals (unit)', () => {
  const dashboard = async (btcDecimals: number) => {
    const [deployer] = await hre.viem.getWalletClients();
    const btc = await hre.viem.deployContract('MockERC20', [
      'B',
      'B',
      btcDecimals,
    ]);
    const strat = await hre.viem.deployContract('MockERC20', ['S', 'S', 18]);

    const treasury = await deployTreasuryContract(
      deployer.account.address,
      btc.address,
      strat.address,
    );

    await btc.write.mint([treasury.address, 2n * 10n ** BigInt(btcDecimals)]);
    const stray = await hre.viem.deployContract('MockERC20', ['X', 'X', 6]);
    await stray.write.mint([treasury.address, 10_000n * 10n ** 6n]);

    const reader = await hre.viem.deployContract('ProtocolReader', [
      treasury.address,
      strat.address,
      strat.address,
      strat.address,
      strat.address,
      strat.address,
      btc.address,
      strat.address,
      strat.address,
      strat.address,
      strat.address,
    ]);
    return reader.read.getDashboard();
  };

  it('same values whatever the token decimals, and a stray token changes none of them', async () => {
    for (const decimals of [8, 18, 6]) {
      const d = await dashboard(decimals);

      expect(d.treasuryBtc, `btc ${decimals}`).to.equal(2n * WAD);

      expect(d.btcBalance, `raw ${decimals}`).to.equal(
        2n * 10n ** BigInt(decimals),
      );
    }
  });
});
