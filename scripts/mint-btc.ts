/**
//  * Mints mock cbBTC on a test network; refuses real cbBTC.
//  *   MINT_TO=0x... MINT_AMOUNT=10 npx hardhat run scripts/mint-btc.ts --network robinhoodTestnet
//  */
import hre from 'hardhat';
import { isAddress, parseUnits, type Address } from 'viem';

import { loadDeployment } from './lib/deployment';
import { waitForSuccess } from './lib/tx';

async function main() {
  const d = loadDeployment();
  if (!d.mocks) {
    throw new Error(
      `${d.deployment} uses a real cbBTC; there is nothing to mint`,
    );
  }

  const [signer] = await hre.viem.getWalletClients();
  const rawTo = process.env.MINT_TO?.trim();
  if (rawTo && !isAddress(rawTo)) {
    throw new Error(`MINT_TO must be an address, got "${rawTo}"`);
  }
  const to = (rawTo ?? signer.account.address) as Address;
  const whole = process.env.MINT_AMOUNT?.trim() || '10';
  const amount = parseUnits(whole, 8);
  if (amount <= 0n) {
    throw new Error(`MINT_AMOUNT must be a positive amount of cbBTC, got "${whole}"`);
  }

  const btc = await hre.viem.getContractAt(
    'MockERC20Decimals',
    (d.addresses as Record<string, Address>).btc,
  );

  const before = (await btc.read.balanceOf([to])) as bigint;

  // Wait for inclusion, or the read lands before the mint.
  await waitForSuccess(await btc.write.mint([to, amount]), 'cbBTC mint');

  const after = (await btc.read.balanceOf([to])) as bigint;

  console.log(` cbBTC: ${btc.address}`);
  console.log(` to:    ${to}`);
  console.log(` minted ${whole} cbBTC`);
  console.log(` balance ${Number(before) / 1e8} -> ${Number(after) / 1e8} cbBTC`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e?.shortMessage ?? e?.message ?? e);
    process.exit(1);
  });
