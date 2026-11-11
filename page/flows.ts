export const packFlows: Record<string, string[]> = {
  "pull-requests": ["Your request", "Tests, then the fix", "Review by a second model", "Draft pull request"],
  orchestration: ["A large change", "Map of tickets", "Conductor thread", "One worker thread per ticket", "Draft pull requests"],
  memory: ["Agent on your Mac", "Your memory repo", "Agent on a devbox"],
  guards: ["Agent's shell command", "Guard hook", "The command runs or stops"],
  slack: ["Your Slack message or reaction", "Your Slack app", "T3 thread", "Link in Slack"],
  "mcp-gateway": ["Agent on any machine", "Tunnel to the hub", "MCP gateway", "Your MCP servers"],
  recovery: ["A thread hits a usage limit", "The hub asks the provider", "The provider answers", "The thread continues"],
};
