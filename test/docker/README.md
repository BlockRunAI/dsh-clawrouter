# From-zero smoke test

Installs the **published** package from npm into a container that has never
seen this project, then asserts the profile composes and the tarball carries
what the runtime loads. Needs no wallet and no API key — every step is free.

```sh
docker build -t dsh-clawrouter-smoke test/docker
docker run --rm dsh-clawrouter-smoke

# a specific version, or a local tarball served over npm
docker run --rm -e PLUGIN_SPEC=dsh-clawrouter@0.4.2 dsh-clawrouter-smoke
```

Verified on `linux/arm64` and `linux/amd64`.

## Why the image installs python3, make and g++

For `dsh`, not for this plugin. `dsh` depends on `node-pty`, which has no
prebuild for `node:22-slim` on either architecture, so npm rebuilds it from
source and the install fails at `Could not find any Python installation to use`
before this plugin is ever fetched.

This is worth knowing because the failure names Python and node-gyp, and points
at neither dsh nor this plugin.

## What it proves that the unit tests cannot

The unit suite runs against `src` in a tree with dev dependencies installed.
This runs the published artifact on a cold machine, so it catches a file
missing from `files`, a dependency that only resolved locally, and a profile
that composes on the author's laptop and nowhere else.
