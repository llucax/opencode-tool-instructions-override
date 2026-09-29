import type { Plugin } from "@opencode-ai/plugin"
import { createDefinitionHook, parseOptions } from "./overrides.ts"

/**
 * Override the instructions of any tool, from the plugin's options.
 *
 * It must export only its plugin factory: OpenCode's loader treats every
 * export as one and throws on the first that is not a function. The logic
 * lives in `overrides.ts`.
 */
export default (async ({ client }, options) => {
	const warn = (message: string) => {
		void client.app
			.log({ body: { service: "tool-instructions-override", level: "warn", message } })
			.catch(() => {})
	}
	return { "tool.definition": createDefinitionHook(parseOptions(options, warn), warn) }
}) satisfies Plugin
