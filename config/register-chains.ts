import { defineChain } from 'viem';
import * as viemChains from 'viem/chains';

import { chainIds, rpcUrls } from '@/config/networks';

/** Adds Robinhood Chain to `viem/chains` so `hardhat-viem` can resolve it. Must be imported first. Drop once viem ships it. */
const robinhood = defineChain({
  id: chainIds.robinhood,
  name: 'Robinhood Chain',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [rpcUrls.robinhood] } },
  blockExplorers: {
    default: { name: 'Robinhood Explorer', url: 'https://robinhoodchain.blockscout.com' },
  },
});

const robinhoodTestnet = defineChain({
  id: chainIds.robinhoodTestnet,
  name: 'Robinhood Chain Testnet',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [rpcUrls.robinhoodTestnet] } },
  blockExplorers: {
    default: {
      name: 'Robinhood Testnet Explorer',
      url: 'https://explorer.testnet.chain.robinhood.com',
    },
  },
  testnet: true,
});

const registry = viemChains as unknown as Record<string, unknown>;
registry.robinhood ??= robinhood;
registry.robinhoodTestnet ??= robinhoodTestnet;

export { robinhood, robinhoodTestnet };
