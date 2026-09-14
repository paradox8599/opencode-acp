import assert from "node:assert/strict"
import test from "node:test"
import {
    compressDisabledByOpencode,
    hasExplicitToolPermission,
    resolveEffectiveCompressPermission,
    type PermissionRuleset,
} from "../lib/host-permissions"

const rule = (action: string, resource: string, effect: "allow" | "ask" | "deny") => ({
    action,
    resource,
    effect,
})

test("wildcard deny rule disables compress", () => {
    assert.equal(compressDisabledByOpencode([rule("*", "*", "deny")]), true)
})

test("later explicit compress allow overrides wildcard deny", () => {
    assert.equal(
        compressDisabledByOpencode([
            rule("*", "*", "deny"),
            rule("compress", "*", "allow"),
        ]),
        false,
    )
})

test("agent wildcard deny disables compress even when global config allows it", () => {
    assert.equal(
        resolveEffectiveCompressPermission(
            "allow",
            {
                global: [rule("question", "*", "allow")],
                agents: {
                    fast: [rule("*", "*", "deny"), rule("question", "*", "allow")],
                },
            },
            "fast",
        ),
        "deny",
    )
})

test("agent explicit allow overrides global wildcard deny", () => {
    assert.equal(
        resolveEffectiveCompressPermission(
            "allow",
            {
                global: [rule("*", "*", "deny")],
                agents: {
                    build: [rule("compress", "*", "allow")],
                },
            },
            "build",
        ),
        "allow",
    )
})

test("permission action wildcards follow opencode-style matching", () => {
    assert.equal(compressDisabledByOpencode([rule("c?mpress", "*", "deny")]), true)
})

test("resource-specific denies do not disable the whole tool", () => {
    assert.equal(compressDisabledByOpencode([rule("compress", "/tmp/*", "deny")]), false)
})

test("last matching rule wins within one ruleset", () => {
    const ruleset: PermissionRuleset = [
        rule("compress", "*", "deny"),
        rule("compress", "*", "allow"),
    ]
    assert.equal(compressDisabledByOpencode(ruleset), false)
})

test("explicit compress permission is detected", () => {
    assert.equal(hasExplicitToolPermission([rule("compress", "*", "ask")], "compress"), true)
    assert.equal(hasExplicitToolPermission([rule("*", "*", "deny")], "compress"), true)
    assert.equal(hasExplicitToolPermission([rule("edit", "*", "ask")], "compress"), false)
    assert.equal(hasExplicitToolPermission(undefined, "compress"), false)
})
