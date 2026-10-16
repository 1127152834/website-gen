export interface GristSettings {
  baseUrl: string;
  apiKeyHint: string | null;
  configured: boolean;
}

export function gristMcpCommand(origin: string, token?: string): string {
  return `claude mcp add --transport http grist ${origin}/api/mcp --header "Authorization: Bearer ${token || "<MCP 令牌>"}"`;
}
