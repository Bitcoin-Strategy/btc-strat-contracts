import 'dotenv/config';

import { isAddress } from 'viem';
import { z } from 'zod';

import { createEnv } from '@/config/create-env';
import { networksEnum } from '@/config/types';

// Validated at load, so a typo fails at startup rather than mid-deployment.
const address = z
  .string()
  .refine((value) => isAddress(value), {
    message: 'must be a 20-byte hex address',
  })
  .optional();

export const env = createEnv({
  server: {
    INFURA_KEY: z.string().optional(),
    MNEMONIC_DEV: z.string().optional(),
    PRIVATE_KEY_DEV: z.string().optional(),
    MNEMONIC_PROD: z.string().optional(),
    FORKING_NETWORK: networksEnum.optional(),
    /// Defaults to hardhat's choice.
    FORKING_BLOCK: z.coerce.number().optional(),
    ETHERSCAN_API_KEY: z.string().optional(),
    SEPOLIA_RPC_URL: z.string().optional(),
    ROBINHOOD_RPC_URL: z.string().optional(),
    ROBINHOOD_TESTNET_RPC_URL: z.string().optional(),
    DEPLOY_PROFILE: z.enum(['demo', 'sim', 'qa', 'prod']).optional(),
    DEPLOYMENT: z.string().optional(),
    /// Required by `scripts/deploy.ts`.
    UNISWAP_V4_POOL_MANAGER: address,
    /// Real cbBTC. Empty deploys a mintable mock.
    BTC: address,
    /// CCA LBPStrategy allowed to open the pool. Empty means the deployer opens it.
    CCA_LBP_STRATEGY: address,
    /// Genesis admin of ProtocolAuthority. Empty means the deployer.
    PROTOCOL_ADMIN: address,
    /// Pause/cancel guardian. Empty means no guardian.
    PROTOCOL_GUARDIAN: address,
    REPORT_GAS: z
      .string()
      .optional()
      .transform((value) => value === 'true'),
    SOLIDITY_COVERAGE: z
      .string()
      .optional()
      .transform((value) => value === 'true'),
  },
  runtimeEnv: process.env,
  emptyStringAsUndefined: true,
});
