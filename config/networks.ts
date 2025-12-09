import {
  type HardhatNetworkUserConfig,
  type HttpNetworkAccountsUserConfig,
  type HttpNetworkUserConfig,
  type NetworkUserConfig,
} from 'hardhat/types';

import {
  type Network,
  type NetworkConfigParam,
  type RpcUrl,
} from '@/config/types';
import { env } from '@/env';

const {
  INFURA_KEY,
  MNEMONIC_DEV,
  MNEMONIC_PROD,
  PRIVATE_KEY_DEV,
  FORKING_BLOCK,
  SEPOLIA_RPC_URL,
  ROBINHOOD_RPC_URL,
  ROBINHOOD_TESTNET_RPC_URL,
} = env;

export const rpcUrls: NetworkConfigParam<RpcUrl> = {
  main: `https://mainnet.infura.io/v3/${INFURA_KEY}`,
  sepolia: SEPOLIA_RPC_URL ?? `https://sepolia.infura.io/v3/${INFURA_KEY}`,
  // Public endpoints: fine for reading and deploying, not for deep forks.
  robinhood: ROBINHOOD_RPC_URL ?? 'https://rpc.mainnet.chain.robinhood.com',
  robinhoodTestnet:
    ROBINHOOD_TESTNET_RPC_URL ?? 'https://rpc.testnet.chain.robinhood.com',
  hardhat: 'http://localhost:8545',
  localhost: 'http://localhost:8545',
};

export const chainIds: NetworkConfigParam<number> = {
  main: 1,
  sepolia: 11155111,
  robinhood: 4663,
  robinhoodTestnet: 46630,
  hardhat: 31337,
  localhost: 31337,
};

export const mnemonics: NetworkConfigParam<string | undefined> = {
  main: MNEMONIC_PROD,
  sepolia: MNEMONIC_DEV,
  robinhood: MNEMONIC_PROD,
  robinhoodTestnet: MNEMONIC_DEV,
  hardhat: MNEMONIC_DEV,
  localhost: MNEMONIC_DEV,
};

export const privateKeys: NetworkConfigParam<string | undefined> = {
  main: undefined,
  sepolia: PRIVATE_KEY_DEV,
  robinhood: undefined,
  robinhoodTestnet: PRIVATE_KEY_DEV,
  hardhat: undefined,
  localhost: undefined,
};

const accountsFor = (
  network: Network,
): HttpNetworkAccountsUserConfig | undefined => {
  const key = privateKeys[network];
  if (key) return [key.startsWith('0x') ? key : `0x${key}`];
  return mnemonics[network] ? { mnemonic: mnemonics[network] } : undefined;
};

export const forkingBlocks: NetworkConfigParam<number | undefined> = {
  main: 19647878,
  sepolia: undefined,
  // Hardhat's default: pinned blocks go stale fast on an Orbit chain.
  robinhood: undefined,
  robinhoodTestnet: undefined,
  hardhat: undefined,
  localhost: undefined,
};

export const getBaseNetworkConfig = (
  network: Network,
): Omit<HttpNetworkUserConfig, 'url'> => ({
  accounts: accountsFor(network),
  chainId: chainIds[network],
  gas: network === 'sepolia' ? 10000000 : undefined,
});

export const getNetworkConfig = (network: Network): NetworkUserConfig => ({
  ...getBaseNetworkConfig(network),
  url: rpcUrls[network],
});

const forkAccountsFor = (
  network: Network,
): HardhatNetworkUserConfig['accounts'] => {
  const key = privateKeys[network];
  if (key) {
    return [
      {
        privateKey: key.startsWith('0x') ? key : `0x${key}`,
        balance: '10000000000000000000000',
      },
    ];
  }
  return mnemonics[network] ? { mnemonic: mnemonics[network] } : undefined;
};

export const getForkNetworkConfig = (
  network: Network,
): HardhatNetworkUserConfig => ({
  ...getBaseNetworkConfig(network),
  chainId: chainIds.hardhat,
  accounts: forkAccountsFor(network),
  forking: {
    url: rpcUrls[network],
    blockNumber: FORKING_BLOCK ?? forkingBlocks[network],
    enabled: true,
  },
});

export const getHardhatNetworkConfig = (): HardhatNetworkUserConfig => ({
  ...getBaseNetworkConfig('hardhat'),
  accounts: mnemonics.hardhat ? { mnemonic: mnemonics.hardhat } : undefined,
});
