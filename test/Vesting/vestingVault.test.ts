import { expect } from 'chai';
import hre from 'hardhat';
import { decodeErrorResult, decodeEventLog, encodeFunctionData } from 'viem';
import { deployVestingFixture, helpers } from './_setupVesting';
type Hex = `0x${string}`;
type AnyLog = { data: `0x${string}`; topics: `0x${string}`[] };

const toLower = (address: string): string => address.toLowerCase();

const asTopicsTuple = (topics: Hex[]): [] | [Hex, ...Hex[]] => {
  return topics.length === 0 ? [] : (topics as [Hex, ...Hex[]]);
};

const findEventArgs = (receipt: any, abi: any, eventName: string): any[] => {
  const matches: any[] = [];

  for (const log of receipt.logs as AnyLog[]) {
    try {
      const decoded = decodeEventLog({
        abi,
        data: log.data,
        topics: asTopicsTuple(log.topics),
      }) as any;

      if (decoded.eventName === eventName) {
        matches.push(decoded.args);
      }
    } catch {}
  }

  return matches;
};

const extractRevertData = (error: any): `0x${string}` | null => {
  const candidates: unknown[] = [
    error?.data,
    error?.error?.data,
    error?.error?.error?.data,
    error?.data?.data,
    error?.error?.data?.data,
    error?.error?.error?.data?.data,
    error?.error?.data?.result,
    error?.data?.result,
  ];

  for (const item of candidates) {
    if (typeof item === 'string' && item.startsWith('0x')) {
      return item as `0x${string}`;
    }

    if (item && typeof item === 'object') {
      const maybeData = (item as any).data;
      if (typeof maybeData === 'string' && maybeData.startsWith('0x')) {
        return maybeData as `0x${string}`;
      }

      const maybeResult = (item as any).result;
      if (typeof maybeResult === 'string' && maybeResult.startsWith('0x')) {
        return maybeResult as `0x${string}`;
      }
    }
  }

  return null;
};

const expectCustomErrorByCall = async (
  params: {
    to: `0x${string}`;
    from: `0x${string}`;
    abi: any;
    functionName: string;
    args: any[];
  },
  errorName: string,
): Promise<void> => {
  const data = encodeFunctionData({
    abi: params.abi,
    functionName: params.functionName,
    args: params.args,
  });

  try {
    await hre.network.provider.send('eth_call', [
      { to: params.to, from: params.from, data },
      'latest',
    ]);

    expect.fail(`Expected revert: ${errorName}`);
  } catch (error: any) {
    const revertData = extractRevertData(error);

    if (revertData) {
      const decoded = decodeErrorResult({
        abi: params.abi,
        data: revertData,
      }) as any;

      expect(decoded.errorName).to.equal(errorName);
      return;
    }

    const message = String(error?.shortMessage ?? error?.message ?? '');
    expect(message).to.include(errorName);
  }
};

const unlockedAt = (
  total: bigint,
  start: bigint,
  end: bigint,
  ts: bigint,
): bigint => {
  if (ts <= start) return 0n;
  if (ts >= end) return total;

  const elapsed = ts - start;
  const duration = end - start;
  return (total * elapsed) / duration;
};

const claimableAt = (vest: any, ts: bigint): bigint => {
  const total = vest.amountStrat as bigint;
  const claimed = vest.claimedStrat as bigint;
  const start = vest.start as bigint;
  const end = vest.end as bigint;

  const unlocked = unlockedAt(total, start, end, ts);
  return unlocked > claimed ? unlocked - claimed : 0n;
};

const setTxTimestamp = async (targetTs: bigint): Promise<bigint> => {
  const latest = await hre.network.provider.send('eth_getBlockByNumber', [
    'latest',
    false,
  ]);
  const currentTs = BigInt(latest.timestamp);

  const nextTs = targetTs <= currentTs ? currentTs + 1n : targetTs;
  await hre.network.provider.send('evm_setNextBlockTimestamp', [
    Number(nextTs),
  ]);
  return nextTs;
};

describe('VestingVault — stable TZ coverage', () => {
  it('createVest: onlyBonding; stores per-vest data; emits VestCreated', async () => {
    const { publicClient, deployer, bonding, user, vault } =
      await deployVestingFixture();
    const now = await helpers.nowTs();

    const start = now + 10n;
    const end = start + 1000n;
    const amount = 1000n * helpers.WAD;
    const seriesId = 7;

    await expectCustomErrorByCall(
      {
        to: vault.address,
        from: deployer.account.address,
        abi: vault.abi,
        functionName: 'createVest',
        args: [user.account.address, amount, start, end, seriesId],
      },
      'NotBonding',
    );

    const hash = await bonding.writeContract({
      address: vault.address,
      abi: vault.abi,
      functionName: 'createVest',
      args: [user.account.address, amount, start, end, seriesId],
    });

    const receipt = await publicClient.waitForTransactionReceipt({ hash });

    const events = findEventArgs(receipt, vault.abi, 'VestCreated');
    expect(events.length).to.equal(1);

    expect(toLower(events[0].user)).to.equal(toLower(user.account.address));
    expect(events[0].seriesId).to.equal(BigInt(seriesId));
    expect(events[0].amountStrat).to.equal(amount);
    expect(events[0].start).to.equal(start);
    expect(events[0].end).to.equal(end);

    const count = await publicClient.readContract({
      address: vault.address,
      abi: vault.abi,
      functionName: 'vestCount',
      args: [user.account.address],
    });
    expect(count).to.equal(1n);

    const v: any = await publicClient.readContract({
      address: vault.address,
      abi: vault.abi,
      functionName: 'getVest',
      args: [user.account.address, 0n],
    });

    expect(v.amountStrat).to.equal(amount);
    expect(v.claimedStrat).to.equal(0n);
    expect(v.start).to.equal(start);
    expect(v.end).to.equal(end);
    expect(Number(v.seriesId)).to.equal(seriesId);
  });

  it('createVest: reverts on AddressZero / ZeroAmount / InvalidTimeRange', async () => {
    const { bonding, user, vault } = await deployVestingFixture();
    const now = await helpers.nowTs();

    const start = now + 10n;
    const end = start + 1000n;

    await expectCustomErrorByCall(
      {
        to: vault.address,
        from: bonding.account.address,
        abi: vault.abi,
        functionName: 'createVest',
        args: ['0x0000000000000000000000000000000000000000', 1n, start, end, 1],
      },
      'AddressZero',
    );

    await expectCustomErrorByCall(
      {
        to: vault.address,
        from: bonding.account.address,
        abi: vault.abi,
        functionName: 'createVest',
        args: [user.account.address, 0n, start, end, 1],
      },
      'ZeroAmount',
    );

    await expectCustomErrorByCall(
      {
        to: vault.address,
        from: bonding.account.address,
        abi: vault.abi,
        functionName: 'createVest',
        args: [user.account.address, 1n, start, start, 1],
      },
      'InvalidTimeRange',
    );
  });

  it('claimableForVest + claimable: linear unlock works', async () => {
    const { publicClient, bonding, user, vault } = await deployVestingFixture();
    const now = await helpers.nowTs();

    const start = now + 100n;
    const end = start + 1000n;
    const amount = 1000n * helpers.WAD;

    await publicClient.waitForTransactionReceipt({
      hash: await bonding.writeContract({
        address: vault.address,
        abi: vault.abi,
        functionName: 'createVest',
        args: [user.account.address, amount, start, end, 1],
      }),
    });

    const before = await publicClient.readContract({
      address: vault.address,
      abi: vault.abi,
      functionName: 'claimableForVest',
      args: [user.account.address, 0n],
    });
    expect(before).to.equal(0n);

    await helpers.mineTo(start + 500n);

    const half = await publicClient.readContract({
      address: vault.address,
      abi: vault.abi,
      functionName: 'claimableForVest',
      args: [user.account.address, 0n],
    });

    const expectedHalf = (amount * 500n) / 1000n;
    expect(half).to.equal(expectedHalf);

    // No on-chain aggregate: the caller sums the page.
    const [, claimables] = (await publicClient.readContract({
      address: vault.address,
      abi: vault.abi,
      functionName: 'getVests',
      args: [user.account.address, 0n, 100n],
    })) as [unknown[], bigint[]];
    const totalHalf = claimables.reduce((a, b) => a + b, 0n);
    expect(totalHalf).to.equal(expectedHalf);

    await helpers.mineTo(end + 1n);

    const full = await publicClient.readContract({
      address: vault.address,
      abi: vault.abi,
      functionName: 'claimableForVest',
      args: [user.account.address, 0n],
    });
    expect(full).to.equal(amount);
  });

  it('claim(uint256[]): burns VVEST 1:1, transfers STRAT, updates claimedStrat, emits Claimed', async () => {
    const { publicClient, bonding, treasury, user, strat, vvest, vault } =
      await deployVestingFixture();
    const now = await helpers.nowTs();

    const start1 = now + 10n;
    const end1 = start1 + 1000n;
    const amount1 = 1000n * helpers.WAD;

    const start2 = now + 20n;
    const end2 = start2 + 2000n;
    const amount2 = 2000n * helpers.WAD;

    await publicClient.waitForTransactionReceipt({
      hash: await bonding.writeContract({
        address: vault.address,
        abi: vault.abi,
        functionName: 'createVest',
        args: [user.account.address, amount1, start1, end1, 1],
      }),
    });

    await publicClient.waitForTransactionReceipt({
      hash: await bonding.writeContract({
        address: vault.address,
        abi: vault.abi,
        functionName: 'createVest',
        args: [user.account.address, amount2, start2, end2, 2],
      }),
    });

    await publicClient.waitForTransactionReceipt({
      hash: await bonding.writeContract({
        address: vvest.address,
        abi: vvest.abi,
        functionName: 'mint',
        args: [user.account.address, amount1 + amount2],
      }),
    });

    const claimTs = start2 + 500n;
    await helpers.mineTo(claimTs);

    const txTs = await setTxTimestamp(claimTs);

    const beforeVV = (await publicClient.readContract({
      address: vvest.address,
      abi: vvest.abi,
      functionName: 'balanceOf',
      args: [user.account.address],
    })) as bigint;

    const beforeUserStrat = (await publicClient.readContract({
      address: strat.address,
      abi: strat.abi,
      functionName: 'balanceOf',
      args: [user.account.address],
    })) as bigint;

    const beforeTreasuryStrat = (await publicClient.readContract({
      address: strat.address,
      abi: strat.abi,
      functionName: 'balanceOf',
      args: [treasury.address],
    })) as bigint;

    const vest0: any = await publicClient.readContract({
      address: vault.address,
      abi: vault.abi,
      functionName: 'getVest',
      args: [user.account.address, 0n],
    });

    const vest1: any = await publicClient.readContract({
      address: vault.address,
      abi: vault.abi,
      functionName: 'getVest',
      args: [user.account.address, 1n],
    });

    const expectedClaim = claimableAt(vest0, txTs) + claimableAt(vest1, txTs);

    const claimHash = await user.writeContract({
      address: vault.address,
      abi: vault.abi,
      functionName: 'claim',
      args: [[0n, 1n]],
    });

    const receipt = await publicClient.waitForTransactionReceipt({
      hash: claimHash,
    });

    const claimedEvents = findEventArgs(receipt, vault.abi, 'Claimed');
    expect(claimedEvents.length).to.equal(1);
    expect(toLower(claimedEvents[0].user)).to.equal(
      toLower(user.account.address),
    );
    expect(claimedEvents[0].amount).to.equal(expectedClaim);

    const afterVV = (await publicClient.readContract({
      address: vvest.address,
      abi: vvest.abi,
      functionName: 'balanceOf',
      args: [user.account.address],
    })) as bigint;

    const afterUserStrat = (await publicClient.readContract({
      address: strat.address,
      abi: strat.abi,
      functionName: 'balanceOf',
      args: [user.account.address],
    })) as bigint;

    const afterTreasuryStrat = (await publicClient.readContract({
      address: strat.address,
      abi: strat.abi,
      functionName: 'balanceOf',
      args: [treasury.address],
    })) as bigint;

    expect(afterVV).to.equal(beforeVV - expectedClaim);
    expect(afterUserStrat).to.equal(beforeUserStrat + expectedClaim);
    expect(afterTreasuryStrat).to.equal(beforeTreasuryStrat - expectedClaim);

    const v0: any = await publicClient.readContract({
      address: vault.address,
      abi: vault.abi,
      functionName: 'getVest',
      args: [user.account.address, 0n],
    });

    const v1: any = await publicClient.readContract({
      address: vault.address,
      abi: vault.abi,
      functionName: 'getVest',
      args: [user.account.address, 1n],
    });

    expect(v0.claimedStrat).to.equal(claimableAt(vest0, txTs));
    expect(v1.claimedStrat).to.equal(claimableAt(vest1, txTs));
  });

  it('claim: reverts on EmptyVestIds / IndexOutOfBounds / NothingToClaim', async () => {
    const { publicClient, bonding, user, vault } = await deployVestingFixture();
    const now = await helpers.nowTs();

    const start = now + 200n;
    const end = start + 1000n;
    const amount = 1000n * helpers.WAD;

    await publicClient.waitForTransactionReceipt({
      hash: await bonding.writeContract({
        address: vault.address,
        abi: vault.abi,
        functionName: 'createVest',
        args: [user.account.address, amount, start, end, 1],
      }),
    });

    await expectCustomErrorByCall(
      {
        to: vault.address,
        from: user.account.address,
        abi: vault.abi,
        functionName: 'claim',
        args: [[]],
      },
      'EmptyVestIds',
    );

    await expectCustomErrorByCall(
      {
        to: vault.address,
        from: user.account.address,
        abi: vault.abi,
        functionName: 'claim',
        args: [[999n]],
      },
      'IndexOutOfBounds',
    );

    const beforeStartTs = start - 10n;
    await helpers.mineTo(beforeStartTs);
    await setTxTimestamp(beforeStartTs);

    await expectCustomErrorByCall(
      {
        to: vault.address,
        from: user.account.address,
        abi: vault.abi,
        functionName: 'claim',
        args: [[0n]],
      },
      'NothingToClaim',
    );
  });

  it('getVests: pages positions and their claimable amounts', async () => {
    const { publicClient, bonding, user, vault } = await deployVestingFixture();
    const now = await helpers.nowTs();

    const start1 = now + 10n;
    const end1 = start1 + 1000n;
    const amount1 = 1000n * helpers.WAD;

    const start2 = now + 20n;
    const end2 = start2 + 2000n;
    const amount2 = 2000n * helpers.WAD;

    await publicClient.waitForTransactionReceipt({
      hash: await bonding.writeContract({
        address: vault.address,
        abi: vault.abi,
        functionName: 'createVest',
        args: [user.account.address, amount1, start1, end1, 1],
      }),
    });

    await publicClient.waitForTransactionReceipt({
      hash: await bonding.writeContract({
        address: vault.address,
        abi: vault.abi,
        functionName: 'createVest',
        args: [user.account.address, amount2, start2, end2, 2],
      }),
    });

    await helpers.mineTo(start2 + 500n);

    const readPage = async (offset: bigint, limit: bigint) =>
      (await publicClient.readContract({
        address: vault.address,
        abi: vault.abi,
        functionName: 'getVests',
        args: [user.account.address, offset, limit],
      })) as [any[], bigint[]];

    const [vests, claimables] = await readPage(0n, 100n);
    expect(vests.length).to.equal(2);
    expect(claimables.length).to.equal(2);
    expect(vests[0].amountStrat + vests[1].amountStrat).to.equal(
      amount1 + amount2,
    );

    const perVest = await Promise.all(
      [0n, 1n].map((i) =>
        publicClient.readContract({
          address: vault.address,
          abi: vault.abi,
          functionName: 'claimableForVest',
          args: [user.account.address, i],
        }),
      ),
    );
    expect(claimables[0]).to.equal(perVest[0]);
    expect(claimables[1]).to.equal(perVest[1]);

    // An offset past the end returns empty, so a UI can page without the count.
    const [second] = await readPage(1n, 1n);
    expect(second.length).to.equal(1);
    expect(second[0].amountStrat).to.equal(amount2);

    const [none] = await readPage(2n, 10n);
    expect(none.length).to.equal(0);
  });
});
