import { getDefaultRuntimeConstraints } from "./runtime-constraints";

export const DEFAULT_WORKSPACE_ROOT = "/workspace";

export const DEFAULT_RUNTIME_CONSTRAINTS = getDefaultRuntimeConstraints();

export const DEFAULT_WORKSPACE_FILES: Record<string, string> = {
  "/workspace/README.md": `# justune demo workspace

This workspace lives entirely inside the browser.

## What to try

- Summarize the project structure
- Turn docs/launch-brief.md into a short launch checklist
- Create a changelog entry
- Rewrite src/lib/notes.ts into a shorter version
`,
  "/workspace/src/lib/notes.ts": `export const notes = [
  "Agent execution should happen in the browser.",
  "Server should only proxy LLM requests.",
  "The UI must keep a readable audit trail.",
  "Changed files should be exportable as a patch or JSON bundle.",
];
`,
  "/workspace/src/app/config.json": `{
  "name": "justune-demo",
  "workspaceRoot": "/workspace",
  "features": ["bash", "readFile", "writeFile", "export"]
}
`,
  "/workspace/docs/launch-brief.md": `# Launch brief

The browser demo should show the core product shape clearly:

- Tools run locally inside the browser workspace.
- The server only brokers LLM turns and session checks.
- Users can inspect the full tool log and export file changes.

For the next polish pass, prefer tighter prompts and smoother workspace import/export copy rather than exposing an internal TODO list.
`,
};
