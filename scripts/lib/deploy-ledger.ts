import hre from 'hardhat';
import { getAddress, type Abi, type Address } from 'viem';

import { argsFile, writeJson } from './deployment';
import { encodeInitialize, getImplementation } from './proxy';

export type LedgerEntry = {
  name: string;
  contract: string;
  args: unknown[];
  verify: boolean;
  note?: string;
};

export type LedgerFile = {
  deployment: string;
  network: string;
  entries: Record<string, LedgerEntry>;
};

type RecordOpts = { verify?: boolean; note?: string };

export class DeployLedger {
  readonly entries: Record<Address, LedgerEntry> = {};

  async record(
    name: string,
    address: Address,
    contractName: string,
    args: readonly unknown[],
    opts: RecordOpts = {},
  ): Promise<void> {
    const artifact = await hre.artifacts.readArtifact(contractName);
    this.entries[getAddress(address)] = {
      name,
      contract: `${artifact.sourceName}:${artifact.contractName}`,
      args: [...args],
      verify: opts.verify ?? true,
      note: opts.note,
    };
  }

  async recordUups(
    name: string,
    proxyAddress: Address,
    initArgs: readonly unknown[],
    opts: RecordOpts = {},
  ): Promise<void> {
    const implementation = await getImplementation(proxyAddress);
    await this.record(`${name}Implementation`, implementation, name, [], opts);

    const artifact = await hre.artifacts.readArtifact(name);
    const data = encodeInitialize(artifact.abi as Abi, initArgs);
    await this.record(name, proxyAddress, 'ERC1967Proxy', [
      implementation,
      data,
    ]);
  }

  recordExternal(
    address: Address,
    name: string,
    opts: { verify: false; note?: string },
  ): void {
    this.entries[getAddress(address)] = {
      name,
      contract: name,
      args: [],
      verify: opts.verify,
      note: opts.note,
    };
  }

  serialize(deployment: string): LedgerFile {
    const sorted = Object.entries(this.entries).sort(([, a], [, b]) =>
      a.name.localeCompare(b.name),
    );
    return {
      deployment,
      network: hre.network.name,
      entries: Object.fromEntries(sorted),
    };
  }

  writeArgsFile(deployment: string): string {
    return writeJson(argsFile(deployment), this.serialize(deployment));
  }
}
