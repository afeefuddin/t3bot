import * as Schema from "effect/Schema";

export const serialize = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
