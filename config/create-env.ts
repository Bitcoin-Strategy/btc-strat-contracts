/* Adapted from @t3-oss/env: Hardhat cannot load ESM from TS projects. */
/* eslint-disable @typescript-eslint/ban-types */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { type ZodError, type ZodObject, type ZodType, z } from 'zod';

export type ErrorMessage<T extends string> = T;
export type Simplify<T> = {
  [P in keyof T]: T[P];
} & {};

type Impossible<T extends Record<string, any>> = Partial<
  Record<keyof T, never>
>;

type UnReadonlyObject<T> = T extends Readonly<infer U> ? U : T;

type Reduce<
  TArr extends Array<Record<string, unknown>>,
  TAcc = {},
> = TArr extends []
  ? TAcc
  : TArr extends [infer Head, ...infer Tail]
    ? Tail extends Array<Record<string, unknown>>
      ? Head & Reduce<Tail, TAcc>
      : never
    : never;

export interface BaseOptions<
  TShared extends Record<string, ZodType>,
  TExtends extends Array<Record<string, unknown>>,
> {
  /** @default typeof window === "undefined" */
  isServer?: boolean;

  /** Variables available to both server and client without a prefix, e.g. `NODE_ENV`. */
  shared?: TShared;

  extends?: TExtends;

  /** Called when validation fails. Throws by default. */
  onValidationError?: (error: ZodError) => never;

  /** Called when a server variable is read on the client. Throws by default. */
  onInvalidAccess?: (variable: string) => never;

  /** @default false */
  skipValidation?: boolean;

  /** Treat empty strings as undefined, so defaults apply and `PORT=` is not a type error. */
  emptyStringAsUndefined?: boolean;
}

export interface LooseOptions<
  TShared extends Record<string, ZodType>,
  TExtends extends Array<Record<string, unknown>>,
> extends BaseOptions<TShared, TExtends> {
  runtimeEnvStrict?: never;

  /** Runtime env object, usually `process.env`. Does not require every variable to be set. */
  runtimeEnv: Record<string, string | boolean | number | undefined>;
}

export interface StrictOptions<
  TPrefix extends string | undefined,
  TServer extends Record<string, ZodType>,
  TClient extends Record<string, ZodType>,
  TShared extends Record<string, ZodType>,
  TExtends extends Array<Record<string, unknown>>,
> extends BaseOptions<TShared, TExtends> {
  /** Runtime env object; requires every variable to be set. */
  runtimeEnvStrict: Record<
    | {
        [TKey in keyof TClient]: TPrefix extends undefined
          ? never
          : TKey extends `${TPrefix}${string}`
            ? TKey
            : never;
      }[keyof TClient]
    | {
        [TKey in keyof TServer]: TPrefix extends undefined
          ? TKey
          : TKey extends `${TPrefix}${string}`
            ? never
            : TKey;
      }[keyof TServer]
    | {
        [TKey in keyof TShared]: TKey extends string ? TKey : never;
      }[keyof TShared],
    string | boolean | number | undefined
  >;
  runtimeEnv?: never;
}

export interface ClientOptions<
  TPrefix extends string | undefined,
  TClient extends Record<string, ZodType>,
> {
  /** Prefix client variables must have, enforced in types and at runtime. */
  clientPrefix: TPrefix;

  client: Partial<{
    [TKey in keyof TClient]: TKey extends `${TPrefix}${string}`
      ? TClient[TKey]
      : ErrorMessage<`${TKey extends string
          ? TKey
          : never} is not prefixed with ${TPrefix}.`>;
  }>;
}

export interface ServerOptions<
  TPrefix extends string | undefined,
  TServer extends Record<string, ZodType>,
> {
  server: Partial<{
    [TKey in keyof TServer]: TPrefix extends undefined
      ? TServer[TKey]
      : TPrefix extends ''
        ? TServer[TKey]
        : TKey extends `${TPrefix}${string}`
          ? ErrorMessage<`${TKey extends `${TPrefix}${string}`
              ? TKey
              : never} should not prefixed with ${TPrefix}.`>
          : TServer[TKey];
  }>;
}

export type ServerClientOptions<
  TPrefix extends string | undefined,
  TServer extends Record<string, ZodType>,
  TClient extends Record<string, ZodType>,
> =
  | (ClientOptions<TPrefix, TClient> & ServerOptions<TPrefix, TServer>)
  | (ServerOptions<TPrefix, TServer> & Impossible<ClientOptions<never, never>>)
  | (ClientOptions<TPrefix, TClient> & Impossible<ServerOptions<never, never>>);

export type EnvOptions<
  TPrefix extends string | undefined,
  TServer extends Record<string, ZodType>,
  TClient extends Record<string, ZodType>,
  TShared extends Record<string, ZodType>,
  TExtends extends Array<Record<string, unknown>>,
> =
  | (LooseOptions<TShared, TExtends> &
      ServerClientOptions<TPrefix, TServer, TClient>)
  | (StrictOptions<TPrefix, TServer, TClient, TShared, TExtends> &
      ServerClientOptions<TPrefix, TServer, TClient>);

export function createEnv<
  TPrefix extends string | undefined,
  TServer extends Record<string, ZodType> = NonNullable<unknown>,
  TClient extends Record<string, ZodType> = NonNullable<unknown>,
  TShared extends Record<string, ZodType> = NonNullable<unknown>,
  const TExtends extends Array<Record<string, unknown>> = [],
>(
  opts: EnvOptions<TPrefix, TServer, TClient, TShared, TExtends>,
): Readonly<
  Simplify<
    z.infer<ZodObject<TServer>> &
      z.infer<ZodObject<TClient>> &
      z.infer<ZodObject<TShared>> &
      UnReadonlyObject<Reduce<TExtends>>
  >
> {
  const runtimeEnv = opts.runtimeEnvStrict ?? opts.runtimeEnv ?? process.env;

  const emptyStringAsUndefined = opts.emptyStringAsUndefined ?? false;
  if (emptyStringAsUndefined) {
    for (const [key, value] of Object.entries(runtimeEnv)) {
      if (value === '') {
        delete runtimeEnv[key];
      }
    }
  }

  const skip = !!opts.skipValidation;
  if (skip) return runtimeEnv as any;

  const _client = typeof opts.client === 'object' ? opts.client : {};
  const _server = typeof opts.server === 'object' ? opts.server : {};
  const _shared = typeof opts.shared === 'object' ? opts.shared : {};
  const client = z.object(_client);
  const server = z.object(_server);
  const shared = z.object(_shared);
  const isServer = opts.isServer ?? typeof window === 'undefined';

  const allClient = client.merge(shared);
  const allServer = server.merge(shared).merge(client);
  const parsed = isServer
    ? allServer.safeParse(runtimeEnv) // on server we can validate all env vars
    : allClient.safeParse(runtimeEnv); // on client we can only validate the ones that are exposed

  const onValidationError =
    opts.onValidationError ??
    ((error: ZodError) => {
      console.error(
        '❌ Invalid environment variables:',
        error.flatten().fieldErrors,
      );
      throw new Error('Invalid environment variables');
    });

  const onInvalidAccess =
    opts.onInvalidAccess ??
    (() => {
      throw new Error(
        '❌ Attempted to access a server-side environment variable on the client',
      );
    });

  if (parsed.success === false) {
    return onValidationError(parsed.error);
  }

  const isServerAccess = (prop: string) => {
    if (!opts.clientPrefix) return true;
    return !prop.startsWith(opts.clientPrefix) && !(prop in shared.shape);
  };
  const isValidServerAccess = (prop: string) => {
    return isServer || !isServerAccess(prop);
  };
  const ignoreProp = (prop: string) => {
    return prop === '__esModule' || prop === '$$typeof';
  };

  const extendedObj = (opts.extends ?? []).reduce((acc, curr) => {
    return Object.assign(acc, curr);
  }, {});
  const fullObj = Object.assign(parsed.data, extendedObj);

  const env = new Proxy(fullObj, {
    get(target, prop) {
      if (typeof prop !== 'string') return undefined;
      if (ignoreProp(prop)) return undefined;
      if (!isValidServerAccess(prop)) return onInvalidAccess(prop);
      return Reflect.get(target, prop);
    },
  });

  return env as any;
}
