# Audience Builder Implementation Plan

> **For agentic workers:** Use the existing bounded core, UI and review agents; each owns separate files. User has authorized execution. The workspace has no Git repository, so verification is recorded in docs rather than commits.

**Goal:** Deliver the two-tab audience module, typed attribute catalog, nested AND/OR editor and sound conflict checks.

**Architecture:** Preserve legacy AND rules while adding one authoritative expression tree. Core functions own type checks, three-valued evaluation, bounded intersection proofs and immutable persistence. Shared editor supports both central management and inline creation; root owns catalog and reference views.

**Tech Stack:** Existing React, TypeScript, Vite, node:test; no additional dependencies.

**Spec:** ../specs/2026-09-12-audience-builder-design.md

## Global Constraints

- Fixed user_id eligibility snapshot, unchanged hashes, old immutable audience definitions and application-private tags.
- 30 leaves, group depth 3; bounded DNF 64 terms, unknown proof conservatively blocks bucket reuse.
- Attribute definitions are immutable after registration; new custom sources must reference an existing application.
- Browser mutations use 127.0.0.1:5173; localhost user data receives no test entities.

## Task 1: Core and regression tests

Files: src/profile-attributes.ts, src/audiences.ts, src/traffic.ts, tests/profile-attributes*.test.mjs, tests/audiences*.test.mjs.

- [x] Write failing tests for complete OR intersections, inherited contradictions, true OR unknown, malformed trees, custom type/value checks, immutable catalog persistence and old hash preservation.
- [x] Implement the spec's ProfileAttribute and AudienceExpression contracts; validateAudienceExpression returns structured paths and proof-limit status.
- [x] Use the same expression in evaluation, descriptions, candidate capacity and all interval-pair conflicts. Export explainAllocationConflicts with object, intersection, reason and witness when available.
- [x] Run node --experimental-strip-types --test tests/audiences*.test.mjs tests/profile-attributes*.test.mjs and then the full suite.

## Task 2: Shared editor and allocation entry points

Files: src/components/AudienceEditor.tsx, AudienceRuleBuilder.tsx, AudienceSelect.tsx, CreateExperiment.tsx, NestedDomainEditor.tsx, TrafficDomains.tsx, ExperimentDetail.tsx, audience-editor.css.

- [x] Build one controlled tree editor with typed choices, 3-level boundaries, validation paths and expression preview.
- [x] Implement manual qualification preview and display explicit unknown reasons without invented cohort counts.
- [x] Share editor through AudienceSelect; pass experiments, preserve outer form, auto-select saved version. Only top dialog handles Escape and Tab.
- [x] Extend simulator inputs and cache validation to catalog attributes while preserving existing snapshots.
- [x] Render complete expressions and explain conflicts in details and allocation forms. Run build and browser integration checks.

## Task 3: Catalog, routing and references

Files: src/components/AudienceCenter.tsx, ProfileAttributeCenter.tsx, audience-management.css, src/audience-management.ts, tests/audience-management.test.mjs.

- [x] Test nested-tree property references, inherited domain/experiment references, route decode and unknown deep links before implementing helpers.
- [x] Replace old inline AND editor with shared AudienceEditor; add two independently addressable tabs and preserve filters on switch.
- [x] Register custom attributes from real application catalog; show metadata, immutability and referenced audience versions/domain paths/experiments.
- [x] Render full expression summaries and comparison result, keeping audience overlap legal in the catalog.

## Task 4: Review, documentation and final verification

- [x] Independent review of OR proof, version/persistence, custom snapshots, type boundaries and modal behavior; resolve meaningful findings.
- [x] Root runs npm test and npm run build on final sources.
- [x] Verify end-to-end browser flow from attribute registration to nested audience, version/cross-reference, inline creation and fixed-profile simulation.
- [x] Update README, PRD, ARCHITECTURE, 联动实验设计 and docs/VERIFICATION.md with observed results and explicit production boundaries.

## Completion evidence

Completed 2026-09-12. Independent final `npm test`: 149/149 passing, zero failures/skips. `npm run build` passed; existing >500 kB chunk warning remains. Browser checks covered custom attribute registration, three-level audience composition, experiment and domain inline creation, shared buckets with disjoint conditions, immutable profile restoration and complete references. See [verification record](../../VERIFICATION.md). The localhost user workspace received no test entities.
