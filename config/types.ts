import { type GetContractReturnType } from '@nomicfoundation/hardhat-viem/types';
import { type Abi } from 'viem';
import { z } from 'zod';

const networks = [
  'main',
  'sepolia',
  // Arbitrum Orbit: `block.number` estimates L1, so STRAT and the governor clock on timestamps.
  'robinhood',
  'robinhoodTestnet',
  'hardhat',
  'localhost',
] as const;
export const networksEnum = z.enum(networks);

export type Network = z.infer<typeof networksEnum>;
export type RpcUrl = string;
export type NetworkConfigParam<T> = Record<Network, T>;

export type Contract<
  T extends { abi: Abi | readonly unknown[] } = { abi: [] },
> = GetContractReturnType<T['abi']>;
