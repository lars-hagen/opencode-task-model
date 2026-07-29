import path from "node:path"
import os from "node:os"
import { pathToFileURL } from "node:url"

const mode = process.argv[2]
if (mode !== "local" && mode !== "npm") {
  throw new Error("Usage: bun scripts/opencode-config.js <local|npm>")
}

const root = path.resolve(import.meta.dir, "..")
const localDirectory = root
const legacyLocal = pathToFileURL(root).href
const localEntry = pathToFileURL(path.join(root, "src", "index.ts")).href
const base = process.env.OPENCODE_CONFIG_DIR
  ?? path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config"), "opencode")
const file = path.join(base, "opencode.json")
const text = await Bun.file(file).text()

let target = `${localEntry}?v=${Date.now()}`
if (mode === "npm") {
  const view = Bun.spawnSync(["bun", "pm", "view", "opencode-task-model", "version"])
  if (!view.success) throw new Error(view.stderr.toString().trim() || "Failed to resolve npm version")
  const version = view.stdout.toString().trim()
  if (!version) throw new Error("npm returned an empty version")
  target = `opencode-task-model@${version}`
}

const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
const escapedLocal = escapeRegex(JSON.stringify(localDirectory))
const escapedLegacyLocal = escapeRegex(JSON.stringify(legacyLocal))
const escapedLocalEntry = escapeRegex(JSON.stringify(localEntry).slice(0, -1))
const matches = [
  ...text.matchAll(/"opencode-task-model(?:@[^"]*)?"/g),
  ...text.matchAll(new RegExp(escapedLocal, "g")),
  ...text.matchAll(new RegExp(escapedLegacyLocal, "g")),
  ...text.matchAll(new RegExp(`${escapedLocalEntry}(?:[?#][^\"]*)?"`, "g")),
].sort((a, b) => (a.index ?? 0) - (b.index ?? 0))

if (matches.length !== 1) {
  throw new Error(`Expected exactly one opencode-task-model entry in ${file}; found ${matches.length}`)
}

const hit = matches[0]
const start = hit.index
const output = text.slice(0, start) + JSON.stringify(target) + text.slice(start + hit[0].length)
await Bun.write(file, output)

console.log(`Updated ${file}`)
console.log(`  ${target}`)
console.log("Restart OpenCode to load it.")
