import hre from 'hardhat';
import {
  encodeFunctionData,
  getAbiItem,
  toFunctionSelector,
  type Abi,
  type AbiFunction,
  type Address,
  type Hex,
} from 'viem';

import { waitForSuccess } from './tx';

/** F-06: STRAT-selling calls (and so vote-selling ones) move to the upgrade track at the end of Genesis. */
export const DAO_RESERVED_CALLS = [
  { contract: 'Bonding', fn: 'createSeries' },
  { contract: 'PremiumSales', fn: 'setSwapExecutor' },
  { contract: 'PremiumSales', fn: 'setBands' },
  { contract: 'PremiumSales', fn: 'setWindowLength' },
] as const;

export type SealTargets = {
  authority: Address;
  bonding: Address;
  premiumSales: Address;
};

export type ReservedCall = {
  label: string;
  target: Address;
  selector: Hex;
};

/// Selectors come from the compiled ABIs, so a changed signature cannot go stale.
export async function reservedCalls(
  targets: SealTargets,
): Promise<ReservedCall[]> {
  const abis: Record<string, Abi> = {
    Bonding: (await hre.artifacts.readArtifact('Bonding')).abi as Abi,
    PremiumSales: (await hre.artifacts.readArtifact('PremiumSales')).abi as Abi,
  };
  const addressOf: Record<string, Address> = {
    Bonding: targets.bonding,
    PremiumSales: targets.premiumSales,
  };
  return DAO_RESERVED_CALLS.map(({ contract, fn }) => {
    const item = getAbiItem({ abi: abis[contract]!, name: fn }) as
      | AbiFunction
      | undefined;
    if (!item) throw new Error(`${contract}.${fn} is not in the ABI`);
    return {
      label: `${contract}.${fn}`,
      target: addressOf[contract]!,
      selector: toFunctionSelector(item),
    };
  });
}

/** Cuts the newest series to what was sold and reserves `DAO_RESERVED_CALLS`. Verified on chain; idempotent. */
export async function sealGenesis(
  targets: SealTargets,
  admin: Address,
  log: (...args: unknown[]) => void = console.log,
): Promise<ReservedCall[]> {
  const authority = await hre.viem.getContractAt(
    'ProtocolAuthority',
    targets.authority,
  );
  const bonding = await hre.viem.getContractAt('Bonding', targets.bonding);
  const account = { account: admin };

  const count = await bonding.read.nextSeriesId();
  if (count > 0) {
    const id = count - 1;
    const s = await bonding.read.getSeries([id]);
    if (s.capacityMstrat > s.filledMstrat) {
      await waitForSuccess(
        await authority.write.execute(
          [
            bonding.address,
            encodeFunctionData({
              abi: bonding.abi,
              functionName: 'retuneSeries',
              args: [id, s.filledMstrat, s.vestingTerm, s.endTime],
            }),
          ],
          account,
        ),
        `Bonding.retuneSeries(${id}): capacity down to what has been sold`,
      );
      log(
        `  Series ${id}: capacity ${s.capacityMstrat} -> ${s.filledMstrat}, nothing left to reactivate`,
      );
    }
    if ((await bonding.read.getSeries([id])).isActive) {
      await waitForSuccess(
        await authority.write.execute(
          [
            bonding.address,
            encodeFunctionData({
              abi: bonding.abi,
              functionName: 'setSeriesActive',
              args: [id, false],
            }),
          ],
          account,
        ),
        `Bonding.setSeriesActive(${id}, false)`,
      );
      log(`  Series ${id}: closed`);
    }
    if ((await bonding.read.getRemainingCapacity([id])) !== 0n) {
      throw new Error(`series ${id} still has capacity left to sell`);
    }
  }

  const calls = await reservedCalls(targets);
  for (const { label, target, selector } of calls) {
    if (await authority.read.restricted([target, selector])) continue;
    await waitForSuccess(
      await authority.write.restrict([target, selector], account),
      `ProtocolAuthority.restrict: ${label}`,
    );
    log(`  Reserved for the upgrade timelock: ${label}`);
  }
  for (const { label, target, selector } of calls) {
    if (!(await authority.read.restricted([target, selector]))) {
      throw new Error(`${label} is not reserved for the upgrade timelock`);
    }
  }
  return calls;
}
