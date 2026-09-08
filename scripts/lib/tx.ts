import hre from 'hardhat';
import type { Hex, TransactionReceipt } from 'viem';

/** Waits for a receipt and throws on revert: `waitForTransactionReceipt` resolves for reverted transactions too. */
export async function waitForSuccess(
  hash: Hex,
  label = 'transaction',
): Promise<TransactionReceipt> {
  const publicClient = await hre.viem.getPublicClient();
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') {
    throw new Error(`${label} reverted (${hash})`);
  }
  return receipt;
}
