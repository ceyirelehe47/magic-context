/**
 * Compile-time pin: the hand-maintained public declarations in
 * `types/index.d.ts` (package.json `types`) must stay assignable from the
 * implementation in `src/index.ts`.
 */
import type * as Impl from "../index";
import type * as Public from "../../types/index";

type Assert<T extends true> = T;
type Extends<A, B> = [A] extends [B] ? true : false;

export type PublicTypeContract = [
  Assert<Extends<Impl.MagicContextHostService, Public.MagicContextHostService>>,
  Assert<Extends<Impl.MagicHostConfig, Public.MagicHostConfig>>,
  Assert<Extends<Public.MagicHostConfig, Impl.MagicHostConfig>>,
  Assert<Extends<Impl.MagicSummarizeHook, Public.MagicSummarizeHook>>,
  Assert<Extends<typeof Impl.apply, typeof Public.apply>>,
  Assert<Extends<typeof Impl.name, typeof Public.name>>,
  Assert<Extends<typeof Impl.defaultHomeHash, typeof Public.defaultHomeHash>>,
];
