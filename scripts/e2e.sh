#!/usr/bin/env bash
# End-to-end check of the overrides against a real OpenCode.
#
# Runs `opencode run` with only src/plugin.ts installed, talking to
# openai-fake-provider (https://github.com/llucax/openai-fake-provider), which
# saves every request it gets; the checks read the tool definitions from the
# saved request. No request reaches a real model. Everything OpenCode stores
# goes to a temporary directory, removed at the end unless KEEP=1.
#
# Needs: opencode, jq, python3, and the fake provider, either as an
# `openai-fake-provider` command or through OPENAI_FAKE_PROVIDER, the path to
# its openai_fake_provider.py.

set -euo pipefail

repo=$(cd "$(dirname "$0")/.." && pwd)
tmp=$(mktemp -d "${TMPDIR:-/tmp}/tool-instructions-e2e.XXXXXX")
pids=()
cleanup() {
	for pid in "${pids[@]}"; do kill "$pid" 2>/dev/null || true; done
	wait 2>/dev/null || true
	if [[ ${KEEP:-} == 1 ]]; then echo "kept $tmp"; else rm -rf "$tmp"; fi
}
trap cleanup EXIT

if [[ -n ${OPENAI_FAKE_PROVIDER:-} ]]; then
	fake=(python3 "$OPENAI_FAKE_PROVIDER")
elif command -v openai-fake-provider >/dev/null; then
	fake=(openai-fake-provider)
else
	echo "e2e: openai-fake-provider not found; set OPENAI_FAKE_PROVIDER" >&2
	exit 2
fi

fake_port=$(python3 -c 'import socket; s = socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1])')

failures=0
check() { # description, then a jq filter that must be true on the saved request
	local what=$1
	if jq -e "$2" "$request" >/dev/null; then
		echo "ok   $what"
	else
		echo "FAIL $what"
		failures=$((failures + 1))
	fi
}

# A config directory with this plugin as its only plugin. The write override
# comes from a file through OpenCode's own {file:...} substitution, which
# resolves relative paths against the config file.
mkdir -p "$tmp/config/tool-instructions" "$tmp/work" "$tmp/dump" "$tmp/xdg"/{config,data,state,cache}
printf 'Write a file.\nFrom a file.\n' >"$tmp/config/tool-instructions/write.md"
jq -n --arg plugin "$repo/src/plugin.ts" '{
	"$schema": "https://opencode.ai/config.json",
	plugin: [[$plugin, {
		tools: {
			bash: "Run a shell command.",
			write: "{file:tool-instructions/write.md}",
			skill: {description: "APPENDED", mode: "append"},
			glob: {description: "PREPENDED", mode: "prepend"},
			read: {parameters: {filePath: "READ PATH", offset: "READ OFFSET", nope: "x"}},
			task: {parameters: {prompt: "TASK PROMPT"}},
			typo: 42
		}
	}]]
}' >"$tmp/config/opencode.json"

"${fake[@]}" serve --port "$fake_port" --dump-dir "$tmp/dump" 2>"$tmp/fake.log" &
pids+=($!)
for _ in $(seq 150); do
	python3 -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:$fake_port/v1/models')" 2>/dev/null && break
	sleep 0.2
done

(
	# The fake provider's config makes fake/* the only usable models.
	export OPENCODE_CONFIG_CONTENT
	OPENCODE_CONFIG_CONTENT=$("${fake[@]}" opencode-config --port "$fake_port")
	export OPENCODE_CONFIG_DIR=$tmp/config
	export XDG_CONFIG_HOME=$tmp/xdg/config XDG_DATA_HOME=$tmp/xdg/data
	export XDG_STATE_HOME=$tmp/xdg/state XDG_CACHE_HOME=$tmp/xdg/cache
	export OPENCODE_DISABLE_CLAUDE_CODE=1
	unset OPENCODE_CONFIG OPENCODE OPENCODE_PID
	# Not a git repository: in one OpenCode was seen hanging before the
	# first model request.
	cd "$tmp/work"
	exec opencode run --print-logs --agent build -m fake/ok hello
) >"$tmp/opencode.log" 2>&1 || {
	echo "e2e: opencode run failed, see $tmp/opencode.log" >&2
	KEEP=1
	exit 1
}

request=$(ls "$tmp"/dump/*-prompt.json | head -1)
tool() { echo ".tools[] | select(.function.name == \"$1\") | .function"; }

check "bash: description replaced" "$(tool bash) | .description == \"Run a shell command.\""
check "write: description read from a file" "$(tool write) | .description == \"Write a file.\\nFrom a file.\""
check "skill: description appended" "$(tool skill) | .description | endswith(\"\\n\\nAPPENDED\") and length > 20"
check "glob: description prepended" "$(tool glob) | .description | startswith(\"PREPENDED\\n\\n\") and length > 20"
check "read: parameter descriptions replaced" \
	"$(tool read) | .parameters.properties | .filePath.description == \"READ PATH\" and .offset.description == \"READ OFFSET\""
check "read: required parameters unchanged" "$(tool read) | .parameters.required == [\"filePath\"]"
check "read: description unchanged" "$(tool read) | .description | length > 100"
check "task: JSON Schema parameter replaced" "$(tool task) | .parameters.properties.prompt.description == \"TASK PROMPT\""
check "task: subagent list still appended" "$(tool task) | .description | contains(\"Available agent types\")"
check "edit: untouched" "$(tool edit) | .description | length > 100"

for warning in 'tools.typo must be a string or an object' 'tool read has no parameter \\"nope\\"'; do
	if grep -q "$warning" "$tmp/opencode.log"; then
		echo "ok   warning logged: $warning"
	else
		echo "FAIL warning logged: $warning"
		failures=$((failures + 1))
	fi
done

if ((failures)); then
	echo "$failures check(s) failed; rerun with KEEP=1 to inspect $tmp" >&2
	exit 1
fi
echo "all checks passed"
