import { expect } from 'chai';
import { getAddress, type Address } from 'viem';

import {
  deployProtocol,
  deploymentAddresses,
  type DeployResult,
} from '../../scripts/deploy';
import { deployPoolManager } from '../../scripts/lib/uniswap-v4-local';
import { ISOLATED } from './_profiles';

describe('Deploy — constructor-args ledger', function () {
  this.timeout(300_000);

  let d: DeployResult;

  before(async () => {
    const poolManager = await deployPoolManager();
    d = await deployProtocol({ ...ISOLATED, poolManager });
  });

  it('has an entry for every address the deployment file publishes', () => {
    const entries = d.ledger.entries;

    for (const [key, value] of Object.entries(deploymentAddresses(d))) {
      if (!value || value.length !== 42) continue;
      expect(
        entries[getAddress(value as Address)],
        `${key} (${value}) has no ledger entry`,
      ).to.not.equal(undefined);
    }
  });

  it('has an entry for every module implementation', () => {
    for (const [name, implementation] of Object.entries(d.implementations)) {
      const entry = d.ledger.entries[getAddress(implementation as Address)];
      expect(entry, `${name} implementation has no ledger entry`).to.not.equal(
        undefined,
      );
      expect(entry.name, `${name} implementation entry name`).to.equal(
        `${name}Implementation`,
      );
      expect(entry.args, `${name} implementation args`).to.deep.equal([]);
    }
  });

  it('records a proxy as ERC1967Proxy(implementation, initialize calldata)', () => {
    const proxies = Object.entries(d.ledger.entries).filter(([, entry]) =>
      entry.contract.endsWith(':ERC1967Proxy'),
    );
    expect(proxies.length, 'proxies recorded').to.equal(
      Object.keys(d.implementations).length,
    );

    for (const [address, entry] of proxies) {
      expect(entry.args.length, `${entry.name} args`).to.equal(2);
      const implementation = (d.implementations as Record<string, string>)[
        entry.name
      ];
      expect(
        getAddress(entry.args[0] as Address),
        `${entry.name} args[0]`,
      ).to.equal(getAddress(implementation as Address));
      expect(
        String(entry.args[1]).startsWith('0x'),
        `${entry.name} init calldata`,
      ).to.equal(true);
      expect(entry.verify, `${entry.name} is ours to verify`).to.equal(true);
      expect(address, `${entry.name} key is checksummed`).to.equal(
        getAddress(address as Address),
      );
    }
  });

  it('marks what is not ours to verify', () => {
    for (const [label, address] of [
      ['PoolManager', d.poolManager],
      ['swapRouter', d.swapRouter],
      ['liquidityRouter', d.liquidityRouter],
      ['stateView', d.stateView],
    ] as const) {
      const entry = d.ledger.entries[getAddress(address as Address)];
      expect(entry, `${label} entry`).to.not.equal(undefined);
      expect(entry.verify, `${label} verify flag`).to.equal(false);
    }
  });

  it('serializes to a file shape with entries ordered by name', () => {
    const file = d.ledger.serialize('ledger-test');
    expect(file.deployment).to.equal('ledger-test');
    expect(file.network).to.equal('hardhat');

    const names = Object.values(file.entries).map((entry) => entry.name);
    expect(names).to.deep.equal([...names].sort((a, b) => a.localeCompare(b)));

    const json = JSON.stringify(file, (_key, value) =>
      typeof value === 'bigint' ? value.toString() : value,
    );
    expect(JSON.parse(json).entries, 'JSON round trip').to.have.keys(
      Object.keys(file.entries),
    );
  });
});
