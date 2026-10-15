export type ProviderProtocol = "openai" | "anthropic";

export interface ModelPrice {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
}

export interface ModelInput {
  id: string;
  name: string;
  vision: boolean;
  thinkingLevels: string[];
  contextWindow: number;
  maxOutputTokens: number;
  price?: ModelPrice;
}

export interface ProviderDetail {
  id: number;
  name: string;
  protocol: ProviderProtocol;
  baseUrl: string;
  hasKey: boolean;
  keyHint: string | null;
  models: ModelInput[];
}

export interface ModelProviderPreset {
  id: string;
  name: string;
  protocol: ProviderProtocol;
  baseUrl: string;
}

export interface ProviderDraft {
  id?: number;
  originalProtocol?: ProviderProtocol;
  originalBaseUrl?: string;
  presetId: string;
  name: string;
  protocol: ProviderProtocol;
  baseUrl: string;
  apiKey: string;
  hasKey: boolean;
  keyHint: string | null;
  models: ModelInput[];
}

export const emptyModel = (): ModelInput => ({
  id: "",
  name: "",
  vision: false,
  thinkingLevels: ["off"],
  contextWindow: 128_000,
  maxOutputTokens: 8_192,
});
