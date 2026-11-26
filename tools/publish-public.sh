#!/usr/bin/env bash
# Publishes a leak-checked snapshot of the private working repo to the PUBLIC senchi-dev/life-os repo.
# Usage: tools/publish-public.sh [--dry-run]    (--dry-run stops before any commit or push)
# Never run for real without the owner's explicit go-ahead. Never prints a denylist term, never forces a push.
set -euo pipefail

REMOTE_URL='https://github.com/senchi-dev/life-os.git'
PATTERNS=""
ERRLOG=""

# fd 3 = the real stderr; tool stderr (find, grep, rsync, git clone) goes to $ERRLOG and is only shown masked.
exec 3>&2
die() {
  local line
  if [ -n "$ERRLOG" ] && [ -s "$ERRLOG" ]; then
    while IFS= read -r line; do printf '  %s\n' "$(mask "$line")" >&3; done < "$ERRLOG"
  fi
  echo "FATAL: $*" >&3
  exit 1
}
lc() { printf '%s' "$1" | tr '[:upper:]' '[:lower:]'; }

# One string with every denylist term (case-insensitive) masked: all match spans of all terms are found in the
# ORIGINAL string, overlapping/adjacent spans merge, each merged run becomes ***. If a term still shows (case folding
# awk cannot do), the whole string is hidden. Used for EVERY path the script prints once the denylist is loaded.
mask() {
  local s="$1" out
  if [ -z "$PATTERNS" ] || [ ! -s "$PATTERNS" ]; then printf '%s' "$s"; return; fi
  out="$(printf '%s\n' "$s" | awk '
    NR == FNR { if (length($0)) t[++n] = tolower($0); next }
    {
      s = $0; l = tolower(s); len = length(s)
      for (i = 1; i <= len; i++) c[i] = 0
      for (i = 1; i <= n; i++) {
        tl = length(t[i]); start = 1
        while (start <= len && (k = index(substr(l, start), t[i])) > 0) {
          p = start + k - 1
          for (m = p; m < p + tl; m++) c[m] = 1
          start = p + 1
        }
      }
      res = ""; run = 0
      for (i = 1; i <= len; i++) {
        if (c[i]) { if (!run) res = res "***"; run = 1 } else { res = res substr(s, i, 1); run = 0 }
      }
      print res
    }' "$PATTERNS" -)"
  if printf '%s\n' "$out" | grep -iF -f "$PATTERNS" >/dev/null; then out="(path hidden: contains a denylist term)"; fi
  printf '%s' "$out"
}

# stdin: absolute paths under $1. Prints them relative to $1 and masked, to the real stderr (fd 3).
show_paths() {
  local dir="$1" p
  while IFS= read -r p; do
    [ -n "$p" ] || continue
    printf '  %s\n' "$(mask "${p#"$dir"/}")" >&3
  done
}

rel_paths() {
  local p
  while IFS= read -r p; do printf '%s\n' "${p#"$1"/}"; done
}

# UTF-8 aware, case-insensitive scanning where the platform has such a locale (macOS: en_US.UTF-8).
LOC=C
for l in C.UTF-8 en_US.UTF-8 en_US.utf8; do
  if locale -a 2>/dev/null | grep -ix "$l" >/dev/null; then LOC="$l"; break; fi
done
export LC_ALL="$LOC"

ALLOWED_ORIGIN_RE='^(https://github\.com/|git@github\.com:|ssh://git@github\.com/)senchi-dev/life-os$'
url_ok() {
  local url
  url="$(lc "$1")"
  url="${url%/}"
  url="${url%.git}"
  [[ "$url" =~ $ALLOWED_ORIGIN_RE ]]
}
# Every effective fetch AND push URL of origin (after insteadOf/pushInsteadOf/pushurl) must be the public repo.
origin_ok() {
  local urls u n=0
  urls="$( { git -C "$1" remote get-url --all origin && git -C "$1" remote get-url --push --all origin; } 2>/dev/null)" \
    || return 1
  while IFS= read -r u; do
    url_ok "$u" || return 1
    n=$((n + 1))
  done <<< "$urls"
  [ "$n" -ge 2 ]
}

DRY=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY=1 ;;
    *) die "unknown argument (usage: publish-public.sh [--dry-run])" ;;
  esac
done

# Test-only switches: honoured solely with --dry-run.
ALLOW_DIRTY=0
SKIP_TESTS=0
if [ "$DRY" -ne 1 ]; then
  for v in PUBLISH_ALLOW_DIRTY PUBLISH_SKIP_TESTS; do
    if [ -n "${!v:-}" ]; then
      echo "warning: $v is ignored without --dry-run" >&2
    fi
  done
else
  [ "${PUBLISH_ALLOW_DIRTY:-}" = "1" ] && ALLOW_DIRTY=1
  [ "${PUBLISH_SKIP_TESTS:-}" = "1" ] && SKIP_TESTS=1
fi

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
cd "$SRC"

# --- (1) the private tree must be clean, tested and stamped
if [ "$ALLOW_DIRTY" -ne 1 ] && [ -n "$(git status --porcelain)" ]; then
  die "working tree is dirty: commit or stash first"
fi
if [ "$SKIP_TESTS" -ne 1 ]; then
  npm test || die "npm test failed"
fi
STAMP_OUT="$(node tools/stamp-sw.mjs --check 2>&1)" || { echo "$STAMP_OUT" >&2; die "stamp check failed"; }
case "$STAMP_OUT" in
  *"stamp is current"*) ;;
  *) echo "$STAMP_OUT" >&2; die "stamp check did not confirm 'stamp is current'" ;;
esac

# --- denylist (lives outside both repos), loaded first so every later message can be masked
DENY="${PUBLISH_DENYLIST:-$HOME/.config/life-os/publish-denylist}"
[ -f "$DENY" ] || die "denylist missing: $DENY"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
STAGE="$WORK/stage"
mkdir "$STAGE"

if tr -d '\r' < "$DENY" | grep -E '^[[:space:]]*#[^[:space:]]' >/dev/null; then
  echo "warning: denylist line(s) starting with '#' are treated as comments and not scanned" >&2
fi
# UTF-8 BOM on the first line stripped, CR stripped, blank and comment lines removed (a blank pattern matches all).
tr -d '\r' < "$DENY" | LC_ALL=C sed $'1s/^\xEF\xBB\xBF//' | grep -v -E '^[[:space:]]*(#|$)' > "$WORK/patterns" || true
[ -s "$WORK/patterns" ] || die "denylist is empty (no non-blank, non-comment lines): $DENY"
# Both Unicode normalisations of every term (macOS names and text may be NFD), where iconv can convert.
if printf 'a' | iconv -f UTF-8 -t UTF-8-MAC >/dev/null 2>&1; then
  { cat "$WORK/patterns"
    iconv -f UTF-8 -t UTF-8-MAC < "$WORK/patterns" 2>/dev/null || true
    iconv -f UTF-8-MAC -t UTF-8 < "$WORK/patterns" 2>/dev/null || true
  } | sort -u > "$WORK/patterns.all"
  mv "$WORK/patterns.all" "$WORK/patterns"
fi
PATTERNS="$WORK/patterns"
ERRLOG="$WORK/tool.err"
: > "$ERRLOG"

# Secret shapes that must never ship, independent of the denylist (sb_publishable_ keys are public by design).
SECRETS="$WORK/secrets"
cat > "$SECRETS" <<'PAT'
sb_secret_[A-Za-z0-9]
eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.
-----BEGIN [A-Z ]*PRIVATE KEY-----
[Ss][Ee][Rr][Vv][Ii][Cc][Ee][_[:space:]-]?[Rr][Oo][Ll][Ee].{0,20}[:=][[:space:]]*['"`][A-Za-z0-9_.-]{20,}
[Ss][Ee][Rr][Vv][Ii][Cc][Ee][_[:space:]-]?[Rr][Oo][Ll][Ee].{0,20}[:=][[:space:]]*[A-Za-z0-9_-]{20,}([^A-Za-z0-9_.(-]|$)
PAT

# --- (2) the public checkout
PUB="${LIFEOS_PUBLIC_DIR:-$HOME/life-os-public}"
[ -n "$PUB" ] || die "empty public dir"
if [ ! -d "$PUB" ]; then
  [ "$DRY" -ne 1 ] || die "dry-run needs an existing LIFEOS_PUBLIC_DIR (refusing to clone): $(mask "$PUB")"
  git clone -q "$REMOTE_URL" "$PUB" 2>"$ERRLOG" || die "git clone failed"
fi
PUB="$(cd "$PUB" && pwd -P)"
PUB_M="$(mask "$PUB")"
[ "$PUB" != "/" ] || die "refusing / as the public dir"
HOME_REAL="$(cd "${HOME:-/nonexistent}" 2>/dev/null && pwd -P)" || HOME_REAL=""
[ -z "$HOME_REAL" ] || [ "$PUB" != "$HOME_REAL" ] || die "refusing HOME as the public dir"
PUB_TOP="$(git -C "$PUB" rev-parse --show-toplevel 2>/dev/null)" || die "public dir is not a git repo: $PUB_M"
PUB_TOP="$(cd "$PUB_TOP" && pwd -P)"
[ "$PUB_TOP" = "$PUB" ] || die "public dir is not the root of a git repo: $PUB_M"
origin_ok "$PUB" || die "public repo origin (fetch and push URL) is not senchi-dev/life-os: $PUB_M"
SRC_L="$(lc "$SRC/")"
PUB_L="$(lc "$PUB/")"
case "$PUB_L" in "$SRC_L"*) die "public dir must be a separate directory from the private repo" ;; esac
case "$SRC_L" in "$PUB_L"*) die "public dir must be a separate directory from the private repo" ;; esac

# --- (3) snapshot of HEAD, private material removed (export-ignore is not relied on alone)
git archive HEAD | tar -x -C "$STAGE"
rm -rf "$STAGE/docs" "$STAGE/.superpowers" "$STAGE/.claude"
find "$STAGE" -type d -iname '.claude' -prune -exec rm -rf {} +

# File types the public repo may contain. Anything else is fatal (a leaked export, db or archive would have to be renamed first).
EXT_OK=" html js mjs css json webmanifest md txt svg png ico woff2 jpg jpeg sh sql "
NAME_OK=" .nojekyll .gitignore .gitattributes "

# Leak guards, run on the stage before $PUB is touched and again on $PUB after the sync. The NAME check runs first,
# and every path printed after it goes through show_paths (masked), so no term or secret is ever printed.
guard() {
  local dir="$1" label="$2" found rc f base b2 ext enc
  # denylist in file and directory NAMES, first
  # (relative paths only, so the scan never matches the location of the checkout itself)
  found="$(find "$dir" -mindepth 1 -path "$dir/.git" -prune -o -print | rel_paths "$dir" | grep -iF -f "$PATTERNS" || true)"
  if [ -n "$found" ]; then
    printf '%s\n' "$found" | show_paths "$dir"
    die "$label: denylist match in file/directory name(s) listed above (term masked)"
  fi

  [ ! -e "$dir/docs" ] || die "$label: docs/ present"
  [ ! -e "$dir/.superpowers" ] || die "$label: .superpowers/ present"
  [ ! -e "$dir/.claude" ] || die "$label: .claude/ present"
  found="$(find "$dir" -path "$dir/.git" -prune -o -type d -iname '.claude' -print)"
  [ -z "$found" ] || { printf '%s\n' "$found" | show_paths "$dir"; die "$label: nested .claude/ present"; }

  found="$(find "$dir" -path "$dir/.git" -prune -o -type l -print)"
  if [ -n "$found" ]; then
    printf '%s\n' "$found" | show_paths "$dir"
    die "$label: symlink(s) listed above"
  fi

  found="$(find "$dir" -path "$dir/.git" -prune -o \( -iname '.env*' -o -iname '*.lifeos.json' \
    -o -iname '*.strive.json' -o -iname '*.db' -o -iname '*.sqlite' -o -iname '*.pem' -o -iname '*.key' \
    -o -iname '.npmrc' -o -iname 'id_rsa*' -o -name '.DS_Store' \) -print)"
  if [ -n "$found" ]; then
    printf '%s\n' "$found" | show_paths "$dir"
    die "$label: private/secret file(s) listed above"
  fi

  # extension allowlist
  while IFS= read -r f; do
    base="${f##*/}"
    case "$NAME_OK" in *" $base "*) continue ;; esac
    b2="${base#.}"
    case "$b2" in *.*) ext="$(lc "${b2##*.}")" ;; *) ext="" ;; esac
    case "$EXT_OK" in
      *" $ext "*) [ -n "$ext" ] || { printf '%s\n' "$f" | show_paths "$dir"; die "$label: file without an extension listed above"; } ;;
      *) printf '%s\n' "$f" | show_paths "$dir"; die "$label: file type not on the allowlist (file listed above)" ;;
    esac
  done < <(find "$dir" -path "$dir/.git" -prune -o -type f -print)

  # secrets, independent of the denylist
  rc=0
  found="$(grep -raE -f "$SECRETS" -l --exclude-dir=.git "$dir")" || rc=$?
  [ "$rc" -le 1 ] || die "$label: secret scan failed (grep exit $rc)"
  if [ -n "$found" ]; then
    printf '%s\n' "$found" | show_paths "$dir"
    die "$label: secret-shaped content in the file(s) listed above (not shown)"
  fi

  # denylist in content: text pass, then binary treated as text
  rc=0
  found="$(grep -rIiF -f "$PATTERNS" -l --exclude-dir=.git "$dir")" || rc=$?
  [ "$rc" -le 1 ] || die "$label: denylist scan failed (grep exit $rc)"
  if [ -z "$found" ]; then
    rc=0
    found="$(grep -raiF -f "$PATTERNS" -l --exclude-dir=.git "$dir")" || rc=$?
    [ "$rc" -le 1 ] || die "$label: binary denylist scan failed (grep exit $rc)"
  fi
  # UTF-16 (with or without BOM, either byte order). UTF-16 text contains NUL bytes, so only files containing a NUL
  # need decoding; plain text was covered above.
  if [ -z "$found" ]; then
    while IFS= read -r f; do
      [ "$(LC_ALL=C tr -d '\000' < "$f" | wc -c)" -ne "$(wc -c < "$f")" ] || continue
      for enc in UTF-16 UTF-16LE UTF-16BE; do
        if iconv -c -f "$enc" -t UTF-8 < "$f" 2>/dev/null | grep -aiF -f "$PATTERNS" >/dev/null; then
          found="$f"; break 2
        fi
      done
    done < <(find "$dir" -path "$dir/.git" -prune -o -type f -print)
  fi
  if [ -n "$found" ]; then
    printf '%s\n' "$found" | show_paths "$dir"
    die "$label: denylist match in the file(s) listed above (term not shown)"
  fi
}

# Tool stderr inside guard() is captured; anything there is unexpected, so fail closed (shown masked).
guard "$STAGE" stage 2>"$ERRLOG"
[ ! -s "$ERRLOG" ] || die "unexpected errors while scanning the stage"

# Everything from here mutates $PUB: a real run needs a human at a terminal.
if [ "$DRY" -ne 1 ]; then
  { [ -t 0 ] && [ -t 1 ]; } || die "a real publish needs an interactive terminal (stdin and stdout must be a tty)"
  # The published app needs the gym schema: shipping it before 004 breaks every screen. Asked before anything is touched.
  MIGRATED=""
  read -r -p 'Migration 004 applied in Supabase and rls.sql showed RLS OK? Type yes: ' MIGRATED < /dev/tty || MIGRATED=""
  [ "$MIGRATED" = "yes" ] || die "not published: apply supabase/migrations/004_gym.sql and run supabase/tests/rls.sql first"
fi

# --- (4) sync
rsync -a --delete --exclude .git "$STAGE"/ "$PUB"/ >/dev/null 2>"$ERRLOG" || die "rsync into the public dir failed"

# --- (5) guards again on the real public tree
guard "$PUB" public 2>"$ERRLOG"
[ ! -s "$ERRLOG" ] || die "unexpected errors while scanning the public dir"

if [ "$DRY" -eq 1 ]; then
  echo "dry run OK: $PUB_M is synced and clean; nothing committed or pushed"
  exit 0
fi

# --- (6) commit, review, confirm, push
[ "$(git -C "$PUB" symbolic-ref --short HEAD)" = "main" ] || die "public repo is not on branch main"
git -C "$PUB" add -A
if git -C "$PUB" diff --cached --quiet; then
  echo "nothing changed since the last publish"
  exit 0
fi
git -C "$PUB" commit -q -m "publish $(git rev-parse --short HEAD)"
git -C "$PUB" show --stat
origin_ok "$PUB" || die "public repo origin changed: refusing to push"
ANSWER=""
read -r -p 'Type publish to push to origin main: ' ANSWER < /dev/tty || ANSWER=""
if [ "$ANSWER" = "publish" ]; then
  git -C "$PUB" push origin main
else
  echo "not pushed (commit kept locally in $PUB_M)"
fi
