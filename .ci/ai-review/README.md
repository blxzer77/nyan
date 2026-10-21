# Review evaluation cases

Each file here is one recorded review with its findings labelled. They exist to answer "is the reviewer getting better",
which the pipeline itself cannot answer: a run reports what it found, not whether what it found was true.

- `false_positive` — checked against the reviewed commit and wrong.
- `true_positive` — checked and right.
- `unverified` — recorded but not yet checked. Labelling is work, and a case is useful before it is complete.

A case records the run it came from, so a finding can be traced back to the comment and the commit. When a rule or a
model changes, re-running the same range and comparing labels is the measurement; the count of findings is not.
