import hre from 'hardhat';
import { encodeFunctionData, getAddress, type Abi, type Address } from 'viem';
import type { GetContractReturnType } from '@nomicfoundation/hardhat-viem/types';

import type { Bonding$Type } from '../../artifacts/contracts/core/Bonding.sol/Bonding';
import type { FeeVault$Type } from '../../artifacts/contracts/core/FeeVault.sol/FeeVault';
import type { PremiumSales$Type } from '../../artifacts/contracts/core/PremiumSales.sol/PremiumSales';
import type { Redemption$Type } from '../../artifacts/contracts/core/Redemption.sol/Redemption';
import type { VestingVault$Type } from '../../artifacts/contracts/core/VestingVault.sol/VestingVault';

/** UUPS helpers. `deployUups` initializes the proxy in its constructor, so it is never left uninitialized. */

/// Contracts behind proxies; the value and control layers have none.
export type UupsAbis = {
  PremiumSales: PremiumSales$Type['abi'];
  Redemption: Redemption$Type['abi'];
  VestingVault: VestingVault$Type['abi'];
  Bonding: Bonding$Type['abi'];
  FeeVault: FeeVault$Type['abi'];
};
export type UupsName = keyof UupsAbis;

export const UUPS_CONTRACTS: readonly UupsName[] = [
  'PremiumSales',
  'Redemption',
  'VestingVault',
  'Bonding',
  'FeeVault',
] as const;

/// keccak256("eip1967.proxy.implementation") - 1
export const ERC1967_IMPLEMENTATION_SLOT =
  '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc' as const;

type DeployOpts = Parameters<typeof hre.viem.deployContract>[2];

export async function deployImplementation(
  name: string,
  opts?: DeployOpts,
): Promise<GetContractReturnType> {
  return (await hre.viem.deployContract(
    name as never,
    [],
    opts as any,
  )) as unknown as GetContractReturnType;
}

export function encodeInitialize(abi: Abi, args: readonly unknown[]) {
  return encodeFunctionData({
    abi,
    functionName: 'initialize',
    args: args as any,
  });
}

/// Implementation plus initialized ERC1967Proxy, bound to the implementation ABI.
export async function deployUups<CN extends UupsName>(
  name: CN,
  initArgs: readonly unknown[],
  opts?: DeployOpts,
): Promise<GetContractReturnType<UupsAbis[CN]>> {
  const implementation = await deployImplementation(name, opts);
  const data = encodeInitialize(implementation.abi as Abi, initArgs);
  const proxy = await hre.viem.deployContract(
    'ERC1967Proxy',
    [implementation.address, data],
    opts as any,
  );
  return (await hre.viem.getContractAt(
    name as never,
    proxy.address,
    opts as any,
  )) as unknown as GetContractReturnType<UupsAbis[CN]>;
}

/// Retries an empty slot: a load-balanced RPC may not have seen the proxy yet.
export async function getImplementation(
  proxy: Address,
  opts: { attempts?: number; delayMs?: number } = {},
): Promise<Address> {
  const { attempts = 5, delayMs = 500 } = opts;
  const publicClient = await hre.viem.getPublicClient();
  for (let attempt = 1; ; attempt += 1) {
    const raw = await publicClient.getStorageAt({
      address: proxy,
      slot: ERC1967_IMPLEMENTATION_SLOT,
    });
    if (raw && BigInt(raw) !== 0n) return getAddress('0x' + raw.slice(-40));
    if (attempt >= attempts) {
      throw new Error(
        `No implementation behind ${proxy}: the ERC-1967 slot is empty after ${attempts} reads`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
}

/// `upgradeToAndCall` calldata; the authority accepts it only from the upgrade timelock.
export function encodeUpgradeToAndCall(
  abi: Abi,
  newImplementation: Address,
  data: `0x${string}` = '0x',
) {
  return encodeFunctionData({
    abi,
    functionName: 'upgradeToAndCall',
    args: [newImplementation, data],
  });
}
