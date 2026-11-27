# EXEC-069 Validation for evidence-only changes

STORY-004, AC-MNT-002, NFR-MNT-004, TR-TEST-001 and TR-TEST-002.
The required Foundation and Documentation workflows still run for pull
requests that update the implementation status, Atlas evidence or the two
traceability registries. Foundation runs the classifier from the tested base
commit. It checks the exact prospective merge parents and recognizes changes
to existing regular files on that list. Bases without the classifier use all
Foundation checks.

The documentation workflow validates these records. Product, test, workflow,
build, generated API, mode and path changes take the full Foundation path.
Main retains every check and packaged release evidence. The Foundation
aggregate job requires a successful classification and checks its expected
job results for each path.

Verify an exact documentation candidate, a mixed change, a removed file,
an incorrect parent and a main push with the same classifier. The workflow
change itself takes the full path. Revert the workflow and classifier to
restore the earlier behavior.
