import { expect } from 'chai';
import { decodeAbiParameters, parseAbiParameters } from 'viem';

import { defaultConfig } from '../../scripts/deploy';
import {
  auctionSteps,
  bidGrid,
  blockAt,
  blocksIn,
  checkAuctionSteps,
  encodeAuctionSteps,
  encodeLpAllocationSchedule,
  encodePositionDefinitions,
  FULL_RANGE_ONLY,
  MAX_AUCTION_BLOCKS,
  MIN_BID_TICK_SPACING,
  MIN_FLOOR_PRICE,
  MPS,
  priceX96,
  satsFromPriceX96,
  secondsIn,
  TICKS_PER_FLOOR,
  type AuctionStep,
} from '../../scripts/lib/cca-params';
import { profileConfig } from '../../scripts/lib/profiles';

/** CCA launch parameters checked against the rules Uniswap's contracts enforce, transcribed from source. */
describe('CCA launch parameters', () => {
  /** `StepStorage._validate`. */
  const validateSchedule = (
    steps: AuctionStep[],
    startBlock: bigint,
    endBlock: bigint,
  ) => {
    const data = encodeAuctionSteps(steps);
    const bytes = (data.length - 2) / 2;
    expect(
      bytes % 8,
      'the packed length must be a whole number of steps',
    ).to.equal(0);

    let sumMps = 0n;
    let sumBlockDelta = 0n;
    for (let i = 0; i < bytes; i += 8) {
      const word = BigInt(`0x${data.slice(2 + i * 2, 2 + i * 2 + 16)}`);
      const mps = word >> 40n;
      const blockDelta = word & 0xff_ffff_ffffn;
      expect(blockDelta, 'StepBlockDeltaCannotBeZero').to.not.equal(0n);
      sumMps += mps * blockDelta;
      sumBlockDelta += blockDelta;
    }
    expect(sumMps, 'InvalidStepDataMps').to.equal(MPS);
    expect(startBlock + sumBlockDelta, 'InvalidEndBlockGivenStepData').to.equal(
      endBlock,
    );
  };

  describe('the issuance schedule', () => {
    it('packs a step the way StepLib.parse reads one', () => {
      expect(encodeAuctionSteps([{ mps: 1n, blocks: 10_000_000n }])).to.equal(
        '0x0000010000989680',
      );
      expect(
        encodeAuctionSteps([{ mps: 0xabcden, blocks: 0x123456789an }]),
      ).to.equal('0x0abcde123456789a');
    });

    it('covers the block count and all of the supply, exactly, at any duration', () => {
      const lengths = [
        837_000n,
        5_000_000n,
        9_204_843n,
        9_999_999n,
        MAX_AUCTION_BLOCKS,
        MAX_AUCTION_BLOCKS / 3n,
        1n,
      ];
      for (const blocks of lengths) {
        const steps = auctionSteps(blocks);
        const startBlock = 81_000_000n;
        expect(
          checkAuctionSteps(steps, startBlock),
          `${blocks} blocks`,
        ).to.equal(startBlock + blocks);
        validateSchedule(steps, startBlock, startBlock + blocks);
      }
    });

    it('stays within one milli-bip a block of flat, and rises rather than falls', () => {
      const steps = auctionSteps(9_204_843n);
      expect(steps.length).to.be.at.most(2);
      const rates = steps.map((s) => s.mps);
      expect(
        Math.max(...rates.map(Number)) - Math.min(...rates.map(Number)),
      ).to.equal(1);
      for (let i = 1; i < steps.length; i += 1) {
        expect(
          steps[i].mps > steps[i - 1].mps,
          'the rate must not fall',
        ).to.equal(true);
      }
    });

    it('refuses an auction too long to release a milli-bip in every block', () => {
      expect(() => auctionSteps(MAX_AUCTION_BLOCKS + 1n)).to.throw(
        /is the most a flat schedule/,
      );
      expect(
        blocksIn(14n * 86_400n) > MAX_AUCTION_BLOCKS,
        'a fortnight is too long',
      ).to.equal(true);
    });

    it('refuses a schedule that releases the wrong amount', () => {
      expect(() => checkAuctionSteps([{ mps: 1n, blocks: 5n }], 0n)).to.throw(
        /releases 5 mps/,
      );
      expect(() => encodeAuctionSteps([{ mps: 1n, blocks: 0n }])).to.throw(
        /zero blocks/,
      );
      expect(() => encodeAuctionSteps([])).to.throw(/releases nothing/);
      expect(() =>
        encodeAuctionSteps([{ mps: 1n << 24n, blocks: 1n }]),
      ).to.throw(/uint24/);
    });
  });

  describe('the floor price', () => {
    it('is a Q96 ratio of raw units, not a price in satoshi', () => {
      expect(priceX96(40n)).to.equal((40n * (1n << 96n)) / 10n ** 18n + 1n);
      expect(satsFromPriceX96(priceX96(40n))).to.equal(40);
    });

    it('rounds up, so a floor is never below the one that was announced', () => {
      for (const sats of [1n, 7n, 30n, 40n, 123n, 10_000n]) {
        const encoded = priceX96(sats);
        expect(satsFromPriceX96(encoded), `${sats} sat`).to.be.at.least(
          Number(sats),
        );
      }
    });

    it('clears the floor the auction enforces, and leaves a readable bid grid', () => {
      const { cca } = { ...defaultConfig(), ...profileConfig('prod') };
      const { floorPrice, tickSpacing } = bidGrid(cca.floorBtc1e8);
      expect(floorPrice > MIN_FLOOR_PRICE, 'above MIN_FLOOR_PRICE').to.equal(true);
      expect(tickSpacing > MIN_BID_TICK_SPACING, 'above MIN_TICK_SPACING').to.equal(true);
      expect(
        tickSpacing * 10_000n >= floorPrice,
        'no finer than a basis point of the floor',
      ).to.equal(true);
    });

    /** The floor must sit on the bid grid, or the constructor reverts with `TickPriceNotAtBoundary`. */
    it('puts the floor on the bid grid without going below the announced price', () => {
      for (const sats of [1n, 7n, 40n, 123n, 10_000n]) {
        const { floorPrice, tickSpacing } = bidGrid(sats);
        expect(floorPrice % tickSpacing, `${sats} sat: floor on the grid`).to.equal(0n);
        expect(floorPrice >= priceX96(sats), `${sats} sat: not below the announced floor`).to.equal(
          true,
        );
        // Less than one tick, 2.5 bps.
        expect(floorPrice - priceX96(sats) < tickSpacing, `${sats} sat: within one tick`).to.equal(
          true,
        );
        expect(floorPrice).to.equal(tickSpacing * TICKS_PER_FLOOR);
      }
      const { floorPrice } = bidGrid(40n);
      expect(satsFromPriceX96(floorPrice)).to.be.within(40, 40.0000001);
    });
  });

  describe('the funding schedule and the position plan', () => {
    it('encodes brackets the launcher can decode', () => {
      const brackets = [
        { lowerThreshold: 0n, rate: 2_000_000n },
        { lowerThreshold: 500_000_000n, rate: MPS },
      ];
      const [decoded] = decodeAbiParameters(
        parseAbiParameters('(uint128 lowerThreshold, uint24 rate)[]'),
        encodeLpAllocationSchedule(brackets),
      );
      expect(
        decoded.map((b) => [b.lowerThreshold, BigInt(b.rate)]),
      ).to.deep.equal(brackets.map((b) => [b.lowerThreshold, b.rate]));
    });

    it('leaves the position plan empty, which is what mints one full-range position', () => {
      // A listed full-range definition would mint the same range twice.
      const [decoded] = decodeAbiParameters(
        parseAbiParameters(
          '(int24 offsetLower, int24 offsetUpper, uint24 weight, address overridePositionRecipient)[]',
        ),
        encodePositionDefinitions(FULL_RANGE_ONLY),
      );
      expect(decoded).to.have.length(0);
    });
  });

  describe('the configured launch', () => {
    it('is a single flat step, and the floor times the supply is the graduation threshold', () => {
      const { cca } = { ...defaultConfig(), ...profileConfig('prod') };
      const steps = auctionSteps(cca.durationBlocks);
      expect(
        steps,
        'the configured duration divides the supply evenly',
      ).to.have.length(1);
      expect(steps[0].mps).to.equal(1n);
      validateSchedule(steps, 0n, cca.durationBlocks);

      expect((cca.supplyStrat / 10n ** 18n) * cca.floorBtc1e8).to.equal(
        cca.minGraduationBtc1e8,
      );
      expect(secondsIn(cca.durationBlocks) / 86_400).to.be.within(11, 13);
    });

    it('opens bidding at 00:00 UTC on 15 October 2026 and closes it on 26 October', () => {
      const { cca } = { ...defaultConfig(), ...profileConfig('prod') };
      expect(new Date(Number(cca.biddingOpensAt) * 1000).toISOString()).to.equal(
        '2026-10-15T00:00:00.000Z',
      );
      const closes = Number(cca.biddingOpensAt) + secondsIn(cca.durationBlocks);
      expect(new Date(closes * 1000).toISOString().slice(0, 10)).to.equal('2026-10-26');
    });
  });

  describe('start block projection', () => {
    it('projects a moment forward from a known block, rounding up', () => {
      expect(blockAt(1_000n + 86_400n, 50n, 1_000n, 0.1)).to.equal(50n + 864_000n);
      expect(blockAt(1_001n, 50n, 1_000n, 0.3)).to.equal(54n);
    });

    it('refuses a moment that is not after the known block', () => {
      expect(() => blockAt(1_000n, 50n, 1_000n)).to.throw(/is not after block 50/);
      expect(() => blockAt(999n, 50n, 1_000n)).to.throw(/is not after block 50/);
    });

    it('offers the auction supply and reserves the rest for the pool', () => {
      const cfg = { ...defaultConfig(), ...profileConfig('prod') };
      expect(cfg.stratToLpMaker, 'what the launcher is funded with').to.equal(
        cfg.cca.supplyStrat + cfg.cca.lpReserveStrat,
      );
      expect(cfg.stratPriceBtc1e8).to.equal(cfg.cca.floorBtc1e8);
      expect(cfg.poolSeedBtc).to.equal(
        (cfg.poolSeedStrat / 10n ** 18n) * cfg.cca.floorBtc1e8,
      );
    });
  });
});
