import type { BotWorkerProvider } from "@t3tools/contracts/bot";
import type { ModelSelection, ProviderInteractionMode } from "@t3tools/contracts";

export function isBotWorkerSelectionAvailable(
  providers: ReadonlyArray<BotWorkerProvider>,
  selection: ModelSelection,
  interactionMode: ProviderInteractionMode = "default",
): boolean {
  const provider = providers.find((p) => p.instanceId === selection.instanceId);
  const model = provider?.models.find((m) => m.id === selection.model);
  if (!provider?.interactionModes.includes(interactionMode) || !model) return false;
  const options = selection.options ?? [];
  if (new Set(options.map((option) => option.id)).size !== options.length) return false;
  return options.every((option) => {
    const descriptor = model.options.find((d) => d.id === option.id);
    return descriptor?.type === "boolean"
      ? typeof option.value === "boolean"
      : descriptor?.type === "select" &&
          descriptor.options.some((choice) => choice.id === option.value);
  });
}
