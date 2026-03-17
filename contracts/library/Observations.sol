// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title Observations
/// @author StratX
/// @notice Tick-accumulator ring buffer for a V4 hook TWAP.
/// @dev Ported from Panoptic's V4 oracle hook (Uniswap V3 `Oracle` arithmetic). Keeps a plain and a
///      truncated accumulator. Windows older than the buffer revert.
library Observations {
    /// @notice Thrown when the requested window reaches further back than the oldest observation.
    /// @param oldestTimestamp Timestamp of the oldest observation still in the ring.
    /// @param targetTimestamp Timestamp that was asked for.
    error TargetPredatesOldestObservation(
        uint32 oldestTimestamp,
        uint32 targetTimestamp
    );

    /// @notice Thrown when reading an array that was never initialized.
    error CardinalityCannotBeZero();

    /// @notice One recorded point of the tick history, packed into one slot.
    /// @param blockTimestamp Write timestamp, truncated to 32 bits.
    /// @param prevTruncatedTick Truncated tick recorded, the base for the next truncation step.
    /// @param tickCumulative Tick integrated over time.
    /// @param tickCumulativeTruncated Truncated tick integrated over time.
    /// @param initialized Whether the slot has been written.
    struct Observation {
        uint32 blockTimestamp;
        int24 prevTruncatedTick;
        int56 tickCumulative;
        int56 tickCumulativeTruncated;
        bool initialized;
    }

    /// @notice Advances an observation to `blockTimestamp` at `tick` without storing it.
    /// @dev Safe across one uint32 wrap. Truncation is measured from `last.prevTruncatedTick`.
    /// @param last Observation being advanced.
    /// @param blockTimestamp Timestamp to advance to.
    /// @param tick Pool tick at that time.
    /// @param maxAbsTickDelta Largest tick step the truncated accumulator may record.
    /// @return The advanced observation.
    function transform(
        Observation memory last,
        uint32 blockTimestamp,
        int24 tick,
        int24 maxAbsTickDelta
    ) internal pure returns (Observation memory) {
        unchecked {
            int24 truncatedTick = tick;
            int24 tickDelta = tick - last.prevTruncatedTick;

            if (tickDelta > maxAbsTickDelta || tickDelta < -maxAbsTickDelta) {
                truncatedTick =
                    last.prevTruncatedTick +
                    (tickDelta > 0 ? maxAbsTickDelta : -maxAbsTickDelta);
            }

            uint32 timeDelta = blockTimestamp - last.blockTimestamp;
            return
                Observation({
                    blockTimestamp: blockTimestamp,
                    prevTruncatedTick: truncatedTick,
                    tickCumulative: last.tickCumulative +
                        int56(tick) *
                        int56(uint56(timeDelta)),
                    tickCumulativeTruncated: last.tickCumulativeTruncated +
                        int56(truncatedTick) *
                        int56(uint56(timeDelta)),
                    initialized: true
                });
        }
    }

    /// @notice Writes the first observation. Called once, when the pool is initialized.
    /// @param self Stored observation array.
    /// @param time Current timestamp, truncated to 32 bits.
    /// @param tick Pool tick at initialization.
    /// @return cardinality Populated length of the array, always 1 here.
    /// @return cardinalityNext Target length of the array, always 1 here.
    function initialize(
        Observation[65535] storage self,
        uint32 time,
        int24 tick
    ) internal returns (uint16 cardinality, uint16 cardinalityNext) {
        self[0] = Observation({
            blockTimestamp: time,
            prevTruncatedTick: tick,
            tickCumulative: 0,
            tickCumulativeTruncated: 0,
            initialized: true
        });
        return (1, 1);
    }

    /// @notice Records the pre-action `tick` at most once per timestamp.
    /// @param index Index of the most recently written observation.
    /// @param blockTimestamp Current timestamp, truncated to 32 bits.
    /// @param tick Pool tick before the action being recorded.
    /// @param cardinality Populated length of the array.
    /// @param cardinalityNext Target length of the array.
    /// @param maxAbsTickDelta Largest tick step the truncated accumulator may record.
    /// @return indexUpdated New index of the most recently written observation.
    /// @return cardinalityUpdated New populated length of the array.
    function write(
        Observation[65535] storage self,
        uint16 index,
        uint32 blockTimestamp,
        int24 tick,
        uint16 cardinality,
        uint16 cardinalityNext,
        int24 maxAbsTickDelta
    ) internal returns (uint16 indexUpdated, uint16 cardinalityUpdated) {
        unchecked {
            Observation memory last = self[index];

            // Already recorded this timestamp.
            if (last.blockTimestamp == blockTimestamp) {
                return (index, cardinality);
            }

            // Grown slots join only at the end of the ring, keeping it time-ordered for the binary search.
            if (cardinalityNext > cardinality && index == (cardinality - 1)) {
                cardinalityUpdated = cardinalityNext;
            } else {
                cardinalityUpdated = cardinality;
            }

            indexUpdated = (index + 1) % cardinalityUpdated;
            self[indexUpdated] = transform(
                last,
                blockTimestamp,
                tick,
                maxAbsTickDelta
            );
        }
    }

    /// @notice Pre-pays the array to hold up to `next` observations.
    /// @dev Touches each new slot so later writes are warm.
    /// @param current Current target length.
    /// @param next Requested target length.
    /// @return The target length after the call.
    function grow(
        Observation[65535] storage self,
        uint16 current,
        uint16 next
    ) internal returns (uint16) {
        unchecked {
            if (current == 0) revert CardinalityCannotBeZero();
            if (next <= current) return current;
            for (; current < next; current++) {
                self[current].blockTimestamp = 1;
            }
            return next;
        }
    }

    /// @notice Whether `a` is chronologically at or before `b`, across a uint32 wrap.
    /// @dev Safe for a single overflow. `a` and `b` must both be at or before `time`.
    /// @param time Current timestamp, truncated to 32 bits.
    /// @param a First timestamp.
    /// @param b Second timestamp.
    /// @return Whether `a <= b` in time order.
    function lte(uint32 time, uint32 a, uint32 b) internal pure returns (bool) {
        unchecked {
            if (a <= time && b <= time) return a <= b;

            uint256 aAdjusted = a > time ? a : a + 2 ** 32;
            uint256 bAdjusted = b > time ? b : b + 2 ** 32;

            return aAdjusted <= bAdjusted;
        }
    }

    /// @notice Finds the two stored observations around `target`, which must lie inside the ring.
    /// @param self Stored observation array.
    /// @param time Current timestamp, truncated to 32 bits.
    /// @param target Timestamp being located.
    /// @param index Index of the most recently written observation.
    /// @param cardinality Populated length of the array.
    /// @return beforeOrAt Observation at or before `target`.
    /// @return atOrAfter Observation at or after `target`.
    function binarySearch(
        Observation[65535] storage self,
        uint32 time,
        uint32 target,
        uint16 index,
        uint16 cardinality
    )
        internal
        view
        returns (Observation memory beforeOrAt, Observation memory atOrAfter)
    {
        unchecked {
            uint256 left = (index + 1) % cardinality; // oldest observation
            uint256 right = left + cardinality - 1; // newest observation
            uint256 mid;
            while (true) {
                mid = (left + right) / 2;

                beforeOrAt = self[mid % cardinality];

                // Unwritten slot: search more recently.
                if (!beforeOrAt.initialized) {
                    left = mid + 1;
                    continue;
                }

                atOrAfter = self[(mid + 1) % cardinality];

                bool targetAtOrAfter = lte(
                    time,
                    beforeOrAt.blockTimestamp,
                    target
                );

                if (
                    targetAtOrAfter &&
                    lte(time, target, atOrAfter.blockTimestamp)
                ) break;

                if (!targetAtOrAfter) right = mid - 1;
                else left = mid + 1;
            }
        }
    }

    /// @notice Resolves `target` to a pair of observations, extrapolating past the newest.
    /// @dev Reverts when `target` is older than the oldest stored observation.
    /// @param self Stored observation array.
    /// @param time Current timestamp, truncated to 32 bits.
    /// @param target Timestamp being located.
    /// @param tick Current pool tick, used past the newest observation.
    /// @param index Index of the most recently written observation.
    /// @param cardinality Populated length of the array.
    /// @param maxAbsTickDelta Largest tick step the truncated accumulator may record.
    /// @return beforeOrAt Observation at or before `target`.
    /// @return atOrAfter Observation at or after `target`.
    function getSurroundingObservations(
        Observation[65535] storage self,
        uint32 time,
        uint32 target,
        int24 tick,
        uint16 index,
        uint16 cardinality,
        int24 maxAbsTickDelta
    )
        internal
        view
        returns (Observation memory beforeOrAt, Observation memory atOrAfter)
    {
        unchecked {
            beforeOrAt = self[index];

            if (lte(time, beforeOrAt.blockTimestamp, target)) {
                if (beforeOrAt.blockTimestamp == target) {
                    // `atOrAfter` is unused here.
                    return (beforeOrAt, atOrAfter);
                }
                return (
                    beforeOrAt,
                    transform(beforeOrAt, target, tick, maxAbsTickDelta)
                );
            }

            beforeOrAt = self[(index + 1) % cardinality];
            if (!beforeOrAt.initialized) beforeOrAt = self[0];

            if (!lte(time, beforeOrAt.blockTimestamp, target)) {
                revert TargetPredatesOldestObservation(
                    beforeOrAt.blockTimestamp,
                    target
                );
            }

            return binarySearch(self, time, target, index, cardinality);
        }
    }

    /// @notice Both accumulators `secondsAgo` before `time`; 0 for the current values.
    /// @dev Interpolation between writes is exact: the accumulator is piecewise linear.
    /// @param self Stored observation array.
    /// @param time Current timestamp, truncated to 32 bits.
    /// @param secondsAgo How far back to look.
    /// @param tick Current pool tick.
    /// @param index Index of the most recently written observation.
    /// @param cardinality Populated length of the array.
    /// @param maxAbsTickDelta Largest tick step the truncated accumulator may record.
    /// @return Tick accumulator as of `secondsAgo`.
    /// @return Truncated tick accumulator as of `secondsAgo`.
    function observeSingle(
        Observation[65535] storage self,
        uint32 time,
        uint32 secondsAgo,
        int24 tick,
        uint16 index,
        uint16 cardinality,
        int24 maxAbsTickDelta
    ) internal view returns (int56, int56) {
        unchecked {
            if (secondsAgo == 0) {
                Observation memory last = self[index];
                if (last.blockTimestamp != time) {
                    last = transform(last, time, tick, maxAbsTickDelta);
                }
                return (last.tickCumulative, last.tickCumulativeTruncated);
            }

            uint32 target = time - secondsAgo;

            (
                Observation memory beforeOrAt,
                Observation memory atOrAfter
            ) = getSurroundingObservations(
                    self,
                    time,
                    target,
                    tick,
                    index,
                    cardinality,
                    maxAbsTickDelta
                );

            if (target == beforeOrAt.blockTimestamp) {
                return (
                    beforeOrAt.tickCumulative,
                    beforeOrAt.tickCumulativeTruncated
                );
            } else if (target == atOrAfter.blockTimestamp) {
                return (
                    atOrAfter.tickCumulative,
                    atOrAfter.tickCumulativeTruncated
                );
            } else {
                uint32 observationTimeDelta = atOrAfter.blockTimestamp -
                    beforeOrAt.blockTimestamp;
                uint32 targetDelta = target - beforeOrAt.blockTimestamp;
                return (
                    beforeOrAt.tickCumulative +
                        ((atOrAfter.tickCumulative -
                            beforeOrAt.tickCumulative) /
                            int56(uint56(observationTimeDelta))) *
                        int56(uint56(targetDelta)),
                    beforeOrAt.tickCumulativeTruncated +
                        ((atOrAfter.tickCumulativeTruncated -
                            beforeOrAt.tickCumulativeTruncated) /
                            int56(uint56(observationTimeDelta))) *
                        int56(uint56(targetDelta))
                );
            }
        }
    }

    /// @notice Both accumulators at each of `secondsAgos`.
    /// @param self Stored observation array.
    /// @param time Current timestamp, truncated to 32 bits.
    /// @param secondsAgos How far back each returned point is.
    /// @param tick Current pool tick.
    /// @param index Index of the most recently written observation.
    /// @param cardinality Populated length of the array.
    /// @param maxAbsTickDelta Largest tick step the truncated accumulator may record.
    /// @return tickCumulatives Tick accumulator at each point.
    /// @return tickCumulativesTruncated Truncated tick accumulator at each point.
    function observe(
        Observation[65535] storage self,
        uint32 time,
        uint32[] memory secondsAgos,
        int24 tick,
        uint16 index,
        uint16 cardinality,
        int24 maxAbsTickDelta
    )
        internal
        view
        returns (
            int56[] memory tickCumulatives,
            int56[] memory tickCumulativesTruncated
        )
    {
        unchecked {
            if (cardinality == 0) revert CardinalityCannotBeZero();

            uint256 n = secondsAgos.length;
            tickCumulatives = new int56[](n);
            tickCumulativesTruncated = new int56[](n);
            for (uint256 i = 0; i < n; i++) {
                (
                    tickCumulatives[i],
                    tickCumulativesTruncated[i]
                ) = observeSingle(
                    self,
                    time,
                    secondsAgos[i],
                    tick,
                    index,
                    cardinality,
                    maxAbsTickDelta
                );
            }
        }
    }
}
