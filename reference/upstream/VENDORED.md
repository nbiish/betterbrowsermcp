# Vendored from upstream @browsermcp/mcp

**Source:** https://github.com/browsermcp/mcp
**Commit:** 9db12f2b4f61294f0bc11708986abc47db539d6c
**Version:** v0.1.3

This directory contains a vendored copy of the upstream `@browsermcp/mcp`
source for reference. It is NOT used at runtime — betterbrowsermcp has
its own self-contained source in `../src/`.

Pulled in to give the team an expert reference for the base architecture
that betterbrowsermcp forks. See `../ARCHITECTURE.md` for the
comparison and `../../../docs/multi-agent-design.md` for the v0.3.0+
multi-agent and multi-tab extensions.

## Why vendored, not submodule

Submodules are great for tracking upstream drift, but bad for an
explanatory reference. We want this code frozen at v0.1.3 so the
team can study the baseline architecture without noise from
upstream changes that may or may not be relevant.
