import { keccak256, toBytes, type Address } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import { env } from '@/env';

/** Simulation actors derived from the deployer key: reproducible, no new secrets. Testnet balances only. */
export const SIM_ACTORS = ['alice', 'bob', 'keeper', 'guardian'] as const;

export type SimActorName = (typeof SIM_ACTORS)[number];

export const simActorKey = (name: SimActorName): `0x${string}` =>
  keccak256(toBytes(`${env.PRIVATE_KEY_DEV ?? ''}:mstrx-sim:${name}`));

export const simActorAddress = (name: SimActorName): Address =>
  privateKeyToAccount(simActorKey(name)).address;
