#!/bin/sh
# WageRoute installer for macOS and Linux.
#
#   curl -fsSL https://revax-2007.github.io/wageroute/install.sh | sh
#   curl -fsSL https://revax-2007.github.io/wageroute/install.sh | sh -s -- --dry-run
#
# It downloads the right build of the latest (or a pinned) release from
# https://github.com/ReVax-2007/wageroute/releases, checks it against that
# release's SHA256SUMS, installs it, and clears the "downloaded from the
# internet" flag so the first launch opens without a Gatekeeper prompt.
#
# It never reads, moves or deletes your ledger. WageRoute keeps it in
#   macOS  ~/Library/Application Support/WageRoute
#   Linux  ~/.config/WageRoute
#
# Everything runs from main(), called on the last line, so a download cut
# off half way through runs nothing.

set -eu

REPO="ReVax-2007/wageroute"
RELEASES="https://github.com/$REPO/releases"

say() { printf '%s\n' "$*"; }
step() { printf '\n==> %s\n' "$*"; }
die() { printf 'wageroute-install: %s\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

usage() {
  cat <<'EOF'
Install WageRoute on macOS or Linux.

Usage: install.sh [options]

  --version vX.Y.Z  Install this release instead of the latest
  --dry-run         Download and verify, but install nothing
  --appimage        Linux: use the AppImage even if a package manager exists
  --dir FOLDER      macOS: install WageRoute.app into FOLDER, not /Applications
  -h, --help        Show this help

Piped:  curl -fsSL https://revax-2007.github.io/wageroute/install.sh | sh -s -- --dry-run
EOF
}

# The tag GitHub's "latest release" page redirects to, e.g. v1.3.1.
latest_tag() {
  url=$(curl -fsSLI -o /dev/null -w '%{url_effective}' "$RELEASES/latest") ||
    die "could not reach GitHub to find the latest release"
  tag=${url##*/tag/}
  case $tag in
    v[0-9]*) printf '%s\n' "$tag" ;;
    *) die "could not read the latest release tag from $url" ;;
  esac
}

sha256_of() {
  if have sha256sum; then
    sha256sum "$1" | cut -d' ' -f1
  elif have shasum; then
    shasum -a 256 "$1" | cut -d' ' -f1
  else
    die "need sha256sum or shasum to verify the download"
  fi
}

# Download one asset of the release and refuse it unless SHA256SUMS agrees.
fetch_verified() {
  asset=$1
  base="$RELEASES/download/$TAG"
  step "Downloading $asset"
  curl -fL --progress-bar -o "$WORK/$asset" "$base/$asset" ||
    die "download failed: $base/$asset"
  curl -fsSL -o "$WORK/SHA256SUMS" "$base/SHA256SUMS" ||
    die "could not download $base/SHA256SUMS"
  expected=$(awk -v f="$asset" '$2 == f || $2 == "*" f { print $1 }' "$WORK/SHA256SUMS" | head -n 1)
  [ -n "$expected" ] || die "$asset is not listed in the release's SHA256SUMS"
  actual=$(sha256_of "$WORK/$asset")
  [ "$actual" = "$expected" ] ||
    die "checksum mismatch for $asset (expected $expected, got $actual); nothing was installed"
  say "Checksum OK ($actual)"
}

install_macos() {
  case $(uname -m) in
    arm64) arch=arm64 ;;
    x86_64) arch=x64 ;;
    *) die "unsupported Mac architecture: $(uname -m)" ;;
  esac
  dmg="WageRoute-$VERSION-$arch.dmg"
  fetch_verified "$dmg"
  [ "$DRY_RUN" = 1 ] && { say "Dry run: $dmg verified, nothing installed."; return; }

  if [ -z "$TARGET_DIR" ]; then
    if [ -w /Applications ]; then TARGET_DIR=/Applications; else TARGET_DIR="$HOME/Applications"; fi
  fi
  mkdir -p "$TARGET_DIR"
  app="$TARGET_DIR/WageRoute.app"

  if [ "$TARGET_DIR" = /Applications ] || [ "$TARGET_DIR" = "$HOME/Applications" ]; then
    if pgrep -x WageRoute >/dev/null 2>&1; then
      die "WageRoute is running. Quit it (Cmd+Q) and run this again."
    fi
  fi

  step "Installing into $TARGET_DIR"
  mount="$WORK/mount"
  mkdir -p "$mount"
  hdiutil attach -nobrowse -readonly -quiet -mountpoint "$mount" "$WORK/$dmg" ||
    die "could not open $dmg"
  MOUNTED="$mount"
  [ -d "$mount/WageRoute.app" ] || die "$dmg does not contain WageRoute.app"
  rm -rf "$app"
  ditto "$mount/WageRoute.app" "$app"
  hdiutil detach -quiet "$mount" || true
  MOUNTED=""

  # curl sets no quarantine flag, but an older copy dragged in from a browser
  # download may still carry one; clearing both keeps the first launch quiet.
  xattr -dr com.apple.quarantine "$app" 2>/dev/null || true
  xattr -dr com.apple.provenance "$app" 2>/dev/null || true

  say "Installed $app"
  say "Open it from Launchpad, Spotlight, or: open \"$app\""
}

linux_arch() {
  case $(uname -m) in
    x86_64 | amd64) DEB_ARCH=amd64; RPM_ARCH=x86_64; APPIMAGE_ARCH=x86_64 ;;
    aarch64 | arm64) DEB_ARCH=arm64; RPM_ARCH=aarch64; APPIMAGE_ARCH=arm64 ;;
    *) die "unsupported Linux architecture: $(uname -m)" ;;
  esac
}

# Run a command as root: directly when we are root, else through sudo.
as_root() {
  if [ "$(id -u)" = 0 ]; then "$@"; else sudo "$@"; fi
}

can_be_root() {
  [ "$(id -u)" = 0 ] || have sudo
}

install_appimage() {
  file="WageRoute-$VERSION-$APPIMAGE_ARCH.AppImage"
  fetch_verified "$file"
  [ "$DRY_RUN" = 1 ] && { say "Dry run: $file verified, nothing installed."; return; }

  bin="$HOME/.local/bin"
  apps="$HOME/.local/share/applications"
  mkdir -p "$bin" "$apps"
  step "Installing the AppImage into $bin"
  mv "$WORK/$file" "$bin/WageRoute.AppImage"
  chmod +x "$bin/WageRoute.AppImage"
  cat >"$apps/wageroute.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=WageRoute
Comment=Zero-based paycheck routing
Exec="$bin/WageRoute.AppImage" %U
Terminal=false
Categories=Office;Finance;
EOF
  say "Installed $bin/WageRoute.AppImage (with a menu entry)"

  if ! { ldconfig -p 2>/dev/null | grep -q 'libfuse\.so\.2'; }; then
    say ""
    say "The AppImage needs FUSE 2, which this system does not seem to have."
    say "  Ubuntu 24.04 and newer:  sudo apt install libfuse2t64"
    say "  Ubuntu 22.04 / Debian:   sudo apt install libfuse2"
    say "  Or run it without FUSE:  \"$bin/WageRoute.AppImage\" --appimage-extract-and-run"
  fi
}

install_linux() {
  linux_arch
  if [ "$FORCE_APPIMAGE" = 0 ] && can_be_root; then
    if have apt-get; then
      deb="WageRoute-$VERSION-$DEB_ARCH.deb"
      fetch_verified "$deb"
      [ "$DRY_RUN" = 1 ] && { say "Dry run: $deb verified, nothing installed."; return; }
      step "Installing $deb with apt (you may be asked for your password)"
      # apt reads local packages as its unprivileged _apt user.
      chmod 755 "$WORK"
      chmod 644 "$WORK/$deb"
      as_root apt-get install -y "$WORK/$deb"
      say "Installed. Open WageRoute from your app menu, or run: wageroute"
      return
    fi
    if have dnf || have zypper; then
      rpm_file="WageRoute-$VERSION-$RPM_ARCH.rpm"
      fetch_verified "$rpm_file"
      [ "$DRY_RUN" = 1 ] && { say "Dry run: $rpm_file verified, nothing installed."; return; }
      step "Installing $rpm_file (you may be asked for your password)"
      if have dnf; then
        as_root dnf install -y "$WORK/$rpm_file"
      else
        as_root zypper --non-interactive install --allow-unsigned-rpm "$WORK/$rpm_file"
      fi
      say "Installed. Open WageRoute from your app menu, or run: wageroute"
      return
    fi
  fi
  install_appimage
}

cleanup() {
  if [ -n "${MOUNTED:-}" ]; then hdiutil detach -quiet "$MOUNTED" 2>/dev/null || true; fi
  if [ -n "${WORK:-}" ]; then rm -rf "$WORK"; fi
}

main() {
  TAG=""
  DRY_RUN=0
  FORCE_APPIMAGE=0
  TARGET_DIR=""
  MOUNTED=""
  WORK=""

  while [ $# -gt 0 ]; do
    case $1 in
      --version)
        [ $# -ge 2 ] || die "--version needs a value, e.g. --version v1.3.1"
        TAG=$2; shift 2 ;;
      --version=*) TAG=${1#*=}; shift ;;
      --dry-run) DRY_RUN=1; shift ;;
      --appimage) FORCE_APPIMAGE=1; shift ;;
      --dir)
        [ $# -ge 2 ] || die "--dir needs a folder"
        TARGET_DIR=$2; shift 2 ;;
      --dir=*) TARGET_DIR=${1#*=}; shift ;;
      -h | --help) usage; exit 0 ;;
      *) usage >&2; die "unknown option: $1" ;;
    esac
  done

  have curl || die "curl is required"

  if [ -z "$TAG" ]; then TAG=$(latest_tag); fi
  case $TAG in v*) ;; *) TAG="v$TAG" ;; esac
  VERSION=${TAG#v}

  WORK=$(mktemp -d 2>/dev/null || mktemp -d -t wageroute)
  trap cleanup EXIT
  trap 'exit 130' INT TERM

  say "WageRoute $VERSION"
  case $(uname -s) in
    Darwin) install_macos ;;
    Linux) install_linux ;;
    *) die "this script is for macOS and Linux; on Windows use install.ps1 (see $RELEASES)" ;;
  esac
}

main "$@"
