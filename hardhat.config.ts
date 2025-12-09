import { type HardhatUserConfig } from 'hardhat/config';

import 'tsconfig-paths/register';
// Must come before the viem plugin: it registers Robinhood Chain in viem's chain list.
import '@/config/register-chains';
import '@nomicfoundation/hardhat-toolbox-viem';
import 'hardhat-contract-sizer';
import 'hardhat-docgen';

import {
  getForkNetworkConfig,
  getHardhatNetworkConfig,
  getNetworkConfig,
} from '@/config/networks';
import { env } from '@/env';

/// Needed by the OpenZeppelin upgrade-safety validator.
const storageLayoutOutput = {
  outputSelection: { '*': { '*': ['storageLayout'] } },
};

const config: HardhatUserConfig = {
  solidity: {
    compilers: [
      {
        version: '0.8.28',
        settings: {
          optimizer: {
            enabled: true,
            runs: 200,
          },
          viaIR: true,
          evmVersion: 'cancun',
          ...storageLayoutOutput,
        },
      },
      {
        version: '0.7.6',
        settings: {
          optimizer: {
            enabled: true,
            runs: 200,
          },
          evmVersion: 'istanbul',
          ...storageLayoutOutput,
        },
      },
    ],
  },
  networks: {
    main: getNetworkConfig('main'),
    sepolia: getNetworkConfig('sepolia'),
    robinhood: getNetworkConfig('robinhood'),
    robinhoodTestnet: getNetworkConfig('robinhoodTestnet'),
    ...(env.SOLIDITY_COVERAGE
      ? {}
      : {
          hardhat: env.FORKING_NETWORK
            ? getForkNetworkConfig(env.FORKING_NETWORK)
            : getHardhatNetworkConfig(),
        }),
    localhost: getNetworkConfig('localhost'),
  },
  gasReporter: {
    enabled: env.REPORT_GAS ?? false,
  },
  contractSizer: {
    alphaSort: true,
    runOnCompile: true,
  },
  // Never `docs/`: `clear` wipes the directory on every compile.
  docgen: {
    path: './docgen',
    clear: true,
    runOnCompile: true,
  },
  // Etherscan runs only with a key (v2 API). Sourcify v1 is gone and Blockscout is behind Cloudflare,
  // so `scripts/verify.ts` calls Sourcify v2 itself.
  sourcify: {
    enabled: false,
  },
  etherscan: {
    enabled: Boolean(env.ETHERSCAN_API_KEY),
    apiKey: env.ETHERSCAN_API_KEY ?? '',
    customChains: [
      {
        network: 'robinhood',
        chainId: 4663,
        urls: {
          apiURL: 'https://api.etherscan.io/v2/api?chainid=4663',
          browserURL: 'https://robin.etherscan.io',
        },
      },
      {
        network: 'robinhoodTestnet',
        chainId: 46630,
        urls: {
          apiURL: 'https://explorer.testnet.chain.robinhood.com/api',
          browserURL: 'https://explorer.testnet.chain.robinhood.com',
        },
      },
    ],
  },
  mocha: {
    require: ['test/_chai.ts'],
  },
};

export default config;
