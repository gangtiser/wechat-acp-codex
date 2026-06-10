/**
 * Formatting and value resolution for ACP session config options
 * (the `/acp-config` bridge command). Pure functions over the agent's
 * declared SessionConfigOption[] — no bridge state, unit-testable.
 */

import type * as acp from "@agentclientprotocol/sdk";

/** How the canonical command renders in usage text (incl. alias hint suffix). */
export interface ConfigCommandUsage {
  command: string;
  aliasHint: string;
}

export function formatConfigUsage(usage: ConfigCommandUsage, error?: string): string {
  const lines: string[] = [];
  if (error) {
    lines.push(`⚠️ ${error}`);
    lines.push("");
  }
  lines.push("💡 **Usage**");
  lines.push(`   • View:   ${usage.command}${usage.aliasHint}`);
  lines.push(`   • Update: ${usage.command} set <configId> <value>`);
  return lines.join("\n");
}

export function formatConfigList(
  configOptions: acp.SessionConfigOption[] | undefined,
  usage: ConfigCommandUsage,
): string {
  if (!configOptions) {
    return formatConfigUsage(
      usage,
      "No active ACP session for this chat yet. Send a normal message first.",
    );
  }
  if (configOptions.length === 0) {
    return formatConfigUsage(
      usage,
      "The current ACP agent does not expose any configurable session options.",
    );
  }

  const lines: string[] = [];
  lines.push("⚙️ **ACP Session Config**");
  lines.push("━━━━━━━━━━━━━━━━");

  for (const option of configOptions) {
    lines.push("");
    lines.push(`📌 **${option.name}**  (id: \`${option.id}\`)`);
    lines.push(`   • Current: ${describeCurrentConfigValue(option)}`);
    if (option.type === "select") {
      lines.push(`   • Options: ${listConfigOptionChoices(option).join(" | ")}`);
    } else if (option.type === "boolean") {
      lines.push(`   • Options: true | false`);
    }
  }

  lines.push("");
  lines.push("━━━━━━━━━━━━━━━━");
  lines.push("💡 **Usage**");
  lines.push(`   • View:   ${usage.command}${usage.aliasHint}`);
  lines.push(`   • Update: ${usage.command} set <configId> <value>`);
  return lines.join("\n");
}

export function resolveConfigValue(
  configOptions: acp.SessionConfigOption[] | undefined,
  configId: string,
  rawValue: string,
): { rawValue: string | boolean; displayValue: string } {
  if (!configOptions) {
    throw new Error("No active ACP session for this chat yet. Send a normal message first.");
  }

  const option = configOptions.find((candidate) => candidate.id === configId);
  if (!option) {
    throw new Error(`Unknown ACP config option: ${configId}`);
  }

  if (option.type === "boolean") {
    const normalized = rawValue.trim().toLowerCase();
    if (["true", "on", "1", "yes"].includes(normalized)) {
      return { rawValue: true, displayValue: "true" };
    }
    if (["false", "off", "0", "no"].includes(normalized)) {
      return { rawValue: false, displayValue: "false" };
    }
    throw new Error(`Invalid boolean value for ${configId}: ${rawValue}`);
  }

  const candidates = flattenSelectOptions(option.options).filter((choice) =>
    configChoiceAliases(choice).has(rawValue.trim().toLowerCase())
  );
  if (candidates.length === 0) {
    throw new Error(
      `Invalid value for ${configId}: ${rawValue}. Options: ${listConfigOptionChoices(option).join(", ")}`,
    );
  }
  if (candidates.length > 1) {
    throw new Error(`Ambiguous value for ${configId}: ${rawValue}`);
  }

  const match = candidates[0]!;
  return {
    rawValue: match.value,
    displayValue: describeConfigChoice(match),
  };
}

function describeCurrentConfigValue(option: acp.SessionConfigOption): string {
  if (option.type === "boolean") {
    return option.currentValue ? "true" : "false";
  }

  const current = findConfigOptionChoice(option, option.currentValue);
  return current ? describeConfigChoice(current) : option.currentValue;
}

function listConfigOptionChoices(option: acp.SessionConfigOption): string[] {
  if (option.type !== "select") return [];
  return flattenSelectOptions(option.options).map((choice) => describeConfigChoice(choice));
}

function flattenSelectOptions(
  options: acp.SessionConfigSelect["options"],
): acp.SessionConfigSelectOption[] {
  if (options.length === 0) return [];

  const first = options[0];
  if (first && "value" in first) {
    return options as acp.SessionConfigSelectOption[];
  }

  return (options as acp.SessionConfigSelectGroup[]).flatMap((group) => group.options);
}

function findConfigOptionChoice(
  option: acp.SessionConfigSelect,
  rawValue: string,
): acp.SessionConfigSelectOption | undefined {
  return flattenSelectOptions(option.options).find((choice) => choice.value === rawValue);
}

function configChoiceAliases(choice: acp.SessionConfigSelectOption): Set<string> {
  const aliases = new Set<string>();
  aliases.add(choice.value.toLowerCase());
  aliases.add(choice.name.toLowerCase());

  const compactName = choice.name.toLowerCase().replace(/\s+/g, "-");
  aliases.add(compactName);

  const tail = extractConfigValueTail(choice.value);
  if (tail) aliases.add(tail.toLowerCase());

  return aliases;
}

function describeConfigChoice(choice: acp.SessionConfigSelectOption): string {
  const tail = extractConfigValueTail(choice.value);
  if (tail && tail.toLowerCase() !== choice.name.toLowerCase()) {
    return tail;
  }
  return choice.value;
}

function extractConfigValueTail(value: string): string {
  const hashIndex = value.lastIndexOf("#");
  if (hashIndex >= 0 && hashIndex < value.length - 1) {
    return value.slice(hashIndex + 1);
  }

  const slashIndex = value.lastIndexOf("/");
  if (slashIndex >= 0 && slashIndex < value.length - 1) {
    return value.slice(slashIndex + 1);
  }

  return value;
}
