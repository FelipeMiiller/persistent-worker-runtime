---
title: "Always Test Before Commit"
category: rule
summary: "Mandatory rule requiring all unit tests and benchmarks to pass before committing code."
---

# Always Test Before Commit

AI Agents and human contributors must **ALWAYS** execute the automated test suite before committing any code or submitting pull requests.

## Requirements

1. **Unit Test Approval:**
   ```bash
   npm test
   ```
   All tests must pass with 0 failures.

2. **Code Coverage:**
   ```bash
   npm run test:coverage
   ```
   Line coverage must remain above 80% across all core modules.

3. **Performance Verification:**
   ```bash
   npm run benchmark:all
   ```
   No performance regression or Event Loop blocking is permitted.

No commit or pull request shall be approved without 100% test success.
