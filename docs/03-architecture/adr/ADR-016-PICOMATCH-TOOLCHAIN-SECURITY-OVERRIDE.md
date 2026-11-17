# ADR-016: Temporary Picomatch toolchain security override

Status: Approved for bounded implementation under delegated controller authority. Exact candidate review and hosted validation are required before adoption.

Date: 2026-11-18

Requirement IDs: NFR-MNT-004, AC-MNT-004, CI-MNT-004

## Context

PR #168's [Foundation run](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/actions/runs/44156325847)
fails its mandatory dependency audit on `picomatch@4.0.7`.
[GHSA-fc5q-39xc-vjpf](https://github.com/advisories/GHSA-fc5q-39xc-vjpf)
identifies a high-severity availability vulnerability. The official registry
still lists 4.0.7 as the latest release. The affected resolution comes through
Vite, Vitest and typescript-eslint, including tinyglobby and fdir.

## Decision

Use a temporary workspace override from `picomatch@4.0.7` to the exact
registry package `@ryotsu/picomatch@4.0.7-a`. The dependency checker must
match the complete affected selector and reviewed replacement name and version,
and register the installed package under its own name and version. This override
is development-only. The normal frozen installation and mandatory audit remain
required.

The MIT fork release points to
[`3ab5a7627d480259e3d9ca67fbc14c125d374f0e`](https://github.com/ryotsu-kankichi/secured-picomatch/commit/3ab5a7627d480259e3d9ca67fbc14c125d374f0e).
Its parent is upstream commit `9fab7bf61913ea334c4203ed321c426cfde44a42`,
19 commits past the official 4.0.7 source. The published archive's ten files
match their pinned Git blobs, and its MIT notice matches the upstream archive.
Npm's verifier accepted both registry signatures and the publication and source
provenance attestations for the registered integrity. The fork's
[test run](https://github.com/ryotsu-kankichi/secured-picomatch/actions/runs/40832731985)
and [publish run](https://github.com/ryotsu-kankichi/secured-picomatch/actions/runs/40833297318)
passed at the pinned source commit.

## Validation and recovery

The isolated lockfile experiment with pnpm 11.19.0 removed the affected lock
resolution and passed the unchanged high-severity audit. Independent design
review approved the development-only replacement after inspecting the exact
fork source. The parser can change captured substrings and treat some complex
repeated wildcard expressions literally, so validate the project's file
discovery and matching through its normal tooling. Pnpm resolves the previous
optional Picomatch peer of fdir as a direct aliased dependency in this graph.
Inspect the packaged runtime inventory to confirm the development boundary.
The candidate needs
independent source review, frozen installation, dependency registration checks,
lint, type checking, build and tests. Run the complete Foundation and
Documentation checks for the exact candidate, including packaged acceptance
and runtime dependency inventory, before merge.

The implementation controller owns this temporary pin. Recheck the upstream
advisory and npm release when reviewing dependency updates. Replace the fork
with an exact upstream release once that release resolves the advisory and
the same validation passes. Revert the override, register and lockfile together
if compatibility fails. The mandatory audit will again report the original
finding until a reviewed replacement passes.
