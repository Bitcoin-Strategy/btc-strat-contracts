import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import hre from 'hardhat';

import { env } from '@/env';

import type { LedgerEntry, LedgerFile } from './lib/deploy-ledger';
import { argsFile, deploymentName, loadDeployment } from './lib/deployment';

const ALREADY_VERIFIED = /already verified/i;

const SOURCIFY = 'https://sourcify.dev/server';

/** Verifies on Sourcify API v2 with the build-info named by the artifact's `.dbg.json`. Constructor args come from creation code. */
async function verifyOnSourcify(
  chainId: number,
  entry: PlanEntry,
): Promise<string> {
  const [sourceName, contractName] = entry.contract.split(':');
  const artifactDir = path.join(hre.config.paths.artifacts, sourceName);
  const dbg = JSON.parse(
    readFileSync(path.join(artifactDir, `${contractName}.dbg.json`), 'utf8'),
  ) as { buildInfo: string };
  const buildInfo = JSON.parse(
    readFileSync(path.resolve(artifactDir, dbg.buildInfo), 'utf8'),
  ) as { solcLongVersion: string; input: unknown };

  const submitted = await fetch(
    `${SOURCIFY}/v2/verify/${chainId}/${entry.address}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        stdJsonInput: buildInfo.input,
        compilerVersion: buildInfo.solcLongVersion,
        contractIdentifier: entry.contract,
      }),
    },
  );
  const job = (await submitted.json()) as {
    verificationId?: string;
    customCode?: string;
    message?: string;
  };
  if (job.customCode === 'already_verified') return 'already verified';
  if (!job.verificationId) {
    throw new Error(`Sourcify refused it (${submitted.status}): ${job.message ?? JSON.stringify(job)}`);
  }

  for (let attempt = 0; attempt < 40; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    const status = (await (
      await fetch(`${SOURCIFY}/v2/verify/${job.verificationId}`)
    ).json()) as {
      isJobCompleted: boolean;
      contract?: { match: string | null };
      error?: { customCode?: string; message?: string };
    };
    if (!status.isJobCompleted) continue;
    if (status.error) {
      if (status.error.customCode === 'already_verified') return 'already verified';
      throw new Error(`Sourcify: ${status.error.message ?? status.error.customCode}`);
    }
    if (!status.contract?.match) {
      throw new Error('Sourcify finished without a match');
    }
    return status.contract.match;
  }
  throw new Error(`Sourcify job ${job.verificationId} did not finish in two minutes`);
}

type PlanEntry = LedgerEntry & { address: string };

function loadPlan(): PlanEntry[] {
  loadDeployment();

  const file = argsFile();
  if (!existsSync(file)) {
    throw new Error(
      `no constructor args file for ${deploymentName()} (${file})`,
    );
  }
  const ledger = JSON.parse(readFileSync(file, 'utf8')) as LedgerFile;

  return Object.entries(ledger.entries)
    .map(([address, entry]) => ({ ...entry, address }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function printPlan(plan: PlanEntry[]): void {
  console.log(` Deployment: ${deploymentName()} (${argsFile()})`);
  console.log(` ${plan.length} entries\n`);
  for (const entry of plan) {
    const args = entry.args.length === 0 ? '-' : JSON.stringify(entry.args);
    const skip = entry.verify
      ? ''
      : `   skip: ${entry.note ?? 'not deployed by this script'}`;
    console.log(
      ` ${entry.name.padEnd(28)} ${entry.address} ${entry.contract}\n` +
        `   args: ${args}${skip ? `\n${skip}` : ''}`,
    );
  }
}

async function main(): Promise<number> {
  const plan = loadPlan();

  if (process.env.VERIFY_DRY_RUN === '1') {
    console.log('\n VERIFY DRY RUN — nothing is sent to the explorer\n');
    printPlan(plan);
    console.log('\n OK (dry run)');
    return 0;
  }

  // Sourcify needs no key and also forwards to Etherscan; direct Etherscan runs only with a key.
  const withEtherscan = Boolean(env.ETHERSCAN_API_KEY);
  if (!withEtherscan) {
    console.log(
      ' ETHERSCAN_API_KEY is not set: verifying on Sourcify only, Etherscan is skipped.\n',
    );
  }
  const chainId = await (await hre.viem.getPublicClient()).getChainId();

  const verifiable = plan.filter((entry) => entry.verify);
  console.log(
    ` Verifying ${verifiable.length} of ${plan.length} entries of ${argsFile()}\n`,
  );

  let failed = 0;
  for (const entry of verifiable) {
    const problems: string[] = [];
    const results: string[] = [];

    try {
      results.push(`Sourcify: ${await verifyOnSourcify(chainId, entry)}`);
    } catch (error) {
      problems.push(error instanceof Error ? error.message : String(error));
    }

    if (withEtherscan) {
      try {
        await hre.run('verify:verify', {
          address: entry.address,
          contract: entry.contract,
          constructorArguments: entry.args,
        });
        results.push('Etherscan: verified');
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (ALREADY_VERIFIED.test(message)) results.push('Etherscan: already verified');
        else problems.push(`Etherscan: ${message}`);
      }
    }

    if (problems.length === 0) {
      console.log(`PASS  ${entry.name} ${entry.address} (${results.join(', ')})`);
    } else {
      failed += 1;
      console.log(
        `FAIL  ${entry.name} ${entry.address}\n      ${problems.join('\n      ')}`,
      );
    }
  }

  console.log(
    `\n ${verifiable.length - failed}/${verifiable.length} verified` +
      (failed ? `, ${failed} failed` : ''),
  );
  return failed === 0 ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
