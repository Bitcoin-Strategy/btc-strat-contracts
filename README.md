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

## Genesis launch

STRAT is launched through a Uniswap Continuous Clearing Auction on Robinhood Chain: 5,000,000 STRAT for USDG, bidding from block `88755424` to `98755424` (October 15–26, 2026). Auction: [`0xad292203655E70b218ef92E86D8C197D1D0bFB60`](https://app.uniswap.org/explore/auctions/robinhood/0xad292203655e70b218ef92e86d8c197d1d0bfb60). If the raise stays below the graduation threshold of 167,235 USDG, the auction fails and bidders reclaim their USDG.

After graduation the raise is allocated as follows:

1. 40,000 USDG reimburses development costs.
2. The remainder is swapped to cbBTC.
3. Most of the cbBTC, paired with 499,000 STRAT, seeds the STRAT/cbBTC pool with `StratPoolHook`, the protocol's primary market.
4. The rest of the cbBTC is deposited into the Treasury as the initial backing of STRAT.

The Uniswap launcher also opens a STRAT/USDG pool with 1,000 STRAT; it is not the primary market. The raise and the liquidity positions are received by the deployer `0xDC2192D97424FA047E798d27346BCdAfca4E1A4C`, and every step above is a public transaction on Robinhood Chain.

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
