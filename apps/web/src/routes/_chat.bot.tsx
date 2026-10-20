import { createFileRoute } from "@tanstack/react-router";
import { BotPage } from "~/components/bot/BotPage";

export const Route = createFileRoute("/_chat/bot")({ component: BotPage });
