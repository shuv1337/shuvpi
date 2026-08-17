#!/bin/sh

set -eu

fail() {
	printf 'shuvpi installer: %s\n' "$*" >&2
	exit 1
}

can_create_in() {
	_shuvpi_target=$1
	while [ ! -d "$_shuvpi_target" ]; do
		_shuvpi_parent=$(dirname "$_shuvpi_target")
		[ "$_shuvpi_parent" != "$_shuvpi_target" ] || return 1
		_shuvpi_target=$_shuvpi_parent
	done
	_shuvpi_probe="$_shuvpi_target/.shuvpi-write-test-$$"
	(umask 077 && mkdir "$_shuvpi_probe" && rmdir "$_shuvpi_probe") >/dev/null 2>&1
}

append_posix_path() {
	_shuvpi_profile=$1
	_shuvpi_marker='# Added by the Shuvpi installer'
	mkdir -p "$(dirname "$_shuvpi_profile")"
	touch "$_shuvpi_profile"
	if ! grep -Fqx "$_shuvpi_marker" "$_shuvpi_profile"; then
		cat >> "$_shuvpi_profile" <<'SHUVPI_PATH'

# Added by the Shuvpi installer
case ":$PATH:" in
	*":$HOME/.local/bin:"*) ;;
	*) export PATH="$HOME/.local/bin:$PATH" ;;
esac
SHUVPI_PATH
	fi
}

append_fish_path() {
	_shuvpi_profile=$1
	_shuvpi_marker='# Added by the Shuvpi installer'
	mkdir -p "$(dirname "$_shuvpi_profile")"
	touch "$_shuvpi_profile"
	if ! grep -Fqx "$_shuvpi_marker" "$_shuvpi_profile"; then
		cat >> "$_shuvpi_profile" <<'SHUVPI_PATH'

# Added by the Shuvpi installer
fish_add_path "$HOME/.local/bin"
SHUVPI_PATH
	fi
}

main() {
	package='@shuv1337/shuvpi-coding-agent'
	minimum_node_version=22.19.0

	command -v node >/dev/null 2>&1 || fail "Node.js ${minimum_node_version} or newer is required."
	command -v npm >/dev/null 2>&1 || fail 'npm is required.'

	node_version=$(node --version 2>/dev/null) || fail 'Unable to determine the Node.js version.'
	node_version=${node_version#v}
	node_major=${node_version%%.*}
	node_remainder=${node_version#*.}
	node_minor=${node_remainder%%.*}
	node_patch=${node_remainder#*.}
	case "$node_major:$node_minor:$node_patch" in
		*[!0-9:]* | :* | *: | *::* ) fail "Unsupported Node.js version: ${node_version}. Node.js ${minimum_node_version} or newer is required." ;;
	esac
	if [ "$node_major" -lt 22 ] || {
		[ "$node_major" -eq 22 ] && [ "$node_minor" -lt 19 ]
	}; then
		fail "Unsupported Node.js version: ${node_version}. Node.js ${minimum_node_version} or newer is required."
	fi

	global_prefix=$(npm prefix -g 2>/dev/null || true)
	global_root=$(npm root -g 2>/dev/null || true)
	while [ "$global_prefix" != / ] && [ "${global_prefix%/}" != "$global_prefix" ]; do
		global_prefix=${global_prefix%/}
	done
	global_bin_on_path=false
	if [ -n "$global_prefix" ]; then
		case ":${PATH:-}:" in
			*":$global_prefix/bin:"*) global_bin_on_path=true ;;
		esac
	fi

	if [ -n "$global_prefix" ] &&
		[ -n "$global_root" ] &&
		[ "$global_bin_on_path" = true ] &&
		can_create_in "$global_root" &&
		can_create_in "$global_prefix/bin"; then
		install_prefix=$global_prefix
	else
		[ -n "${HOME:-}" ] || fail 'HOME is required when npm has no usable user-writable global prefix.'
		install_prefix=$HOME/.local
	fi

	case "$install_prefix" in
		*'
'*) fail 'The install prefix must not contain a newline.' ;;
	esac

	if [ "$install_prefix" = "$HOME/.local" ]; then
		existing_shuvpi=$(command -v shuvpi 2>/dev/null || true)
		if [ -n "$existing_shuvpi" ] && [ "$existing_shuvpi" != "$HOME/.local/bin/shuvpi" ]; then
			printf 'Existing Shuvpi command found at %s; the new user installation will take precedence in new shells.\n' "$existing_shuvpi"
		fi
	fi

	mkdir -p "$install_prefix"
	printf 'Installing Shuvpi under %s\n' "$install_prefix"
	npm --prefix "$install_prefix" install -g --ignore-scripts --no-audit --no-fund "$package"

	bin_dir=$install_prefix/bin
	shuvpi_bin=$bin_dir/shuvpi
	[ -x "$shuvpi_bin" ] || fail "npm completed without creating ${shuvpi_bin}."

	path_updated=false
	profile_description=''
	case ":${PATH:-}:" in
		*":$bin_dir:"*) ;;
		*)
			[ -n "${HOME:-}" ] || fail "Add ${bin_dir} to PATH."
			case "${SHELL:-}" in
				*/zsh)
					append_posix_path "$HOME/.zshrc"
					profile_description=$HOME/.zshrc
					;;
				*/fish)
					append_fish_path "$HOME/.config/fish/conf.d/shuvpi.fish"
					profile_description=$HOME/.config/fish/conf.d/shuvpi.fish
					;;
				*/bash)
					append_posix_path "$HOME/.profile"
					append_posix_path "$HOME/.bashrc"
					profile_description="$HOME/.profile and $HOME/.bashrc"
					;;
				*)
					append_posix_path "$HOME/.profile"
					profile_description=$HOME/.profile
					;;
			esac
			path_updated=true
			;;
	esac

	version=$("$shuvpi_bin" --version)
	printf 'Installed Shuvpi %s at %s\n' "$version" "$shuvpi_bin"
	if [ "$path_updated" = true ]; then
		printf 'PATH was updated in %s. Open a new shell, then run: shuvpi\n' "$profile_description"
	else
		printf 'Run: shuvpi\n'
	fi
}

main "$@"
