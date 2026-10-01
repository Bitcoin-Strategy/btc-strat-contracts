import hre from 'hardhat';
import { formatUnits, type Abi, type Address } from 'viem';

import { loadDeployment } from './lib/deployment';
import { revertName } from './lib/errors';

async function main(): Promise<number> {
  const deployment = loadDeployment();
  const a = deployment.addresses;

  const oracleAbi = (await hre.artifacts.readArtifact('ProtocolOracle'))
    .abi as Abi;
  const twapAbi = (await hre.artifacts.readArtifact('UniV4TwapAdapter'))
    .abi as Abi;
  const errorAbis = [oracleAbi, twapAbi];

  const oracle = await hre.viem.getContractAt(
    'ProtocolOracle',
    a.protocolOracle as Address,
  );

  let price: bigint | undefined;
  let error: string | undefined;
  try {
    price = await oracle.read.getPriceWad([
      a.strat as Address,
      a.btc as Address,
    ]);
  } catch (caught) {
    error = revertName(caught, errorAbis);
  }

  if (price !== undefined) {
    console.log(
      `PASS  STRAT/BTC  ${formatUnits(price, 18)} BTC per STRAT` +
        `\n\nPASS  the price answers`,
    );
    return 0;
  }

  console.log(`FAIL  STRAT/BTC  ${error}`);
  console.log(
    '\noracle not ready. The STRAT price is a V4 TWAP: it needs liquidity in the STRAT/cbBTC pool ' +
      '(`npm run seed:*`), enough observation slots, and a full TWAP window of history behind it ' +
      '(on a local node, advance the clock with the evm_increaseTime / evm_mine JSON-RPC calls).',
  );
  return 2;
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
