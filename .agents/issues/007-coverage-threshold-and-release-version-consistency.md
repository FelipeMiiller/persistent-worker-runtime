# Coverage reports but never fails; the release workflow never checks version/tag/CHANGELOG agreement

**Status**: ✅ **FIXED** 2026-10-23 — coverage now has floors that make the job **fail** when they
are breached, and `release.yml` has a pre-flight step that refuses to publish when the tag, the
manifest version and the changelog disagree.

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

Node's built-in runner supports `--test-coverage-lines=NN`,
`--test-coverage-branches=NN` and `--test-coverage-functions=NN` (note: **no** `--experimental-`
prefix — verified present on Node 22.13.0, the `engines` floor, as well as 24.x and 26.x), which
make the process exit non-zero when the floor is breached. Nothing used them.

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

---

## Verification (2026-10-23, `develop` @ `6e5f22d`)

### Gap 1 closed — coverage has a threshold

`package.json` → `scripts.test:coverage` now passes three floors:

```
node --test --test-concurrency=4 --experimental-test-coverage \
  --test-coverage-lines=90 --test-coverage-branches=80 --test-coverage-functions=85 \
  test/**/*.test.js
```

The floors sit **below** the measured baseline on purpose — a floor equal to the baseline is a
trap: the next pull request that adds one uncovered line turns the build red for a reason that has
nothing to do with the quality of that change.

`.github/workflows/coverage.yml` records the baseline and the floors in a comment next to the step,
so the headroom is visible instead of implicit.

**Measured** (Node v24.16.0, `develop`):

| | line | branch | function |
| --- | --- | --- | --- |
| Baseline recorded in this issue | 94.39 % | 87.71 % | 91.01 % |
| Measured at the time of the fix | **94.51 %** | **88.19 %** | **91.35 %** |
| Enforced floor | 90 % | 80 % | 85 % |

**Proof that the gate fails** — the same run with an absurd floor of `100`:

```
node --test --test-concurrency=4 --experimental-test-coverage --test-coverage-lines=100 test/**/*.test.js
→ Error: 94.36% line coverage does not meet threshold of 100%.
→ exit code 1
```

(`94.36 %` in one run, `94.34 %` in the next — the report wobbles by a few tenths between runs
because some runtime paths are timing-dependent. The floor of 90 % has ~4 points of headroom over
the worst observation, so the wobble cannot flip the gate. Full log kept in the agent's scratch
folder.)

With the real floors restored, `npm run test:coverage` → **exit 0**, 641 pass / 0 fail.

### Gap 2 closed — the release workflow checks version/tag/CHANGELOG

`.github/workflows/release.yml` gained a `Pre-flight — version, tag and changelog agreement` step
between `Run tests` and `Publish to NPM (with provenance)`. It runs on `ubuntu-latest` with
`shell: bash` and fails loudly with a GitHub `::error::` annotation:

1. **tag ↔ manifest** — on a `release` event `GITHUB_REF` is `refs/tags/vX.Y.Z`; the leading `v` is
   stripped and compared with `package.json`'s `version`;
2. **changelog** — `CHANGELOG.md` must contain a `## [X.Y.Z]` heading for that exact version (the
   dots are escaped so `1.2.3` cannot match `1x2y3`);
3. **registry** — on `workflow_dispatch` there is no tag, so the tag check is skipped and the step
   instead verifies that the version is **not already published** (`npm view <pkg>@<version>`).

**Proof** — the `run:` block was extracted from `release.yml` and executed against fixtures (5
scenarios, all as expected; `bash -n` syntax check OK):

| Scenario | `GITHUB_REF` | version | expected | observed |
| --- | --- | --- | --- | --- |
| tag matches | `refs/tags/v0.3.0` | 0.3.0 | exit 0 | exit 0 — `Pre-flight OK — publishing 'persistent-worker-runtime@0.3.0'.` |
| tag mismatch | `refs/tags/v0.4.0` | 0.3.0 | exit 1 | exit 1 — `::error::release tag 'refs/tags/v0.4.0' (version '0.4.0') does not match package.json version '0.3.0'` |
| changelog section missing | `refs/tags/v0.3.0` | 0.3.0 | exit 1 | exit 1 — `::error::CHANGELOG.md has no '## [0.3.0]' section for version '0.3.0'` |
| `workflow_dispatch`, not published | `refs/heads/develop` | 9.9.9 | exit 0 | exit 0 — `Pre-flight OK — publishing 'persistent-worker-runtime@9.9.9'.` |
| `workflow_dispatch`, already published | `refs/heads/develop` | 0.3.0 | exit 1 | exit 1 — `::error::version '0.3.0' of 'persistent-worker-runtime' is already published on npm` |

Both workflow files were re-parsed with a YAML parser after the change (`.github/workflows/release.yml`
and `.github/workflows/coverage.yml` → parsed OK; the `run:` block round-trips as a 39-line string).

### Known limitation

The registry check needs network access to `registry.npmjs.org`. It only runs on the
`workflow_dispatch` path, and a registry outage makes that path fail closed (the release is
stopped) rather than open — the safe direction for a publish step.

