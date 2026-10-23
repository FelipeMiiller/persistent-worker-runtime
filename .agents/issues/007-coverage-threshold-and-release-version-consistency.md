# Coverage reports but never fails; the release workflow never checks version/tag/CHANGELOG agreement

**Status**: 🔴 **OPEN** — two "gates" that report without gating.

**Discovered**: 2026-10-23, during a state audit of `develop` (HEAD `1ed718d`).
**Component**: `.github/workflows/coverage.yml`, `.github/workflows/release.yml`, `package.json`

## Gap 1 — coverage has no threshold

`coverage.yml` runs:

```yaml
- name: Run tests with built-in coverage
  run: npm run test:coverage
```

and that is the whole job. `npm run test:coverage` is
`node --test --test-concurrency=4 --experimental-test-coverage test/**/*.test.js` — it prints the
report and exits 0 regardless of how much code is uncovered.

Measured baseline on `develop` (HEAD `1ed718d`, 2026-10-23):

```
all files | 94.39 | 87.71 | 91.01
            line    branch  function
```

Node's built-in runner supports `--experimental-test-coverage-lines=NN`,
`--experimental-test-coverage-branches=NN` and `--experimental-test-coverage-functions=NN`, which
make the process exit non-zero when the floor is breached. Nothing uses them.

**Proposed fix**: add thresholds with headroom below the measured baseline — e.g. lines 90,
branches 80, functions 85 — and tighten them over time. Also worth recording the baseline in the
workflow as a comment so the headroom is visible rather than implicit.

## Gap 2 — the release workflow does not check that the tag, the version and the changelog agree

`release.yml` publishes on `release: published` (and on manual dispatch):

```yaml
- name: Run tests
  run: npm test
- name: Publish to NPM (with provenance)
  run: npm publish --access public --provenance
```

`npm publish` does run `prepublishOnly` (`npm run validate` = lint + test + hot-path), so the code
is checked. But nothing asserts:

- that `package.json`'s `version` equals the git tag being released;
- that `CHANGELOG.md` contains an entry for that version;
- that the version has not already been published to npm.

A tag `v0.4.0` pointing at a commit whose `package.json` still says `0.3.0` would publish `0.3.0`
again (npm would reject the duplicate version, but with a confusing error at publish time rather
than a clear pre-flight failure). A tag `v0.4.1` with no changelog entry ships undocumented
changes.

**Proposed fix**: a pre-flight step in `release.yml`, before `npm publish`:

```bash
# 1. package.json version must match the release tag
VERSION=$(node -p "require('./package.json').version")
if [ "$VERSION" != "${GITHUB_REF_NAME#v}" ]; then
  echo "::error::tag $GITHUB_REF_NAME does not match package.json version $VERSION"; exit 1
fi
# 2. CHANGELOG.md must have a section for that version
grep -q "^## \[$VERSION\]" CHANGELOG.md || { echo "::error::CHANGELOG.md has no entry for $VERSION"; exit 1; }
```

(The current `CHANGELOG.md` already has an `[Unreleased]` section prepared for v0.4.0, so the second
check will fail loudly until that section is renamed at release time — which is the intent.)

## Prevention

- **A metric that is only printed is not a gate.** If a CI job's name promises a property
  ("coverage", "lint"), the job must fail when the property is violated.
- **Publish-time invariants belong before the publish step.** Version/tag/changelog agreement is
  checkable in milliseconds and impossible to check after the package is on npm.
