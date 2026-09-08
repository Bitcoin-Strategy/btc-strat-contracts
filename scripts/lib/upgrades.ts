import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import {
  assertUpgradeSafe,
  getContractVersion,
  getStorageLayout,
  getStorageUpgradeReport,
  solcInputOutputDecoder,
  validate,
  withValidationDefaults,
  type StorageLayout,
  type ValidationData,
  type ValidationRunData,
  type Version,
} from '@openzeppelin/upgrades-core';

import { UUPS_CONTRACTS } from './proxy';

/**
//  * Upgrade-safety tooling on @openzeppelin/upgrades-core. `upgrades/<network>.json` stores the deployed
//  * layouts; `validateUpgrade()` rejects reordered, removed or retyped variables. Commit that file.
//  */

export const BUILD_INFO_DIR = 'artifacts/build-info';
export const MOCKS_GLOB = 'contracts/mocks/**/*.sol';

export const layoutsFile = (network: string) =>
  path.join('upgrades', `${network}.json`);

export type LayoutReference = {
  implementation?: string;
  solcVersion?: string;
  updatedAt: string;
  layout: StorageLayout;
};
export type LayoutReferences = Record<string, LayoutReference>;

export function validateUpgradeSafety(opts: { quiet?: boolean } = {}): string {
  const cmd = [
    'npx',
    '@openzeppelin/upgrades-core',
    'validate',
    BUILD_INFO_DIR,
    '--exclude',
    `"${MOCKS_GLOB}"`,
  ].join(' ');

  try {
    return execSync(cmd, {
      stdio: opts.quiet ? 'pipe' : 'inherit',
      encoding: 'utf8',
    });
  } catch (error: any) {
    const output = [error?.stdout, error?.stderr].filter(Boolean).join('\n');
    throw new Error(`Upgrade safety validation failed\n${output}`);
  }
}

type BuildInfo = {
  solcVersion: string;
  input: Parameters<typeof solcInputOutputDecoder>[0];
  output: Parameters<typeof solcInputOutputDecoder>[1];
};

/// Newest build-info first: incremental compiles can hold several versions of a contract.
export function loadValidations(): {
  runs: Array<{ run: ValidationRunData; solcVersion: string; file: string }>;
  data: ValidationData;
} {
  if (!fs.existsSync(BUILD_INFO_DIR)) {
    throw new Error(
      `${BUILD_INFO_DIR} not found; run "npx hardhat compile" first`,
    );
  }
  const runs = fs
    .readdirSync(BUILD_INFO_DIR)
    .filter((file) => file.endsWith('.json'))
    .map((file) => ({
      file,
      mtimeMs: fs.statSync(path.join(BUILD_INFO_DIR, file)).mtimeMs,
    }))
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .map(({ file }) => {
      const info = JSON.parse(
        fs.readFileSync(path.join(BUILD_INFO_DIR, file), 'utf8'),
      ) as BuildInfo;
      const decodeSrc = solcInputOutputDecoder(info.input, info.output);
      return {
        run: validate(info.output, decodeSrc, info.solcVersion, info.input),
        solcVersion: info.solcVersion,
        file,
      };
    });
  const data = {
    version: '3.4',
    log: runs.map((r) => r.run),
  } as ValidationData;
  return { runs, data };
}

/// Uses the newest build-info holding the contract and reports ambiguity, so a stale job is never validated.
export function getContractLayout(
  contract: string,
  opts: { assertSafe?: boolean } = {},
): { version: Version; layout: StorageLayout; solcVersion: string } {
  const { runs, data } = loadValidations();

  const matches: Array<{ version: Version; solcVersion: string; file: string }> =
    [];
  for (const { run, solcVersion, file } of runs) {
    try {
      matches.push({ version: getContractVersion(run, contract), solcVersion, file });
    } catch {
    }
  }
  if (matches.length === 0) {
    throw new Error(`Contract ${contract} not found in ${BUILD_INFO_DIR}`);
  }
  if (matches.length > 1) {
    console.warn(
      `  ${contract} is in ${matches.length} build-info files (an incremental build); ` +
        `using the newest, ${matches[0].file}. Run "npm run build" for a single build.`,
    );
  }
  const { version, solcVersion } = matches[0];

  if (opts.assertSafe !== false) {
    assertUpgradeSafe(data, version, withValidationDefaults({}));
  }
  return { version, layout: getStorageLayout(data, version), solcVersion };
}

export function readLayoutReferences(network: string): LayoutReferences {
  const file = layoutsFile(network);
  if (!fs.existsSync(file)) return {};
  return JSON.parse(fs.readFileSync(file, 'utf8')) as LayoutReferences;
}

export function writeLayoutReference(
  network: string,
  contract: string,
  reference: Omit<LayoutReference, 'updatedAt'>,
): string {
  const file = layoutsFile(network);
  const all = readLayoutReferences(network);
  all[contract] = { ...reference, updatedAt: new Date().toISOString() };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    JSON.stringify(
      Object.fromEntries(
        Object.entries(all).sort(([a], [b]) => a.localeCompare(b)),
      ),
      null,
      2,
    ) + '\n',
  );
  return file;
}

/// Throws with the validator's explanation when the new layout would corrupt storage.
export function assertLayoutCompatible(
  contract: string,
  reference: StorageLayout,
  updated: StorageLayout,
): void {
  const report = getStorageUpgradeReport(
    reference,
    updated,
    withValidationDefaults({}),
  );
  if (!report.ok) {
    throw new Error(
      `Storage layout of ${contract} is not compatible with the deployed version:\n${report.explain()}`,
    );
  }
}

export function validateUpgrade(
  contract: string,
  opts: { referenceNetwork?: string } = {},
): { layout: StorageLayout; solcVersion: string } {
  const { layout, solcVersion } = getContractLayout(contract);

  if (opts.referenceNetwork) {
    const ref = readLayoutReferences(opts.referenceNetwork)[contract];
    if (!ref) {
      throw new Error(
        `No storage layout reference for ${contract} on ${opts.referenceNetwork} ` +
          `(${layoutsFile(opts.referenceNetwork)}). Run "npm run upgrades:snapshot -- --network ${opts.referenceNetwork}" ` +
          'from the commit that is deployed, or set UPGRADE_SKIP_REFERENCE=1 to skip the comparison.',
      );
    }
    assertLayoutCompatible(contract, ref.layout, layout);
  }

  return { layout, solcVersion };
}

export function snapshotLayouts(
  network: string,
  implementations: Partial<Record<string, string>> = {},
): string {
  let file = layoutsFile(network);
  for (const name of UUPS_CONTRACTS) {
    const { layout, solcVersion } = getContractLayout(name);
    file = writeLayoutReference(network, name, {
      layout,
      solcVersion,
      implementation: implementations[name],
    });
  }
  return file;
}
