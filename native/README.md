# Native extension boundary

`contract-v1.json` is the only declared native operation contract. Every operation carries an explicit `.v1` suffix. `integrity-pins-v1.json` pins that contract by SHA-256.

There is currently no native executable in this repository, so the pin status is `contract_only` and `verifyNativeArtifact` will not mark it executable. A future native binary must have its own exact SHA-256 entry with status `enabled`, pass the v1 operation allowlist, and declare the exact dependent Premiere plugin before dispatch. Plugin discovery does not grant invocation authority.

Native mutation outcomes reported as accepted or unknown must enter reconciliation and must not be automatically retried.
