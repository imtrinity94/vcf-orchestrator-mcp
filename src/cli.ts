#!/usr/bin/env node
// Entry point: `vcf-orchestrator-mcp setup ...` runs the one-time service account setup,
// anything else starts the MCP server on stdio.
if (process.argv[2] === "setup") {
  const { runSetup } = await import("./setup.js");
  try {
    await runSetup(process.argv.slice(3));
    process.exit(0);
  } catch (e: any) {
    console.error(`\nSetup failed: ${e?.message ?? e}`);
    process.exit(1);
  }
} else {
  await import("./index.js");
}
