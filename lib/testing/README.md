# lib/testing

Synthetic fixtures shared by the harness's tests. `fixtures/acme/` is an invented project profile.
Never point a test at `profiles/`: those are local, git-ignored and differ on every machine.

`fixtures/private-access/` adds a second profile (`beta`), two brains (`main`, `acme-notes`) and an
access matrix; `private-access.mjs` builds a throwaway `TILLER_HOME` from them and `fixtures/acme/`.
