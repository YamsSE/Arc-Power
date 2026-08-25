# M61 review 1

## Findings

- [P1 accepted] Color apply must query the driver's current pixel-transformation configuration after the write. A capability query alone cannot prove that the visible output changed.
- [P1 accepted] Partial color writes must preserve the other color controls instead of rebuilding them from neutral or stale defaults.
- [P2 accepted] Pixel-transformation GET and SET availability must be gated independently so read-only format/capability reporting still works when the setter is absent.
- [P2 accepted] Remove stale Graphics-page comments that still describe Display color writes, scaling, and VRR as intentionally unavailable.
- [P1 rejected] A review claim that pixel block type `4` and SET operation `2` are invalid is contradicted by Intel's official IGCL header; both values are documented and must remain unchanged.

## Triage

The accepted findings are addressed in the current native Display implementation: it uses the documented matrix-and-offsets layout, separates capability/current queries, preserves complete color state, verifies current read-back, and keeps GET-only reporting available. The enum claim is rejected and is retained here only to prevent an incorrect regression.
