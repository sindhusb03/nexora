# Review workflow

Review exists to protect financial integrity. Approval means the reviewer checked the invariants, the tests, and the authorization path. It does not mean the diff merely looks tidy.

Start from the risk class in the pull request. The class definitions are in [sdlc.md](sdlc.md).

## Who reviews

| Class | Approvals | Constraint |
| --- | --- | --- |
| R0 | 1 | Anyone other than the author |
| R1 | 1 | Reviewer confirms the client does not calculate financial truth |
| R2 | 1 | Reviewer traces tenant, role, and region from identity, not from client-supplied scope alone |
| R3 | 2 | Author cannot be either approver. At least one approver reads the golden tests line by line |

A push that changes calculation, schema, auth, or money handling dismisses prior approval. Re-review the new diff. Cosmetic pushes do not reset the financial reading if the reviewer says so on the PR.

## Order of reading

1. PR summary, risk class, and named invariants.
2. Tests, especially `*.golden.test.ts` and rejection cases.
3. Domain code. For R3, the pure function before the SQL or HTTP adapter.
4. Authorization, idempotency, period lock, and audit emission.
5. UI last, against [UI-UX.md](../UI-UX.md).

## Financial checklist

Complete this for every R3 change, and for any R2 change that writes. The author checks the attestation box in the pull request. CI enforces the box when the diff touches `packages/kernel`, `packages/db`, `apps/api`, or `.github/workflows`. The box does not replace this reading.

- Invariants affected are named in the PR.
- Golden tests state inputs, formula or method version, and expected outputs.
- Amounts use integer minor units or `decimal.js`. No IEEE-754 money in a material path or hash.
- Posted journals stay immutable. Corrections are reversals plus new entries.
- Closed periods reject posts, deletes, and recurring mutations.
- Tenant and region resolve from the authenticated actor. A body or query id is not sufficient.
- Unexpected business-rule failures use a stable error code and fail closed.
- Material writes emit an audit event.
- New calculated outputs include lineage: calculation run id, formula version, input snapshot hash, output hash, engine version.
- Migrations preserve forced row-level security and do not grant the API role a bypass.
- No customer documents or live financial exports are in the diff.
- Workflow edits do not weaken `verify` or `financial-attestation`.

## API checklist (R2)

- Input is parsed with Zod.
- Idempotency keys and `Expected-Version` still apply on the writes that already require them.
- The handler recomputes totals. It does not persist a client total as truth.
- Denied actors get an authorization error, not an empty success.

## UI checklist (R1)

- The screen displays kernel output. It does not import `@nexora/kernel` to compute books or forecasts.
- Context is visible when numbers are shown: period, scenario version, currency, entity.
- Draft and published are distinct in label and color. Color is not the only signal.
- A material number has a path to source and lineage, or the screen states that the figure is not yet a published result.
- Irreversible actions ask for confirmation and state the consequence.
- Missing permission renders a locked state, not a blank that looks like zero.

## How to comment

- Tie the comment to an invariant or a test, not to taste.
- Request changes when a golden case is missing, a posted record can change, a client total is trusted, or tenant scope is client-controlled.
- Approve only after CI is green or after you have said which required check is still running and will block merge.
- Leave a short note of which golden tests you read when approving R3.

## Merge

Merge is squash to `main` after:

- `verify` passed
- `financial-attestation` passed
- the approval count for the risk class is met
- the branch is up to date with `main`

The merger confirms the approvals are from reviewers who are not the author when the class is R3.
