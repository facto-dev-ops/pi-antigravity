import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  ANTIGRAVITY_MODELS,
  ANTIGRAVITY_ROUTING,
  applyAntigravityCatalog,
} from "../models/models.js";
import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import type { PluginHostApi } from "./native-contract.js";
import { DesktopAuthStore } from "./auth.js";
import { discoverAntigravityModels } from "../models/discovery.js";

declare const __dirname: string;

function getDesktopDir(): string {
  if (typeof __dirname !== "undefined") {
    return __dirname;
  }
  return process.cwd();
}

function getManifestPath(): string {
  return resolve(getDesktopDir(), "manifest.json");
}

function getConfigPath(): string {
  return resolve(getDesktopDir(), "antigravity-models.json");
}

export interface StoredModelConfig {
  id: string;
  name?: string;
  contextWindow: number;
  maxTokens: number;
  supportsImages: boolean;
  thinkingLevels: string[];
  defaultThinkingLevel: string;
  enabled?: boolean;
  isCustom?: boolean;
}

export interface PanelConfigPayload {
  accountName: string;
  models: StoredModelConfig[];
  customModels?: string[];
}

function loadSavedConfig(): PanelConfigPayload | null {
  try {
    const configPath = getConfigPath();
    if (existsSync(configPath)) {
      const data: unknown = JSON.parse(readFileSync(configPath, "utf8"));
      if (data && typeof data === "object" && "models" in data && Array.isArray(data.models)) {
        return data as PanelConfigPayload;
      }
    }
  } catch {
    // fallback
  }
  return null;
}

function defaultModelList(): StoredModelConfig[] {
  return ANTIGRAVITY_MODELS.map((model) => ({
    id: model.id,
    name: model.name,
    contextWindow: model.contextWindow ?? 1048576,
    maxTokens: model.maxTokens ?? 65536,
    supportsImages: model.input?.includes("image") === true,
    thinkingLevels: Object.entries(model.thinkingLevelMap || {})
      .filter(([, v]) => v !== null)
      .map(([k]) => k),
    defaultThinkingLevel: model.id.startsWith("gpt-oss-")
      ? "medium"
      : model.id.startsWith("claude-")
        ? "high"
        : "low",
    enabled: true,
    isCustom: false,
  }));
}

export async function handlePanelInvoke(
  channel: string,
  payload: Record<string, unknown>,
  api?: PluginHostApi,
): Promise<unknown> {
  switch (channel) {
    case "ui.openPanel": {
      if (api?.ui?.openPanel) {
        await api.ui.openPanel();
      }
      return { ok: true };
    }

    case "ui.closePanel": {
      if (api?.ui?.closePanel) {
        await api.ui.closePanel();
      }
      return { ok: true };
    }

    case "antigravity:get-config": {
      const saved = loadSavedConfig();
      const defaults = defaultModelList();

      // Check account email if available
      let accountEmail = "Google Antigravity";
      try {
        const authStore = new DesktopAuthStore();
        const status = authStore.status();
        if (status.email) accountEmail = status.email;
      } catch {
        // ignore
      }

      const configuredIds = saved?.models?.map((m) => m.id) ?? defaults.map((m) => m.id);

      // Combine defaults + custom models to form all available models
      const allAvailableMap = new Map<string, StoredModelConfig>();
      for (const m of defaults) {
        allAvailableMap.set(m.id, m);
      }
      for (const m of saved?.models ?? []) {
        if (!allAvailableMap.has(m.id)) {
          allAvailableMap.set(m.id, { ...m, isCustom: true });
        }
      }

      return {
        ok: true,
        accountName: saved?.accountName || accountEmail,
        allModels: Array.from(allAvailableMap.values()),
        configuredModelIds: configuredIds,
        savedModelSettings: saved?.models ?? defaults,
      };
    }

    case "antigravity:fetch-models": {
      // Attempt remote discovery if auth is available
      try {
        const authStore = new DesktopAuthStore();
        const key = await authStore.apiKey();
        if (key) {
          const catalog = await discoverAntigravityModels(key);
          if (catalog.models.length > 0) {
            const discovered: StoredModelConfig[] = catalog.models.map((model) => ({
              id: model.id,
              name: model.name,
              contextWindow: model.contextWindow ?? 1048576,
              maxTokens: model.maxTokens ?? 65536,
              supportsImages: model.input?.includes("image") === true,
              thinkingLevels: Object.entries(model.thinkingLevelMap || {})
                .filter(([, v]) => v !== null)
                .map(([k]) => k),
              defaultThinkingLevel: model.id.startsWith("gpt-oss-")
                ? "medium"
                : model.id.startsWith("claude-")
                  ? "high"
                  : "low",
              enabled: true,
              isCustom: false,
            }));
            return {
              ok: true,
              source: "remote",
              models: discovered,
            };
          }
        }
      } catch {
        // Fall back to builtins
      }

      return {
        ok: true,
        source: "builtin",
        models: defaultModelList(),
      };
    }

    case "antigravity:save-config": {
      const data = payload as unknown as PanelConfigPayload;
      if (!data || !Array.isArray(data.models)) {
        throw new Error("Invalid model configuration payload.");
      }

      // 1. Save to antigravity-models.json
      const configPath = getConfigPath();
      writeFileSync(configPath, JSON.stringify(data, null, 2) + "\n", "utf8");

      // 2. Update desktop/manifest.json with the chosen models so Host has it immediately on reload
      try {
        const manifestPath = getManifestPath();
        if (existsSync(manifestPath)) {
          const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
            contributes?: { providers?: Array<{ models: unknown }> };
          } | null;
          if (manifest?.contributes?.providers?.[0]) {
            manifest.contributes.providers[0].models = data.models.map((m) => ({
              id: m.id,
              name: m.name || m.id,
              contextWindow: m.contextWindow,
              maxTokens: m.maxTokens,
              supportsImages: m.supportsImages,
              thinkingLevels: m.thinkingLevels,
              defaultThinkingLevel: m.defaultThinkingLevel,
            }));
            writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");
          }
        }
      } catch (err) {
        console.error("Failed to update manifest.json with saved models:", err);
      }

      // 3. Dynamically update runtime catalog
      const newModels: ProviderModelConfig[] = data.models.map((m) => {
        const thinkingMap: Record<string, string | null> = {};
        for (const lvl of m.thinkingLevels) {
          thinkingMap[lvl] = lvl;
        }
        return {
          id: m.id,
          name: m.name || m.id,
          reasoning: m.thinkingLevels.length > 0 && !m.thinkingLevels.every((l) => l === "off"),
          thinkingLevelMap: thinkingMap,
          input: m.supportsImages ? ["text", "image"] : ["text"],
          contextWindow: m.contextWindow,
          maxTokens: m.maxTokens,
        } as unknown as ProviderModelConfig;
      });

      applyAntigravityCatalog({
        models: newModels,
        routing: { ...ANTIGRAVITY_ROUTING },
      });

      return {
        ok: true,
        count: data.models.length,
      };
    }

    default:
      return { ok: false, error: `Unhandled panel channel: ${channel}` };
  }
}
