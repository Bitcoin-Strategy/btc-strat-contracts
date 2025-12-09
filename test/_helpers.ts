import { expect } from 'chai';
import { keccak256, toBytes } from 'viem';

export {
  deployUups,
  deployImplementation,
  encodeInitialize,
  encodeUpgradeToAndCall,
  getImplementation,
  ERC1967_IMPLEMENTATION_SLOT,
} from '../scripts/lib/proxy';

/** Accepts the error name or its selector: Hardhat cannot always decode errors behind a proxy. */
export const expectCustomError = async (
  promise: Promise<unknown>,
  errorName: string,
  signature = `${errorName}()`,
): Promise<void> => {
  const selector = keccak256(toBytes(signature)).slice(0, 10);
  try {
    await promise;
  } catch (error: any) {
    const text = [
      error?.message,
      error?.shortMessage,
      error?.details,
      error?.cause?.message,
      error?.cause?.details,
    ]
      .filter(Boolean)
      .join('\n');
    expect(
      text.includes(errorName) || text.includes(selector),
      `expected ${errorName} (${selector}), got: ${text.slice(0, 300)}`,
    ).to.equal(true);
    return;
  }
  expect.fail(`Expected revert: ${errorName}`);
};

/// No bounds of its own: the oracle sets both floors.
export const LIQ_SWEEP = {
  maxBtcIn: 2n ** 256n - 1n,
  minStratOut: 0n,
} as const;
