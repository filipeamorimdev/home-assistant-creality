#!/usr/bin/env bash
# Release helper for this integration. Run on your own machine, from the repo.
#
#   scripts/release.sh [--dry-run] [branch]
#
# Checks the tree and tests, fast-forwards main to the branch (default: the
# current branch), tags v<manifest version> with that version's CHANGELOG
# section, pushes main and the tag, and creates the GitHub release with `gh`
# when available. HACS offers updates from GitHub releases.
set -euo pipefail

DRY=0
if [ "${1:-}" = "--dry-run" ]; then DRY=1; shift; fi
cd "$(git rev-parse --show-toplevel)"
BRANCH="${1:-$(git rev-parse --abbrev-ref HEAD)}"

run() {
  if [ "$DRY" = 1 ]; then echo "+ $*"; else "$@"; fi
}
fail() {
  echo "release: $*" >&2
  exit 1
}

[ -z "$(git status --porcelain)" ] || fail "working tree is not clean"
git rev-parse -q --verify "refs/heads/$BRANCH" >/dev/null || fail "no local branch '$BRANCH'"

VERSION="$(python3 -c 'import json; print(json.load(open("custom_components/creality/manifest.json"))["version"])')"
TAG="v$VERSION"
NOTES="$(awk -v head="## $VERSION" 'index($0, head) == 1 {found = 1; next} /^## / && found {exit} found' CHANGELOG.md)"
[ -n "$NOTES" ] || fail "CHANGELOG.md has no '## $VERSION' section"
git rev-parse -q --verify "refs/tags/$TAG" >/dev/null && fail "tag $TAG already exists"

echo "Releasing $TAG from $BRANCH"
git switch -q "$BRANCH"
python3 -m unittest discover -s tests -p 'test_*.py'
node --test tests/card-registration.cjs tests/test_card_offline.mjs >/dev/null || fail "card tests failed"

git fetch -q origin
if ! git merge-base --is-ancestor origin/main "$BRANCH"; then
  fail "origin/main has commits that $BRANCH lacks (e.g. the daily error-code refresh).
Rebase first:  git rebase origin/main $BRANCH
A conflict in custom_components/creality/data/error_codes.sqlite can take either
side ('git checkout --theirs <file>' keeps this branch's copy during a rebase);
the daily job regenerates it. Then run this script again."
fi

run git switch -q main
run git merge --ff-only "$BRANCH"
run git tag -a "$TAG" -m "$TAG" -m "$NOTES"
run git push origin main "$TAG"
if command -v gh >/dev/null 2>&1; then
  run gh release create "$TAG" --title "$TAG" --notes "$NOTES"
else
  echo "gh not installed: create the GitHub release for $TAG in the web UI (paste the CHANGELOG section)."
fi
echo "Done. In Home Assistant: HACS → Creality → Update, restart, then check Settings → Repairs."
