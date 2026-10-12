profile: fixture-four-column

## test toolchain

| Lane | Runner | Command | Proof gate before judging |
|---|---|---|---|
| web | Playwright, driven from the app repo | `true` | logged in |
| mobile | Detox on simulator | `false` | smoke gate first |
| api | direct reads | n/a | n/a |
| lint | eslint | `/dev/null` | exit 126 |
| e2e | missing binary | `definitely-not-a-command-xyz` | exit 127 |

## gates
