import { expect } from 'chai';
import hre from 'hardhat';
import {
  encodeFunctionData,
  getAddress,
  parseAbiItem,
  zeroAddress,
  type Abi,
  type AbiFunction,
  type Address,
} from 'viem';

import { ISOLATED } from '../Deploy/_profiles';
import { deployProtocol } from '../../scripts/deploy';
import { impersonate } from '../Governance/_setupGovernance';
import { deployUniswapV4 } from '../Integration/_uniswap';
import {
  ERC1967_IMPLEMENTATION_SLOT,
  deployImplementation,
  encodeUpgradeToAndCall,
  expectCustomError,
  getImplementation,
} from '../_helpers';

const WAD = 10n ** 18n;
const BTC = 10n ** 8n;

/// Zero arguments: `initializer` must reject before the body reads them.
const zeroInitArgs = (abi: Abi) => {
  const fn = abi.find(
    (item) => item.type === 'function' && item.name === 'initialize',
  ) as AbiFunction | undefined;
  if (!fn) throw new Error('no initialize() in ABI');
  return fn.inputs.map((input) => {
    if (input.type === 'address') return zeroAddress;
    if (input.type === 'bool') return false;
    if (/^u?int/.test(input.type)) return 0n;
    throw new Error(`unsupported initializer input ${input.type}`);
  });
};

const UPGRADED_EVENT = parseAbiItem(
  'event Upgraded(address indexed implementation)',
);

describe('Upgradeability — immutable core, replaceable modules', function () {
  this.timeout(180_000);

  let d: Awaited<ReturnType<typeof deployProtocol>>;
  let modules: Array<{ name: string; address: Address; abi: Abi }>;
  let publicClient: Awaited<ReturnType<typeof hre.viem.getPublicClient>>;
  let deployer: Awaited<ReturnType<typeof hre.viem.getWalletClients>>[number];
  let user: Awaited<ReturnType<typeof hre.viem.getWalletClients>>[number];
  let guardian: Awaited<ReturnType<typeof hre.viem.getWalletClients>>[number];
  let upgradeTl: Address;

  before(async () => {
    [deployer, user, , , guardian] = await hre.viem.getWalletClients();
    publicClient = await hre.viem.getPublicClient();

    const uni = await deployUniswapV4();
    d = await deployProtocol({
      // See `protocol.e2e.test.ts`: a populated `.env` would point at a mainnet cbBTC.
      ...ISOLATED,
      log: false,
      poolManager: uni.poolManager,
      guardian: guardian.account.address,
      // Sized against the issued supply, not the full 50M.
      seedBtcToTreasury: 2n * 10n ** 7n,
    });

    modules = [
      {
        name: 'PremiumSales',
        address: d.premiumSales.address,
        abi: d.premiumSales.abi,
      },
      {
        name: 'Redemption',
        address: d.redemption.address,
        abi: d.redemption.abi,
      },
      {
        name: 'VestingVault',
        address: d.vestingVault.address,
        abi: d.vestingVault.abi,
      },
      { name: 'Bonding', address: d.bonding.address, abi: d.bonding.abi },
      { name: 'FeeVault', address: d.feeVault.address, abi: d.feeVault.abi },
    ] as Array<{ name: string; address: Address; abi: Abi }>;

    upgradeTl = await impersonate(d.upgradeTimelock.address);
  });

  it('modules sit behind ERC-1967 proxies owned by the authority', async () => {
    for (const { name, address, abi } of modules) {
      const impl = await getImplementation(address);
      expect(impl, `${name} implementation`).to.not.equal(zeroAddress);
      expect(
        (d.implementations as Record<string, Address>)[name],
        `${name} reported by deploy`,
      ).to.equal(impl);

      const uuid = await publicClient.readContract({
        address: impl,
        abi,
        functionName: 'proxiableUUID',
      });
      expect(uuid, `${name} proxiableUUID`).to.equal(
        ERC1967_IMPLEMENTATION_SLOT,
      );

      const owner = (await publicClient.readContract({
        address,
        abi,
        functionName: 'owner',
      })) as Address;
      expect(getAddress(owner), `${name} owner`).to.equal(
        getAddress(d.authority.address),
      );
    }
  });

  it('the value layer has no proxy and therefore no upgrade path', async () => {
    for (const [name, address] of [
      ['Treasury', d.treasury.address],
      ['Staking', d.staking.address],
      ['STRAT', d.strat.address],
      ['VVEST', d.vvest.address],
      ['ProtocolAuthority', d.authority.address],
    ] as const) {
      const slot = await publicClient.getStorageAt({
        address,
        slot: ERC1967_IMPLEMENTATION_SLOT,
      });
      expect(
        BigInt(slot ?? '0x0'),
        `${name} must not have an implementation slot`,
      ).to.equal(0n);

      const abi = [
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
      ] as const;
      await expect(
        deployer.writeContract({
          address,
          abi,
          functionName: 'upgradeToAndCall',
          args: [d.strat.address, '0x'],
        }),
        `${name} must not expose upgradeToAndCall`,
      ).to.be.rejected;
    }
  });

  it('implementations are locked and proxies cannot be initialized twice', async () => {
    for (const { address, abi } of modules) {
      const data = encodeFunctionData({
        abi,
        functionName: 'initialize',
        args: zeroInitArgs(abi),
      });
      const impl = await getImplementation(address);

      await expectCustomError(
        publicClient.call({ to: impl, data, account: deployer.account }),
        'InvalidInitialization',
      );
      await expectCustomError(
        publicClient.call({ to: address, data, account: deployer.account }),
        'InvalidInitialization',
      );
    }
  });

  it('only the authority can upgrade, and only through the upgrade timelock', async () => {
    const target = await deployImplementation('BondingV2Mock');

    for (const { address, abi } of modules) {
      for (const who of [user, deployer]) {
        await expectCustomError(
          who.writeContract({
            address,
            abi,
            functionName: 'upgradeToAndCall',
            args: [target.address, '0x'],
          }),
          'OwnableUnauthorizedAccount',
          'OwnableUnauthorizedAccount(address)',
        );
      }

      await expectCustomError(
        deployer.writeContract({
          address: await getImplementation(address),
          abi,
          functionName: 'upgradeToAndCall',
          args: [target.address, '0x'],
        }),
        'UUPSUnauthorizedCallContext',
      );

      const paramsTl = await impersonate(d.paramsTimelock.address);
      await expectCustomError(
        d.authority.write.execute(
          [address, encodeUpgradeToAndCall(abi, target.address)],
          { account: paramsTl },
        ),
        'NotUpgradeController',
        'NotUpgradeController(address)',
      );
    }
  });

  it('rejects an implementation that is not UUPS', async () => {
    const before = await getImplementation(d.bonding.address);
    await expectCustomError(
      d.authority.write.execute(
        [
          d.bonding.address,
          encodeUpgradeToAndCall(d.bonding.abi as Abi, d.btc.address),
        ],
        { account: upgradeTl },
      ),
      'ERC1967InvalidImplementation',
      'ERC1967InvalidImplementation(address)',
    );
    expect(await getImplementation(d.bonding.address)).to.equal(before);
  });

  it('Bonding upgrades to V2: state, wiring and owner survive', async () => {
    // A live series is the module's richest storage, so the upgrade must carry it.
    await d.authority.write.execute([
      d.bonding.address,
      encodeFunctionData({
        abi: d.bonding.abi,
        functionName: 'createSeries',
        args: [
          12n * 10n ** 13n, // 0.00012 BTC per STRAT
          0n,
          4_000_000_000n,
          7n * 24n * 3600n,
          1_000_000n * WAD,
          1n,
        ],
      }),
    ]);

    const before = {
      btc: await d.bonding.read.BTC_TOKEN(),
      strat: await d.bonding.read.STRAT_TOKEN(),
      treasury: await d.bonding.read.TREASURY(),
      vault: await d.bonding.read.VESTING_VAULT(),
      vvest: await d.bonding.read.vvestToken(),
      oracle: await d.bonding.read.priceOracle(),
      swapExecutor: await d.bonding.read.swapExecutor(),
      liquidityPosition: await d.bonding.read.liquidityPosition(),
      devWallet: await d.bonding.read.devWallet(),
      liquidityBps: await d.bonding.read.liquidityBps(),
      devBps: await d.bonding.read.devBps(),
      slippage: await d.bonding.read.bondSwapSlippageBps(),
      nextSeries: await d.bonding.read.nextSeriesId(),
      series: await d.bonding.read.getSeries([0]),
    };
    expect(before.nextSeries).to.equal(1);
    expect(before.liquidityBps).to.equal(600);
    expect(before.devBps).to.equal(200);

    const v2 = await hre.viem.deployContract('BondingV2Mock', []);
    const initV2 = encodeFunctionData({
      abi: v2.abi,
      functionName: 'initializeV2',
      args: [42n],
    });

    const fromBlock = await publicClient.getBlockNumber();
    await d.authority.write.execute(
      [
        d.bonding.address,
        encodeUpgradeToAndCall(d.bonding.abi as Abi, v2.address, initV2),
      ],
      { account: upgradeTl },
    );

    const upgraded = await hre.viem.getContractAt(
      'BondingV2Mock',
      d.bonding.address,
    );

    expect(await getImplementation(d.bonding.address)).to.equal(
      getAddress(v2.address),
    );
    const events = await publicClient.getLogs({
      address: d.bonding.address,
      event: UPGRADED_EVENT,
      fromBlock,
    });
    expect(events).to.have.length(1);

    expect(await upgraded.read.version()).to.equal(2n);
    expect(await upgraded.read.v2Value()).to.equal(42n);

    expect(await upgraded.read.BTC_TOKEN()).to.equal(before.btc);
    expect(await upgraded.read.STRAT_TOKEN()).to.equal(before.strat);
    expect(await upgraded.read.TREASURY()).to.equal(before.treasury);
    expect(await upgraded.read.VESTING_VAULT()).to.equal(before.vault);
    expect(await upgraded.read.vvestToken()).to.equal(before.vvest);
    expect(await upgraded.read.priceOracle()).to.equal(before.oracle);
    expect(await upgraded.read.swapExecutor()).to.equal(before.swapExecutor);
    expect(await upgraded.read.liquidityPosition()).to.equal(
      before.liquidityPosition,
    );
    expect(await upgraded.read.devWallet()).to.equal(before.devWallet);
    expect(await upgraded.read.liquidityBps()).to.equal(before.liquidityBps);
    expect(await upgraded.read.devBps()).to.equal(before.devBps);
    expect(await upgraded.read.bondSwapSlippageBps()).to.equal(before.slippage);
    expect(await upgraded.read.nextSeriesId()).to.equal(before.nextSeries);
    expect(await upgraded.read.getSeries([0])).to.deep.equal(before.series);
    expect(getAddress(await upgraded.read.owner())).to.equal(
      getAddress(d.authority.address),
    );

    await expectCustomError(
      upgraded.write.initializeV2([43n], { account: upgradeTl }),
      'InvalidInitialization',
    );
  });

  it('a hostile Redemption upgrade still cannot drain the Treasury', async () => {
    const [, , , bystander] = await hre.viem.getWalletClients();
    for (const [who, amount] of [
      [user, 20_000n * WAD],
      [bystander, 5_000n * WAD],
    ] as const) {
      await d.strat.write.transfer([who.account.address, amount], {
        account: deployer.account,
      });
      await d.strat.write.approve([d.staking.address, amount], {
        account: who.account,
      });
      await d.staking.write.stake([amount], { account: who.account });
    }

    expect(await d.authority.read.genesisFinalized()).to.equal(false);
    await expectCustomError(
      d.treasury.write.redeem([1n * WAD, 0n], { account: user.account }),
      'RedemptionNotOpen',
      'RedemptionNotOpen(uint256)',
    );

    await d.authority.write.finalizeGenesis();
    await hre.network.provider.send('evm_setNextBlockTimestamp', [
      Number(await d.treasury.read.redemptionOpensAt()),
    ]);
    await hre.network.provider.send('evm_mine', []);
    expect(await d.treasury.read.redemptionOpen()).to.equal(true);

    // A hostile Redemption: no curve, no cap, no THF, absurd prices.
    const hostile = await hre.viem.deployContract('RedemptionV2Mock', []);
    await d.authority.write.execute(
      [
        d.redemption.address,
        encodeUpgradeToAndCall(d.redemption.abi as Abi, hostile.address),
      ],
      { account: upgradeTl },
    );
    const attacker = await hre.viem.getContractAt(
      'RedemptionV2Mock',
      d.redemption.address,
    );
    expect(await attacker.read.version()).to.equal(2n);

    const treasuryBtc = await d.treasury.read.btcBalance();
    const nav = await d.treasury.read.navBtcPerStrat();
    const cap = await d.treasury.read.redeemCapacity();
    const bps = await d.treasury.read.MAX_REDEEM_BPS_PER_WINDOW();
    const supply = await d.treasury.read.backingSupply();
    expect(cap).to.equal((supply * BigInt(bps)) / 10_000n);

    await expectCustomError(
      d.treasury.write.redeem([cap + 1n, 0n], { account: user.account }),
      'RedemptionCapExceeded',
      'RedemptionCapExceeded(uint256,uint256)',
    );

    // Clipped to 95% of NAV and paid only to the redeeming staker.
    await d.treasury.write.redeem([cap, 0n], { account: user.account });
    const paid = await d.btc.read.balanceOf([user.account.address]);
    expect(paid).to.equal((((cap * nav) / WAD) * 9_500n) / 10_000n / 10n ** 10n);
    expect(paid * 1_000n < treasuryBtc, 'a sliver, not a drain').to.equal(true);

    await expectCustomError(
      d.treasury.write.redeem([1_000n * WAD, 0n], { account: user.account }),
      'RedemptionCapExceeded',
      'RedemptionCapExceeded(uint256,uint256)',
    );

    const [position] = await d.staking.read.getStake([
      bystander.account.address,
    ]);
    expect(position.amount).to.equal(5_000n * WAD);

    expect(await d.treasury.read.btcBalance()).to.equal(treasuryBtc - paid);
    expect((await d.treasury.read.navBtcPerStrat()) > nav).to.equal(true);
  });

  it('the guardian can pause a module and only the owner can resume it', async () => {
    expect(getAddress(await d.bonding.read.guardian())).to.equal(
      getAddress(guardian.account.address),
    );

    await expectCustomError(
      d.bonding.write.pause({ account: user.account }),
      'NotGuardian',
      'NotGuardian(address)',
    );

    await d.bonding.write.pause({ account: guardian.account });
    expect(await d.bonding.read.paused()).to.equal(true);

    await expectCustomError(
      d.bonding.write.unpause({ account: guardian.account }),
      'OwnableUnauthorizedAccount',
      'OwnableUnauthorizedAccount(address)',
    );

    await d.authority.write.execute(
      [
        d.bonding.address,
        encodeFunctionData({
          abi: d.bonding.abi,
          functionName: 'unpause',
          args: [],
        }),
      ],
      { account: await impersonate(d.paramsTimelock.address) },
    );
    expect(await d.bonding.read.paused()).to.equal(false);
  });
});
