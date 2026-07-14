> shuvpi can help you create shuvpi packages. Ask it to bundle your extensions, skills, prompt templates, or themes.

# Shuvpi Packages

Shuvpi packages bundle extensions, skills, prompt templates, and themes so you can share them through npm or git. A package can declare resources in `package.json` under the `shuvpi` key, or use conventional directories.

## Table of Contents

- [Install and Manage](#install-and-manage)
- [Package Sources](#package-sources)
- [Creating a Shuvpi Package](#creating-a-shuvpi-package)
- [Package Structure](#package-structure)
- [Dependencies](#dependencies)
- [Package Filtering](#package-filtering)
- [Enable and Disable Resources](#enable-and-disable-resources)
- [Scope and Deduplication](#scope-and-deduplication)

## Install and Manage

> **Security:** Shuvpi packages run with full system access. Extensions execute arbitrary code, and skills can instruct the model to perform any action including running executables. Review source code before installing third-party packages.

```bash
shuvpi install npm:@foo/bar@1.0.0
shuvpi install git:github.com/user/repo@v1
shuvpi install https://github.com/user/repo  # raw URLs work too
shuvpi install /absolute/path/to/package
shuvpi install ./relative/path/to/package

shuvpi remove npm:@foo/bar
shuvpi list                     # show installed packages from settings
shuvpi update                   # update shuvpi only
shuvpi update --all             # update shuvpi, update packages, and reconcile pinned git refs
shuvpi update --extensions      # update packages and reconcile pinned git refs only
shuvpi update --self            # update shuvpi only
shuvpi update --self --force    # reinstall shuvpi even if current
shuvpi update npm:@foo/bar      # update one package
shuvpi update --extension npm:@foo/bar
```

These commands manage shuvpi packages and `shuvpi update` can update the shuvpi CLI installation. To uninstall shuvpi itself, see [Quickstart](quickstart.md#uninstall).

By default, `install` and `remove` write to user settings (`~/.shuvpi/agent/settings.json`). Use `-l` to write to project settings (`.shuvpi/settings.json`) instead. Project settings can be shared with your team, and shuvpi installs any missing packages automatically on startup after the project is trusted.

To try a package without installing it, use `--extension` or `-e`. This installs to a temporary directory for the current run only:

```bash
shuvpi -e npm:@foo/bar
shuvpi -e git:github.com/user/repo
```

## Package Sources

Shuvpi accepts three source types in settings and `shuvpi install`.

### npm

```
npm:@scope/pkg@1.2.3
npm:pkg
```

- Versioned specs are pinned and skipped by package updates (`shuvpi update --extensions`, `shuvpi update --all`).
- User installs go under `~/.shuvpi/agent/npm/`.
- Project installs go under `.shuvpi/npm/`.
- Set `npmCommand` in `settings.json` to pin npm package lookup and install operations to a specific wrapper command such as `mise` or `asdf`.

Example:

```json
{
  "npmCommand": ["mise", "exec", "node@20", "--", "npm"]
}
```

### git

```
git:github.com/user/repo@v1
git:git@github.com:user/repo@v1
https://github.com/user/repo@v1
ssh://git@github.com/user/repo@v1
```

- Without `git:` prefix, only protocol URLs are accepted (`https://`, `http://`, `ssh://`, `git://`).
- With `git:` prefix, shorthand formats are accepted, including `github.com/user/repo` and `git@github.com:user/repo`.
- HTTPS and SSH URLs are both supported.
- SSH URLs use your configured SSH keys automatically (respects `~/.ssh/config`).
- For non-interactive runs (for example CI), you can set `GIT_TERMINAL_PROMPT=0` to disable credential prompts and set `GIT_SSH_COMMAND` (for example `ssh -o BatchMode=yes -o ConnectTimeout=5`) to fail fast.
- Refs are pinned tags or commits. `shuvpi update --extensions` and `shuvpi update --all` do not move them to newer refs, but they do reconcile an existing clone to the configured ref.
- Use `shuvpi install git:host/user/repo@new-ref` to update settings and move an existing package to a new pinned ref.
- Cloned to `~/.shuvpi/agent/git/<host>/<path>` (global) or `.shuvpi/git/<host>/<path>` (project).
- When reconciliation changes the checkout, shuvpi resets and cleans the clone, then runs `npm install` if `package.json` exists.

**SSH examples:**
```bash
# git@host:path shorthand (requires git: prefix)
shuvpi install git:git@github.com:user/repo

# ssh:// protocol format
shuvpi install ssh://git@github.com/user/repo

# With version ref
shuvpi install git:git@github.com:user/repo@v1.0.0
```

### Local Paths

```
/absolute/path/to/package
./relative/path/to/package
```

Local paths point to files or directories on disk and are added to settings without copying. Relative paths are resolved against the settings file they appear in. If the path is a file, it loads as a single extension. If it is a directory, shuvpi loads resources using package rules.

## Creating a Shuvpi Package

Add a `shuvpi` manifest to `package.json` or use conventional directories. Include the `shuvpi-package` keyword for discoverability.

```json
{
  "name": "my-package",
  "keywords": ["shuvpi-package"],
  "shuvpi": {
    "extensions": ["./extensions"],
    "skills": ["./skills"],
    "prompts": ["./prompts"],
    "themes": ["./themes"]
  }
}
```

Paths are relative to the package root. Arrays support glob patterns and `!exclusions`.

### Preview Metadata

Add `video` or `image` fields to describe package preview media:

```json
{
  "name": "my-package",
  "keywords": ["shuvpi-package"],
  "shuvpi": {
    "extensions": ["./extensions"],
    "video": "https://example.com/demo.mp4",
    "image": "https://example.com/screenshot.png"
  }
}
```

- **video**: MP4 only. On desktop, autoplays on hover. Clicking opens a fullscreen player.
- **image**: PNG, JPEG, GIF, or WebP. Displayed as a static preview.

If both are set, video takes precedence.

## Package Structure

### Convention Directories

If no `shuvpi` manifest is present, shuvpi auto-discovers resources from these directories:

- `extensions/` loads `.ts` and `.js` files
- `skills/` recursively finds `SKILL.md` folders and loads top-level `.md` files as skills
- `prompts/` loads `.md` files
- `themes/` loads `.json` files

## Dependencies

Third party runtime dependencies belong in `dependencies` in `package.json`. Dependencies that do not register extensions, skills, prompt templates, or themes also belong in `dependencies`. When shuvpi installs a package from npm or git, it runs `npm install`, so those dependencies are installed automatically.

Shuvpi bundles core packages for extensions and skills. If you import any of these, list them in `peerDependencies` with a `"*"` range and do not bundle them: `@shuv1337/shuvpi-ai`, `@shuv1337/shuvpi-agent-core`, `@shuv1337/shuvpi-coding-agent`, `@shuv1337/shuvpi-tui`, `typebox`.

Other shuvpi packages must be bundled in your tarball. Add them to `dependencies` and `bundledDependencies`, then reference their resources through `node_modules/` paths. Shuvpi loads packages with separate module roots, so separate installs do not collide or share modules.

Example:

```json
{
  "dependencies": {
    "shitty-extensions": "^1.0.1"
  },
  "bundledDependencies": ["shitty-extensions"],
  "shuvpi": {
    "extensions": ["extensions", "node_modules/shitty-extensions/extensions"],
    "skills": ["skills", "node_modules/shitty-extensions/skills"]
  }
}
```

## Package Filtering

Filter what a package loads using the object form in settings:

```json
{
  "packages": [
    "npm:simple-pkg",
    {
      "source": "npm:my-package",
      "extensions": ["extensions/*.ts", "!extensions/legacy.ts"],
      "skills": [],
      "prompts": ["prompts/review.md"],
      "themes": ["+themes/legacy.json"]
    }
  ]
}
```

`+path` and `-path` are exact paths relative to the package root.

- Omit a key to load all of that type.
- Use `[]` to load none of that type.
- `!pattern` excludes matches.
- `+path` force-includes an exact path.
- `-path` force-excludes an exact path.
- Filters layer on top of the manifest. They narrow down what is already allowed.

## Enable and Disable Resources

Use `shuvpi config` to enable or disable extensions, skills, prompt templates, and themes from installed packages and local directories. `shuvpi config` starts in global settings (`~/.shuvpi/agent/settings.json`); press Tab to switch between global and project-local modes. Use `shuvpi config -l` to start in project overrides (`.shuvpi/settings.json`) with inherited global resources dimmed.

## Scope and Deduplication

Packages can appear in both global and project settings. If the same package appears in both, the project entry wins unless the project entry has `autoload: false`, in which case it is applied as a delta over the global entry. Identity is determined by:

- npm: package name
- git: repository URL without ref
- local: resolved absolute path
