/**
 * Tool instruction overrides: option parsing and the `tool.definition` hook.
 *
 * Kept apart from `plugin.ts`, whose only export must be the plugin factory,
 * so the tests can import everything here.
 */

/** How an override's description combines with the tool's own. */
export type Mode = "replace" | "append" | "prepend"

export const MODES: readonly Mode[] = ["replace", "append", "prepend"]

/** One tool's override, after parsing. */
export interface ToolOverride {
	description?: string
	mode: Mode
	parameters: Record<string, string>
}

/** What the `tool.definition` hook may change. */
export interface DefinitionOutput {
	description: string
	parameters: unknown
	jsonSchema?: unknown
	[key: string]: unknown
}

type Warn = (message: string) => void

/** Separates the tool's own description from an appended or prepended one. */
export const SEPARATOR = "\n\n"

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}

/**
 * Parse the plugin options into one override per tool ID.
 *
 * Invalid entries are reported through `warn` and skipped, rather than
 * thrown: a typo in one tool's override shouldn't lose every other one.
 */
export function parseOptions(options: unknown, warn: Warn): Map<string, ToolOverride> {
	const overrides = new Map<string, ToolOverride>()
	if (options === undefined) return overrides
	if (!isRecord(options)) {
		warn("options must be an object; ignoring them")
		return overrides
	}
	for (const key of Object.keys(options)) {
		if (key !== "tools") warn(`unknown option "${key}"; ignoring it`)
	}
	const tools = options.tools
	if (tools === undefined) return overrides
	if (!isRecord(tools)) {
		warn('"tools" must be an object mapping tool IDs to overrides; ignoring it')
		return overrides
	}
	for (const [toolID, value] of Object.entries(tools)) {
		const override = parseOverride(toolID, value, warn)
		if (override) overrides.set(toolID, override)
	}
	return overrides
}

function parseOverride(toolID: string, value: unknown, warn: Warn): ToolOverride | undefined {
	if (typeof value === "string") return { description: value, mode: "replace", parameters: {} }
	if (!isRecord(value)) {
		warn(`tools.${toolID} must be a string or an object; ignoring it`)
		return undefined
	}
	let valid = true
	const invalid = (message: string) => {
		warn(`tools.${toolID}: ${message}; ignoring this override`)
		valid = false
	}

	for (const key of Object.keys(value)) {
		if (!["description", "mode", "parameters"].includes(key)) invalid(`unknown key "${key}"`)
	}
	const { description, mode = "replace", parameters = {} } = value
	if (description !== undefined && typeof description !== "string") invalid("description must be a string")
	if (!MODES.includes(mode as Mode)) invalid(`mode must be one of ${MODES.join(", ")}`)
	if (!isRecord(parameters)) invalid("parameters must be an object mapping parameter names to descriptions")
	else {
		for (const [name, text] of Object.entries(parameters)) {
			if (typeof text !== "string") invalid(`parameters.${name} must be a string`)
		}
	}
	if (mode !== "replace" && description === undefined) invalid(`mode "${mode}" needs a description`)
	if (!valid) return undefined
	return {
		description: description as string | undefined,
		mode: mode as Mode,
		parameters: parameters as Record<string, string>,
	}
}

/** Combine the tool's own description with an override's. */
export function overrideDescription(current: string, override: ToolOverride): string {
	if (override.description === undefined) return current
	switch (override.mode) {
		case "replace":
			return override.description
		case "append":
			return current ? `${current}${SEPARATOR}${override.description}` : override.description
		case "prepend":
			return current ? `${override.description}${SEPARATOR}${current}` : override.description
	}
}

/**
 * The subset of an Effect `Schema.Struct` this plugin uses.
 *
 * Built-in tools describe their parameters with Effect schemas and carry no
 * JSON Schema; OpenCode derives one from the struct, taking each field's
 * `description` annotation. Relying on the struct's own methods, instead of
 * importing `effect`, keeps the plugin free of a dependency that would have
 * to match OpenCode's exact version.
 */
interface EffectStruct {
	fields: Record<string, { annotate(annotations: { description: string }): unknown }>
	mapFields(f: (fields: Record<string, unknown>) => Record<string, unknown>): unknown
}

function isEffectStruct(value: unknown): value is EffectStruct {
	if (value === null || (typeof value !== "object" && typeof value !== "function")) return false
	const { fields, mapFields } = value as { fields?: unknown; mapFields?: unknown }
	return isRecord(fields) && typeof mapFields === "function"
}

/**
 * Create the `tool.definition` hook for the given overrides.
 *
 * Parameter overrides go into the JSON Schema when the tool has one (plugin
 * tools, `task`), since OpenCode sends that instead of deriving one from the
 * Effect schema; otherwise into the Effect struct's field annotations. Either
 * way the original is never edited in place: the hook receives the registry's
 * own objects, and editing them would change the stored definition.
 */
export function createDefinitionHook(overrides: Map<string, ToolOverride>, warn: Warn) {
	// Rewritten Effect structs, per original struct, so OpenCode's own cache
	// of derived JSON Schemas (a WeakMap keyed by the struct) keeps hitting.
	const structs = new WeakMap<object, unknown>()
	const warned = new Set<string>()
	const warnOnce = (key: string, message: string) => {
		if (warned.has(key)) return
		warned.add(key)
		warn(message)
	}

	return async (input: { toolID: string }, output: DefinitionOutput) => {
		const override = overrides.get(input.toolID)
		if (!override) return
		output.description = overrideDescription(output.description, override)

		const names = Object.keys(override.parameters)
		if (!names.length) return

		const schema = output.jsonSchema
		if (isRecord(schema) && isRecord(schema.properties)) {
			const properties = schema.properties
			const cloned = structuredClone(schema) as Record<string, unknown> & {
				properties: Record<string, Record<string, unknown>>
			}
			for (const name of names) {
				if (!isRecord(properties[name])) {
					warnOnce(`${input.toolID}.${name}`, `tool ${input.toolID} has no parameter "${name}"; not overriding it`)
					continue
				}
				cloned.properties[name].description = override.parameters[name]
			}
			output.jsonSchema = cloned
			return
		}

		const struct = output.parameters
		if (!isEffectStruct(struct)) {
			warnOnce(input.toolID, `tool ${input.toolID} has parameters this plugin can't edit; overriding only its description`)
			return
		}
		const cached = structs.get(struct)
		if (cached) {
			output.parameters = cached
			return
		}
		for (const name of names) {
			if (!(name in struct.fields)) {
				warnOnce(`${input.toolID}.${name}`, `tool ${input.toolID} has no parameter "${name}"; not overriding it`)
			}
		}
		const rewritten = struct.mapFields((fields) => {
			const next = { ...fields }
			for (const name of names) {
				const field = struct.fields[name]
				if (field) next[name] = field.annotate({ description: override.parameters[name] })
			}
			return next
		})
		structs.set(struct, rewritten)
		output.parameters = rewritten
	}
}
