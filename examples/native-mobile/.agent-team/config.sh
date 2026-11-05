# shellcheck shell=bash disable=SC2034
# .agent-team/config.sh for a repository with native Android and iOS apps and a shared core.
AGENT_TEAM_PROJECT="example-app"
AGENT_TEAM_POOLS="gradle:3 xcode:1 emulator:3 simulator:3 browser:3 backend:1"
AGENT_TEAM_GATES_ALL="shared android ios web backend"

gate_shared() {
  run "shared: core and data tests" locked gradle ./gradlew --no-daemon :core:test :data:test
}
gate_android() {
  gate_shared
  run "android: assemble and unit tests" locked gradle ./gradlew :apps:android:assembleDebug :apps:android:testDebugUnitTest
  if command -v maestro >/dev/null && ls qa/flows/android/*.yaml >/dev/null 2>&1; then
    run "android: Maestro flows" locked emulator maestro test qa/flows/android/
  fi
}
gate_ios() {
  gate_shared
  run "ios: simulator build and unit tests" locked xcode xcodebuild test -project apps/ios/App.xcodeproj -scheme App \
    -destination "platform=iOS Simulator,name=${IOS_GATE_SIMULATOR:-Dev iPhone}" CODE_SIGNING_ALLOWED=NO
}
gate_web() {
  run "web: install, check, build" locked gradle bash -c "cd apps/web && npm ci && npm run check && npm run build"
}
gate_backend() {
  run "backend: database tests" locked backend bash -c "cd backend && npm test"
}
janitor_extra() {
  ./gradlew --stop >/dev/null 2>&1 || true
  xcrun simctl shutdown all >/dev/null 2>&1 || true
}
