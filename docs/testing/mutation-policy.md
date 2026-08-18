# Mutation testing policy

This policy governs `TST-037`. The initial mutation gate is `minimumScore` (90%
in the checked-in policy), and the target/high band is `targetScore` (95%). The
audit reads the gate from the policy rather than embedding a score in code. The
report must use the following formula:

```text
(Killed + Timeout) / (Killed + Timeout + Survived + NoCoverage)
```

`CompileError`, `RuntimeError`, and other non-scoreable statuses are excluded
from both sides of the formula. A timeout is scoreable and is counted as killed,
but it still requires an explicit review because it can hide an execution-time
problem.

Every `Survived` and `Timeout` mutant must be covered by exactly one entry in
`mutation-policy.json`. A review can select one mutant with `selector.mutantId`,
or select a deterministic rule with `selector.rule`. Rules must constrain the
file, status, mutator name, and replacement; line and column can further narrow
the match. Every rule pins both `expectedMatches` and the complete sorted set of
`expectedLocations`, so a new or moved surviving mutant cannot inherit an old
review silently. Reviews require an owner, an ISO-8601
`reviewedAt`, a rationale, and one of these dispositions: `fix-required`,
`accepted-risk`, `equivalent-mutant`, or `test-gap`.

The governed scope includes every executable TypeScript module under
`server/domain` and `server/integrations`. The three `*-provider.ts` exclusions
are reviewed interface-only contracts. The audit parses those files as
TypeScript and fails if runtime logic is added, if the Stryker patterns drift,
if the TypeScript checker or JSON report is disabled, or if incremental results
are enabled. This prevents difficult runtime logic from being hidden behind a
nominal type-only exclusion.

The fresh full run reviewed on 2026-08-18 produced 1,565 killed, 156 survived,
8 timeout, 0 uncovered and 514 compile-error mutants: 90.98% under the governed
formula. The policy records all 164 reviewable results in 110 deterministic
groups. Survivors remain explicit test debt toward 95%; timeout mutations are
reviewed separately because they deliberately prevent progress in the bounded
business-day loop. Neither category is removed from the score or mutation
scope.

Run the audit with:

```bash
tsx scripts/audit-mutation-evidence.ts
```
