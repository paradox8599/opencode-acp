import { createRequire } from "node:module"

/**
 * Package version, read from package.json at runtime.
 *
 * The source-direct build has no bundler `define` step, so the version is
 * resolved here instead of being injected at build time.
 */
export const ACP_VERSION: string = (() => {
    try {
        const require = createRequire(import.meta.url)
        const pkg = require("../package.json") as { version?: unknown }
        return typeof pkg.version === "string" && pkg.version.length > 0 ? pkg.version : "dev"
    } catch {
        return "dev"
    }
})()
