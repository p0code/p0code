---
name: judges
description: Convene independent reviewer models when asked for judges, a swarm of reviewers, or a multi-model review; validate and fix the resulting findings.
---

Use `convene_judges` on the current thread. Pass `focus` for the requested scope; omit `members` to use Settings → Judges. For an ad-hoc panel, use `orchestrator_capabilities` to find the requested models and pass members with providerInstanceId, model, enabled:true, and optional options. Never substitute a different model without asking.

The service starts a panel coordinator. Leave `asCoordinator` unset: it is reserved for that coordinator's reviewer fan-out. Wait for its completion notification; do not poll or start another panel while it is working. Cancellation uses the returned coordinator task's `taskId` with `task_cancel` and stops its descendants too.

Judges inspect independently and do not edit. The coordinator returns one report grouped by severity, with duplicate issues combined, agreeing models identified, disagreements preserved, and skipped or failed reviewers disclosed. Validate each finding against actual code, fix real issues, and run focused tests. Explain dismissed findings and any remaining limitations. A requested follow-up panel is a new `convene_judges` call.
