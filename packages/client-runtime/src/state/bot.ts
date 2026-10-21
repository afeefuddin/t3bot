import { WS_METHODS } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createEnvironmentRpcCommand, createEnvironmentRpcQueryAtomFamily } from "./runtime.ts";

export function createBotEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    connection: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "bot:connection",
      tag: WS_METHODS.botGetConnection,
    }),
    configure: createEnvironmentRpcCommand(runtime, {
      label: "bot:configure",
      tag: WS_METHODS.botConfigureConnection,
    }),
  };
}
