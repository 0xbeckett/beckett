/**
 * Versioned Discord component routing. Component ids are untrusted transport data: authority
 * always comes from the authenticated interaction user, never from an id or its source message.
 */
import type { DiscordComponentInteraction } from "../types.ts";
import type { AccessLevel } from "./access.ts";

const PREFIX = "beckett";
const VERSION = "v1";
const TARGET = /^\d+(?:\.\d+){0,3}$/;

export type ComponentAction = "merge" | "cancel" | "attach";

export interface DecodedComponentId {
  action: ComponentAction;
  target: string;
}

/** Build an opaque-enough, versioned component id. Targets are public task/branch refs only. */
export function componentId(action: ComponentAction, target: string): string {
  if (!TARGET.test(target)) throw new Error(`invalid component target "${target}"`);
  return `${PREFIX}:${VERSION}:${action}:${target}`;
}

/** Parse only ids made by this version. Unknown versions/actions fail closed. */
export function decodeComponentId(customId: string): DecodedComponentId | null {
  const parts = customId.split(":");
  if (parts.length !== 4 || parts[0] !== PREFIX || parts[1] !== VERSION || !TARGET.test(parts[3]!)) return null;
  const action = parts[2];
  if (action !== "merge" && action !== "cancel" && action !== "attach") return null;
  return { action, target: parts[3]! };
}

export interface ComponentActionContext extends DecodedComponentId {
  interaction: DiscordComponentInteraction;
  /** Fresh classification of Discord's authenticated clicking user. */
  access: AccessLevel;
}

export type ComponentActionHandler = (ctx: ComponentActionContext) => Promise<string> | string;

/**
 * One registry for every component action. The gateway does acknowledgement; this router owns
 * decoding, fresh access classification, refusal, and verb dispatch so listener growth is one
 * registration rather than an if-chain.
 */
export class ComponentRouter {
  private readonly handlers = new Map<ComponentAction, ComponentActionHandler>();

  constructor(private readonly classifyUser: (userId: string) => AccessLevel) {}

  register(action: ComponentAction, handler: ComponentActionHandler): this {
    this.handlers.set(action, handler);
    return this;
  }

  async dispatch(interaction: DiscordComponentInteraction): Promise<void> {
    const decoded = decodeComponentId(interaction.customId);
    if (!decoded) {
      await interaction.editReply("That control is unknown or out of date.");
      return;
    }
    const handler = this.handlers.get(decoded.action);
    if (!handler) {
      await interaction.editReply("That control is not available here.");
      return;
    }

    // Do this for EVERY click, rather than accepting the role/message that happened to create it.
    const access = this.classifyUser(interaction.userId);
    if (access === "outsider") {
      await interaction.editReply("You are not authorized to use that control.");
      return;
    }

    try {
      await interaction.editReply(await handler({ ...decoded, interaction, access }));
    } catch {
      // Do not disclose internal errors or perform retries after a possibly ambiguous mutation.
      await interaction.editReply("That action could not be completed. Please try again or check the branch status.");
    }
  }
}
