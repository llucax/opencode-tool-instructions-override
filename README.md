# opencode-tool-instructions-override

An [OpenCode](https://opencode.ai) plugin that overrides the instructions any tool sends to the model: its description and the descriptions of its parameters, set from config instead of code.

Built-in tool descriptions are long and opinionated. `bash` alone is about 4,600 characters, much of it rules about git commits and pull requests that may not match how you work, and it's sent with every request. With this plugin you replace it with the one sentence you want, or add a note to a tool without touching the rest.

Checked against OpenCode 1.18.32.

## Install

The plugin needs no build step and no `npm install`: OpenCode loads `src/plugin.ts` straight from a clone.

```sh
git clone https://github.com/llucax/opencode-tool-instructions-override ~/opencode-plugins/tool-instructions-override
```

Then add it to the `plugin` array of your `opencode.json` or `opencode.jsonc`, with the overrides as its options. Relative paths are resolved against the config file that declares them:

```jsonc
{
  "plugin": [
    [
      "../../opencode-plugins/tool-instructions-override/src/plugin.ts",
      {
        "tools": {
          "bash": "Execute shell commands using bash in the project environment."
        }
      }
    ]
  ]
}
```

It has to be an array entry: a plugin symlinked into `plugins/` gets no options. Restart OpenCode after changing the config.

## Options

`tools` maps a tool ID to its override. A string replaces the tool's description. An object takes these keys, all optional:

| Key           | Value                                                                           |
| ------------- | ------------------------------------------------------------------------------- |
| `description` | the new description                                                             |
| `mode`        | `replace` (default), `append` or `prepend`: how it combines with the tool's own |
| `parameters`  | parameter name to its new description; always replaces                         |

`append` and `prepend` join the two texts with a blank line and need a `description`. Parameters you don't list keep their descriptions, and so do their types and whether they're required: only the text changes.

```jsonc
"tools": {
  "bash": "Execute shell commands using bash in the project environment.",
  "skill": { "mode": "append", "description": "Load a skill before starting the task it covers." },
  "read": { "parameters": { "filePath": "Absolute path of the file or directory" } }
}
```

### Longer texts in their own files

OpenCode substitutes `{file:path}` in any config string with that file's content, trimmed, resolving relative paths against the config file. That works in these options too, so a long description can live in a Markdown file next to your config:

```jsonc
"tools": {
  "todowrite": "{file:tool-instructions/todowrite.md}",
  "read": { "parameters": { "filePath": "{file:tool-instructions/read-filePath.md}" } }
}
```

### Mistakes

A malformed override is skipped and the others still apply, and so is a parameter the tool doesn't have. Both are logged as warnings under the `tool-instructions-override` service in OpenCode's log (`opencode run --print-logs`, or the log files under `~/.local/share/opencode/log/`). An override for a tool that doesn't exist does nothing: the tools on offer depend on the agent and the model (`edit` and `write` become `apply_patch` on GPT models, for example), so it can't tell a typo from a tool that is merely absent.

## What it can and can't reach

It uses OpenCode's `tool.definition` hook, so it covers every tool that goes through it: the built-in ones and those added by plugins or custom tool files.

- MCP tools don't go through the hook, and neither do the MCP resource tools (`list_mcp_resources` and friends), so they can't be overridden.
- `task` gets its list of subagents appended after the hook, so the list survives any override.
- `skill` builds its list of skills into its own description, so `replace` drops that list; use `append` or `prepend` there.
- Hooks run in plugin load order, and other plugins can change the same tools. A `replace` wipes whatever an earlier plugin added to that description, and a later plugin can change the text again. For example, a plugin adding a note to `task` should load after this one if `task` is replaced.

Built-in tools describe their parameters with Effect schemas rather than JSON Schema. The plugin rewrites their field annotations through the schema's own methods, so it doesn't depend on OpenCode's `effect` version, but it does rely on those schemas being structs. When a tool's parameters are neither a struct nor JSON Schema, the plugin logs a warning and overrides only the description.

## Development

`package.json` is private and exists only for the development tools:

```sh
npm ci
npm run check        # typecheck and unit tests
scripts/e2e.sh       # against a real OpenCode, see below
```

`scripts/e2e.sh` runs `opencode run` with this plugin and a set of overrides, against [openai-fake-provider](https://github.com/llucax/openai-fake-provider), which saves each request, and checks the tool definitions the model would have received. It needs `opencode`, `jq`, `python3` and the fake provider, either on `PATH` as `openai-fake-provider` or through `OPENAI_FAKE_PROVIDER=path/to/openai_fake_provider.py`. CI runs it on the OpenCode version pinned in `.github/e2e/Dockerfile`, and weekly on OpenCode's latest release too.

## License

[MIT](LICENSE)
