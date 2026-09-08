import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import hre from 'hardhat';

import { env } from '@/env';

import type { Profile } from './profiles';

/** A V4 pool key: calls take the key, not the id. */
export type PoolRecord = {
  id: string;
  currency0: string;
  currency1: string;
  fee: number;
  tickSpacing: number;
  hooks: string;
};

export type DeploymentFile = {
  network: string;
  deployment: string;
  profile: Profile;
  startBlock: number;
  mocks: boolean;
  addresses: Record<string, string>;
  implementations: Record<string, string>;
  pools?: Record<string, PoolRecord>;
};

/// Read from `process.env` so a script can set its own default before loading anything.
export const deploymentName = (): string =>
  process.env.DEPLOYMENT || env.DEPLOYMENT || hre.network.name;

export const deploymentFile = (name: string = deploymentName()): string =>
  `deployments/${name}.json`;

export const argsFile = (name: string = deploymentName()): string =>
  `deployments/${name}.args.json`;

export function writeJson(file: string, data: unknown): string {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(
    file,
    JSON.stringify(
      data,
      (_key, value) => (typeof value === 'bigint' ? value.toString() : value),
      2,
    ) + '\n',
  );
  return file;
}

export function loadDeployment(
  name: string = deploymentName(),
): DeploymentFile {
  const file = deploymentFile(name);
  if (!existsSync(file)) {
    throw new Error(`no deployment file for ${name} (${file})`);
  }
  return JSON.parse(readFileSync(file, 'utf8')) as DeploymentFile;
}
