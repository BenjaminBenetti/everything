#!/usr/bin/env bash
# Check that install-k3s.sh replaced /etc/hosts with a new file that kept the old one's owner, mode,
# ACL, and extended attribute, which the workflow set before installing, and holds the installer's
# block once, or none after removal:
#   check-hosts.sh <folder with hosts.metadata and hosts.inode> <replaced|removed>
set -euo pipefail
saved=$1 expected=$2
fail() {
  printf 'FAILED: %s\n' "$*" >&2
  exit 1
}

[ "$(stat -c '%u:%g:%a' /etc/hosts)" = "$(cat "$saved/hosts.metadata")" ] || fail "the owner or mode changed"
[ "$(stat -c %i /etc/hosts)" != "$(cat "$saved/hosts.inode")" ] || fail "the file was written in place"
getfattr -n user.everything-smoke /etc/hosts | grep -qx 'user.everything-smoke="kept"' ||
  fail "the extended attribute was lost"
getfacl -p /etc/hosts | grep -qx 'user:nobody:r--' || fail "the ACL was lost"
if compgen -G '/etc/.hosts.everything-local.*' > /dev/null; then fail "a staged copy was left behind"; fi
blocks=$(grep -cxF '# BEGIN Everything local installer (install-k3s.sh)' /etc/hosts || true)
case $expected in
  replaced) [ "$blocks" = 1 ] || fail "the hosts file has $blocks blocks" ;;
  removed) [ "$blocks" = 0 ] || fail "the hosts file still has $blocks blocks" ;;
esac
grep -qE '^127\.0\.0\.1[[:space:]]+localhost' /etc/hosts || fail "localhost is gone"
echo "/etc/hosts was replaced whole and kept its owner, mode, ACL, and extended attribute"
