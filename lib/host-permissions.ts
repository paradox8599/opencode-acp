export type PermissionEffect = "allow" | "ask" | "deny"

/** V2 ordered permission rule (`permissions` in opencode.json). */
export interface PermissionRule {
    action: string
    resource: string
    effect: PermissionEffect
}

export type PermissionRuleset = ReadonlyArray<PermissionRule>

export interface HostPermissionSnapshot {
    global?: PermissionRuleset
    agents: Record<string, PermissionRuleset | undefined>
}

const wildcardMatch = (value: string, pattern: string): boolean => {
    const normalizedValue = value.replaceAll("\\", "/")
    const escaped = pattern
        .replaceAll("\\", "/")
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\*/g, ".*")
        .replace(/\?/g, ".")

    const flags = process.platform === "win32" ? "si" : "s"
    return new RegExp(`^${escaped}$`, flags).test(normalizedValue)
}

const findLastMatchingRule = (
    rules: PermissionRuleset,
    predicate: (rule: PermissionRule) => boolean,
): PermissionRule | undefined => {
    for (let index = rules.length - 1; index >= 0; index -= 1) {
        const rule = rules[index]
        if (rule && predicate(rule)) {
            return rule
        }
    }

    return undefined
}

/**
 * True when the host's rulesets end with a wildcard deny for the `compress`
 * action. Later rulesets shadow earlier ones (session rules are appended after
 * agent rules), and within a ruleset the last matching rule wins — matching
 * OpenCode V2's evaluation order.
 */
export const compressDisabledByOpencode = (
    ...rulesets: Array<PermissionRuleset | undefined>
): boolean => {
    const rules = rulesets.flatMap((ruleset) => (ruleset ? [...ruleset] : []))
    const match = findLastMatchingRule(rules, (rule) => wildcardMatch("compress", rule.action))

    return match?.resource === "*" && match.effect === "deny"
}

export const resolveEffectiveCompressPermission = (
    basePermission: PermissionEffect,
    hostPermissions: HostPermissionSnapshot,
    agentName?: string,
): PermissionEffect => {
    if (basePermission === "deny") {
        return "deny"
    }

    return compressDisabledByOpencode(
        hostPermissions.global,
        agentName ? hostPermissions.agents[agentName] : undefined,
    )
        ? "deny"
        : basePermission
}

/** True when any rule matches the tool action (used to detect explicit host config). */
export const hasExplicitToolPermission = (
    ruleset: PermissionRuleset | undefined,
    tool: string,
): boolean => {
    return ruleset ? ruleset.some((rule) => wildcardMatch(tool, rule.action)) : false
}
