import type { Config } from "./config.ts";

/** Copyable operator commands for the deploy path in cfg.deploy (single source of truth for the UI and docs hints). */
export interface OperatorCommands {
  deploy: Config["deploy"];
  claudeLogin: string;
  codexLogin: string;
  setupCode: string;
  restart: string; // applies .env changes ("" for local deploy)
}

// Run from the directory that holds docker-compose.yml. `exec` allocates a TTY by default, so the interactive logins work.
export function operatorCommands(cfg: Pick<Config, "deploy">): OperatorCommands {
  switch (cfg.deploy) {
    case "compose":
      return {
        deploy: "compose",
        claudeLogin: "docker compose exec argus claude",
        codexLogin: "docker compose exec argus codex login --device-auth",
        setupCode: "docker compose exec argus cat /data/setup-code",
        // `up -d` (not `restart`): only it re-reads .env and recreates the container when the environment changed.
        restart: "docker compose up -d",
      };
    default:
      return { deploy: "local", claudeLogin: "claude", codexLogin: "codex login --device-auth", setupCode: "cat data/setup-code", restart: "" };
  }
}
