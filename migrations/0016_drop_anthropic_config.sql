-- "Ask Claude" no longer calls the Anthropic API from the server: it drafts a
-- prompt for Claude with loopk's MCP tools instead. The stored API key goes.
DROP TABLE anthropic_config;
