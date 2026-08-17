# Fixture Commerce Workspace

A deliberately small but realistic TypeScript workspace used by Ottili Coder's
acceptance tests. `@fixture/api` depends on `@fixture/checkout`, which depends
on `@fixture/money`; lower-level packages must never import an app package.

`packages/money/src/discount.ts` contains an intentional bug. A mission should
find it through the checkout test and repair percentage handling. `UNTRACKED.md`
is deliberately left untracked when the fixture is initialized as a Git repo.
