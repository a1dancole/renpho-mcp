/**
 * Entry point. Wires three things together:
 *   1. workers-oauth-provider  — makes this Worker an OAuth server to Claude.
 *   2. AuthHandler             — the Renpho sign-in page (no upstream OAuth exists).
 *   3. RenphoMCP (McpAgent / Durable Object) — serves the MCP tools.
 *
 * Add the deployed URL (".../mcp") to Claude as a custom connector; clicking
 * "Connect" shows the Renpho sign-in and the tools light up on web/desktop/mobile.
 */
import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { AuthHandler } from "./auth-handler";
import { RenphoClient } from "./renpho-api";
import { registerTools } from "./tools";
import type { Env, Props } from "./types";

export class RenphoMCP extends McpAgent<Env, Record<string, never>, Props> {
  // `this.env` is set by the Durable Object base constructor, so it is
  // available to field initialisers. PUBLIC_URL lets clients that render
  // server branding (Claude's connector list) show the icon served at /icon.png.
  server = new McpServer({
    name: "Renpho Health",
    title: "Renpho Health",
    version: "0.1.0",
    ...(this.env?.PUBLIC_URL
      ? {
          websiteUrl: this.env.PUBLIC_URL,
          icons: [{ src: `${this.env.PUBLIC_URL.replace(/\/$/, "")}/icon.png`, mimeType: "image/png", sizes: ["512x512"] }],
        }
      : {}),
  });

  private client?: RenphoClient;

  async init() {
    registerTools(this.server, () => this.getClient(), this.env.TIME_ZONE || "Europe/London");
  }

  /** One client per Durable Object instance so the Renpho session stays warm in memory. */
  private getClient(): RenphoClient {
    if (!this.client) {
      this.client = new RenphoClient({
        email: this.props.email,
        password: this.props.password,
        userHash: this.props.userHash,
        cache: this.env.RENPHO_CACHE,
        sealSecret: this.env.SESSION_ENCRYPTION_KEY,
      });
    }
    return this.client;
  }
}

export default new OAuthProvider({
  apiRoute: "/mcp",
  apiHandler: RenphoMCP.serve("/mcp") as any,
  defaultHandler: AuthHandler as any,
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/token",
  clientRegistrationEndpoint: "/register",
});
