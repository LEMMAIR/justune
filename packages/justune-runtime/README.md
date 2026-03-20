# @lemmair/justune-runtime

The runtime for Justune agents, providing safe browser sandboxing for tool execution.

## Features

- **Safe Browser Sandboxing**: Runs tools in an isolated Web Worker using `just-bash`.
- **In-Browser Workspace**: Maintains a virtual workspace in memory at `/workspace`.
- **Tool Execution**: Supports `bash`, `readFile`, `writeFile`, `replaceInFile`, `applyPatch`, and `listWorkspacePaths`.
- **State Management**: Headless controller for managing agent runs, logs, and workspace changes.
- **Resilient Identity**: Secure client and session identity management with environment-aware storage.
- **Exportable Changes**: Export workspace changes as unified diff patches or JSON change sets.

## Installation

```bash
npm install @lemmair/justune-runtime
```

## Basic Usage

```typescript
import { JustuneRuntime } from '@lemmair/justune-runtime';

const runtime = new JustuneRuntime({
  constraints: {
    workspaceRoot: '/workspace',
    timeoutMs: 30000,
    maxStdoutChars: 30000,
    maxReadFileChars: 200000,
    maxWriteFileBytes: 120000,
  },
  defaultWorkspaceFiles: {
    '/workspace/README.md': '# Welcome to Justune\n',
  },
});

// Subscribe to state updates
runtime.subscribe((state) => {
  console.log('Runtime State:', state.runStatus);
});

// Boot the runtime
await runtime.boot();

// Submit a prompt to the agent
await runtime.submitPrompt('List the files in the workspace.');
```

## Architecture

The runtime consists of:
- `JustuneRuntime`: The main controller class.
- `JustuneBrowserSandboxClient`: Bridge to the sandbox worker.
- `JustuneBrowserSandbox.worker`: The background worker running the `just-bash` environment.

## License

Apache-2.0
