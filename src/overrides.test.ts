import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { Schema } from "effect"
import { createDefinitionHook, type DefinitionOutput, overrideDescription, parseOptions } from "./overrides.ts"

function collect() {
	const warnings: string[] = []
	return { warnings, warn: (message: string) => warnings.push(message) }
}

/** A struct shaped like the built-in tools' parameters, e.g. `read`'s. */
const ReadParameters = Schema.Struct({
	filePath: Schema.String.annotate({ description: "The absolute path to the file" }),
	offset: Schema.optional(Schema.Number).annotate({ description: "The line number to start from" }),
})

/** The JSON Schema OpenCode would derive from an Effect struct. */
function derived(schema: unknown): Record<string, any> {
	return Schema.toJsonSchemaDocument(schema as Schema.Top).schema as Record<string, any>
}

function builtin(): DefinitionOutput {
	return { description: "Read a file.", parameters: ReadParameters, jsonSchema: undefined }
}

function withJsonSchema(): DefinitionOutput {
	return {
		description: "Run a task.",
		parameters: Schema.Unknown,
		jsonSchema: {
			type: "object",
			properties: {
				prompt: { type: "string", description: "The task" },
				model: { type: "string", description: "The model" },
			},
			required: ["prompt"],
		},
	}
}

async function run(options: unknown, toolID: string, output: DefinitionOutput) {
	const { warnings, warn } = collect()
	await createDefinitionHook(parseOptions(options, warn), warn)({ toolID }, output)
	return warnings
}

describe("parseOptions", () => {
	it("accepts no options", () => {
		const { warnings, warn } = collect()
		assert.equal(parseOptions(undefined, warn).size, 0)
		assert.equal(parseOptions({}, warn).size, 0)
		assert.deepEqual(warnings, [])
	})

	it("takes a string as a replacement description", () => {
		const { warn } = collect()
		assert.deepEqual(parseOptions({ tools: { bash: "Run bash." } }, warn).get("bash"), {
			description: "Run bash.",
			mode: "replace",
			parameters: {},
		})
	})

	it("takes an object with mode and parameters", () => {
		const { warnings, warn } = collect()
		const overrides = parseOptions(
			{ tools: { skill: { description: "More.", mode: "append", parameters: { name: "The skill" } } } },
			warn,
		)
		assert.deepEqual(overrides.get("skill"), {
			description: "More.",
			mode: "append",
			parameters: { name: "The skill" },
		})
		assert.deepEqual(warnings, [])
	})

	it("takes parameters without a description", () => {
		const { warn } = collect()
		assert.deepEqual(parseOptions({ tools: { read: { parameters: { limit: "Lines" } } } }, warn).get("read"), {
			description: undefined,
			mode: "replace",
			parameters: { limit: "Lines" },
		})
	})

	it("skips invalid entries and keeps the others", () => {
		const { warnings, warn } = collect()
		const overrides = parseOptions(
			{
				tools: {
					bash: "Run bash.",
					a: 42,
					b: { description: 1 },
					c: { description: "x", mode: "sideways" },
					d: { parameters: { x: 1 } },
					e: { parameters: [] },
					f: { mode: "append" },
					g: { description: "x", typo: true },
				},
			},
			warn,
		)
		assert.deepEqual([...overrides.keys()], ["bash"])
		assert.equal(warnings.length, 7)
	})

	it("warns about unknown options and a non-object tools", () => {
		const { warnings, warn } = collect()
		assert.equal(parseOptions({ tool: {} }, warn).size, 0)
		assert.equal(parseOptions({ tools: "bash" }, warn).size, 0)
		assert.equal(parseOptions("bash", warn).size, 0)
		assert.equal(warnings.length, 3)
	})
})

describe("overrideDescription", () => {
	it("replaces, appends and prepends", () => {
		assert.equal(overrideDescription("Old.", { description: "New.", mode: "replace", parameters: {} }), "New.")
		assert.equal(overrideDescription("Old.", { description: "New.", mode: "append", parameters: {} }), "Old.\n\nNew.")
		assert.equal(overrideDescription("Old.", { description: "New.", mode: "prepend", parameters: {} }), "New.\n\nOld.")
	})

	it("adds no separator to an empty description", () => {
		assert.equal(overrideDescription("", { description: "New.", mode: "append", parameters: {} }), "New.")
	})

	it("keeps the description without one in the override", () => {
		assert.equal(overrideDescription("Old.", { mode: "replace", parameters: { x: "y" } }), "Old.")
	})
})

describe("tool.definition hook", () => {
	it("leaves tools without an override alone", async () => {
		const output = builtin()
		await run({ tools: { bash: "Run bash." } }, "read", output)
		assert.equal(output.description, "Read a file.")
		assert.equal(output.parameters, ReadParameters)
	})

	it("replaces a description", async () => {
		const output = builtin()
		await run({ tools: { read: "Read." } }, "read", output)
		assert.equal(output.description, "Read.")
		assert.equal(output.parameters, ReadParameters)
	})

	it("overrides Effect struct field descriptions, required and optional", async () => {
		const output = builtin()
		const warnings = await run(
			{ tools: { read: { parameters: { filePath: "Path", offset: "First line" } } } },
			"read",
			output,
		)
		assert.deepEqual(warnings, [])
		assert.notEqual(output.parameters, ReadParameters)
		const schema = derived(output.parameters)
		assert.equal(schema.properties.filePath.description, "Path")
		assert.equal(schema.properties.offset.description, "First line")
		assert.deepEqual(schema.required, ["filePath"])
		// The original is untouched.
		assert.equal(derived(ReadParameters).properties.filePath.description, "The absolute path to the file")
	})

	it("still validates the same input after rewriting a struct", async () => {
		const output = builtin()
		await run({ tools: { read: { parameters: { offset: "First line" } } } }, "read", output)
		const decode = Schema.decodeUnknownSync(output.parameters as typeof ReadParameters)
		assert.deepEqual(decode({ filePath: "/x", offset: 3 }), { filePath: "/x", offset: 3 })
		assert.throws(() => decode({ offset: 3 }))
	})

	it("reuses the rewritten struct across calls", async () => {
		const { warn } = collect()
		const hook = createDefinitionHook(parseOptions({ tools: { read: { parameters: { offset: "x" } } } }, warn), warn)
		const first = builtin()
		const second = builtin()
		await hook({ toolID: "read" }, first)
		await hook({ toolID: "read" }, second)
		assert.equal(first.parameters, second.parameters)
	})

	it("overrides JSON Schema property descriptions on a clone", async () => {
		const output = withJsonSchema()
		const original = output.jsonSchema
		const warnings = await run({ tools: { task: { parameters: { prompt: "What to do" } } } }, "task", output)
		assert.deepEqual(warnings, [])
		assert.notEqual(output.jsonSchema, original)
		assert.equal((output.jsonSchema as any).properties.prompt.description, "What to do")
		assert.equal((output.jsonSchema as any).properties.model.description, "The model")
		assert.equal((original as any).properties.prompt.description, "The task")
	})

	it("warns once about an unknown parameter and applies the rest", async () => {
		const { warnings, warn } = collect()
		const hook = createDefinitionHook(
			parseOptions({ tools: { read: { parameters: { nope: "x", offset: "First line" } } } }, warn),
			warn,
		)
		const output = builtin()
		await hook({ toolID: "read" }, output)
		await hook({ toolID: "read" }, builtin())
		assert.equal(warnings.length, 1)
		assert.match(warnings[0], /no parameter "nope"/)
		assert.equal(derived(output.parameters).properties.offset.description, "First line")

		const json = withJsonSchema()
		await run({ tools: { task: { parameters: { nope: "x" } } } }, "task", json)
		assert.equal((json.jsonSchema as any).properties.nope, undefined)
	})

	it("warns when the parameters can't be edited, and still sets the description", async () => {
		const output: DefinitionOutput = { description: "Old.", parameters: Schema.Unknown }
		const warnings = await run({ tools: { odd: { description: "New.", parameters: { x: "y" } } } }, "odd", output)
		assert.equal(output.description, "New.")
		assert.equal(output.parameters, Schema.Unknown)
		assert.equal(warnings.length, 1)
	})
})
