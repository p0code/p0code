import type { PluginCapability } from "@t3tools/contracts";
import { msg } from "gt-react";

export const pluginCapabilityCopy = {
  "usage:read": msg(
    "Can read your token and cost totals for every agent, one row per day, provider and model. Never prompts, paths or titles.",
  ),
  "data:backup": msg(
    "Can read a copy of all your chats, attachments and settings, and propose replacing them with a backup.",
  ),
  "orchestration:read-activity": msg(
    "Can read which agents are active, their thread and project titles, and when they need your attention.",
  ),
  "auth:issue-device-credentials": msg(
    "Can pair devices that stay signed in until you disable the plugin.",
  ),
  "process:spawn": msg(
    "Can run helper programs on the server with access to its files and credentials.",
  ),
  "network:outbound": msg("Can connect to external services and send data from the server."),
  "http:routes": msg(
    "Can expose declared web endpoints without requiring a signed-in session while enabled.",
  ),
  "agent:instructions": msg("Can add instructions to every agent turn while enabled."),
} satisfies Record<PluginCapability, string>;
