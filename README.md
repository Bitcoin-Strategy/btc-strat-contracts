# BTC Strategy Contracts

Smart contracts of the BTC Strategy protocol: a bitcoin-backed treasury token (STRAT) on Robinhood Chain. Bonds sell STRAT for cbBTC at a fixed price, a Uniswap v4 pool prices it, and staked holders can redeem against the treasury's NAV.

## Architecture

| Layer | Contracts | Upgradeability |
| --- | --- | --- |
| Value | `STRAT`, `VVEST`, `Treasury`, `Staking`, `StakeEscrow` | Immutable |
| Control | `ProtocolAuthority`, `StratGovernor` (params, upgrades), `StratTimelock` | Immutable |
| Modules | `Bonding`, `VestingVault`, `Redemption`, `PremiumSales`, `FeeVault` | UUPS |
| Market | `StratPoolHook`, `ProtocolOracle`, `UniV4TwapAdapter`, `UniV4SwapAdapter`, `UniV4LiquidityAdapter` | Immutable |
| Periphery | `ProtocolReader` | Stateless |

`ProtocolAuthority` owns every contract. During Genesis the admin configures the protocol; `finalizeGenesis()` hands control to two governor and timelock tracks, one for parameters and one, with a higher bar, for upgrades.

## Deployments

Robinhood Chain (4663), start block `86651208`. Full address book: [`deployments/robinhood.json`](deployments/robinhood.json).

| Contract | Address |
| --- | --- |
| STRAT | `0xab63c1817415cc566cddf03c387dcc750af6427f` |
| Treasury | `0x4a6c9f1b41d9c77f14600c85bcb92c984642444a` |
| Bonding | `0x1700c0dc81b5d1e6a8ce83efbf5ab7f9c67f2eee` |
| Staking | `0x9d335c4b63ceda13b587720f8efc494a795b43af` |
| Redemption | `0xb67d5b58b38381d6fdf6e6aadfe16b332419dae3` |
| PremiumSales | `0x11be47a430383f64f389020927963009f688e2b7` |
| ProtocolAuthority | `0x83c939b7f683f48bb6a408f5cd15df212adbe70e` |
| StratPoolHook | `0x8b03bed3F9d6848b6d525D5cF34A360c581930c4` |
| ProtocolReader | `0x5af55d67d0e7ac5720dfe1e514d827cb9ca7079f` |

## Getting started

```bash
npm install
cp .env.example .env
npm run compile
npm test
```

## Commands

| Command | Description |
| --- | --- |
| `npm run compile` | Compile contracts |
| `npm test` | Run the test suite |
| `npm run coverage` | Coverage report |
| `npm run codestyle` | Solhint and Prettier checks |
| `npm run validate:upgrades` | OpenZeppelin upgrade-safety validation |
| `npm run rehearse` | Full local launch rehearsal |

## Deployment

```bash
npm run deploy:fork:robinhood   # dry run on a mainnet fork
npm run deploy:robinhood        # deploy, writes deployments/robinhood.json
npm run verify:robinhood        # verify on Sourcify, and on Etherscan when ETHERSCAN_API_KEY is set
```

Deployment is configured through `.env` (see `.env.example`) and the profiles in `scripts/lib/profiles.ts`. Module upgrades go through `npm run upgrade`, which checks storage layout against `upgrades/<network>.json` and prints the governance proposal.

## License

[MIT](LICENSE)
