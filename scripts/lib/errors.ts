import { decodeErrorResult, type Abi } from 'viem';

export type DecodedRevert = {
  errorName: string;
  args: readonly unknown[];
};

type MaybeError = {
  cause?: unknown;
  data?: unknown;
  raw?: unknown;
  reason?: unknown;
  shortMessage?: unknown;
  details?: unknown;
  message?: unknown;
};

function collect(e: unknown): { raw?: `0x${string}`; named?: string } {
  let raw: `0x${string}` | undefined;
  let named: string | undefined;

  for (let x = e as MaybeError | undefined; x; x = x.cause as MaybeError) {
    const data = x.data as { errorName?: string } | string | undefined;
    if (!named && typeof data === 'object' && data?.errorName) {
      named = data.errorName;
    }
    if (!raw && typeof x.raw === 'string' && x.raw.startsWith('0x')) {
      raw = x.raw as `0x${string}`;
    }
    if (!raw && typeof data === 'string' && data.startsWith('0x')) {
      raw = data as `0x${string}`;
    }
    if (typeof x.cause !== 'object' || x.cause === null) break;
  }

  return { raw, named };
}

export function decodeRevert(
  e: unknown,
  abis: Abi[],
): DecodedRevert | undefined {
  const { raw, named } = collect(e);

  if (raw && raw.length >= 10) {
    for (const abi of abis) {
      try {
        const decoded = decodeErrorResult({ abi, data: raw });
        return {
          errorName: decoded.errorName,
          args: (decoded.args ?? []) as readonly unknown[],
        };
      } catch {
        // Wrong ABI for this selector; try the next one.
      }
    }
  }

  return named ? { errorName: named, args: [] } : undefined;
}

export function revertName(e: unknown, abis: Abi[]): string {
  const decoded = decodeRevert(e, abis);
  if (decoded) {
    return decoded.args.length === 0
      ? decoded.errorName
      : `${decoded.errorName}(${decoded.args.map(String).join(', ')})`;
  }

  const err = e as MaybeError;
  const text = [err?.shortMessage, err?.details, err?.message]
    .filter((part): part is string => typeof part === 'string')
    .join(' ');
  return text.split('\n')[0].slice(0, 160) || String(e);
}
