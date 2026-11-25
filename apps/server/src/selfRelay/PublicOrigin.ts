import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

/** Server-owned, verified exposure; request Host headers never establish this value. */
export class PublicOrigin extends Context.Reference<Effect.Effect<string | null>>(
  "p0code/PublicOrigin",
  { defaultValue: () => Effect.succeed(null) },
) {}
