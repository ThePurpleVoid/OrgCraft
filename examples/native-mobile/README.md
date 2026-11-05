# Example: a product with native Android and iOS apps

The project layer a repository would keep to use Agent Team Kit with two native apps, a shared core and a web dashboard. It shows the three ways to adapt the kit without copying it:

| File | What it shows |
| --- | --- |
| `team.json` | The `engineering` preset, minus the generic `mobile-dev` and `qa-mobile` |
| `roles/android-dev.md`, `ios-dev.md`, `qa-android.md`, `qa-ios.md` | New roles the kit does not have |
| `roles/cto.extend.md`, `head-of-quality.extend.md` | Replacing a section (`Direct reports`) of a kit role |
| `roles/shared-core-dev.extend.md`, `chief-of-staff.extend.md` | Adding rules and tools to kit roles |
| `protocols.extend.md` | Project-wide rules |
| `config.sh` | Gates and pools for Gradle, Xcode, emulators and simulators |

Try it:

```sh
cp -r examples/native-mobile/.agent-team /path/to/your/repo/
cd /path/to/your/repo && AGENT_TEAM_KIT_DIR=/path/to/Agent-Team-Kit node /path/to/Agent-Team-Kit/bin/agent-team.mjs sync
```
