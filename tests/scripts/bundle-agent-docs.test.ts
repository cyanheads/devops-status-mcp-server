/**
 * @fileoverview Regression tests for the agent-doc selector shared by the bundle
 * cleaner (`scripts/clean-mcpb.ts`) and the packaging lint's bundle check
 * (`scripts/lint-packaging.ts`). Only agent docs at an installed package's root
 * are stripped; a `skills/` directory deeper inside a package is runtime code,
 * such as the MCP SDK's `dist/ext/skills/` modules, which the server imports at
 * startup.
 * @module tests/scripts/bundle-agent-docs.test
 */

import { describe, expect, it } from 'vitest';
import { filterAgentDocEntries } from '../../scripts/clean-mcpb.js';

type CheckBundleEntries = (entries: string[], bundleLabel: string) => string[];

/**
 * `lint-packaging.ts` keeps a fallback import of the framework repository's own
 * source, which does not exist here. A specifier tsc can resolve would pull the
 * script into the typecheck program and fail it, so the script loads by URL at
 * run time.
 */
async function loadCheckBundleEntries(): Promise<CheckBundleEntries> {
  const url = new URL('../../scripts/lint-packaging.ts', import.meta.url).href;
  const mod = (await import(url)) as { checkBundleEntries: CheckBundleEntries };
  return mod.checkBundleEntries;
}

/** Runtime entries a cleaned bundle must keep. */
const RUNTIME_ENTRIES = [
  'node_modules/@modelcontextprotocol/server/dist/ext/skills/index.mjs',
  'node_modules/@modelcontextprotocol/core/dist/ext/skills/index.mjs',
  'node_modules/@cyanheads/mcp-ts-core/node_modules/@modelcontextprotocol/server/dist/ext/skills/index.mjs',
  'node_modules/@cyanheads/mcp-ts-core/dist/mcp-server/skills.js',
  'node_modules/@example/skills/index.js',
  'node_modules/skills/index.js',
];

/** Agent docs at a package root, top-level and nested, scoped and unscoped. */
const AGENT_DOC_ENTRIES = [
  'node_modules/@cyanheads/mcp-ts-core/framework-skills/add-tool/SKILL.md',
  'node_modules/@cyanheads/mcp-ts-core/framework-skills/api-utils/references/formatting.md',
  'node_modules/example-pkg/skills/guide/SKILL.md',
  'node_modules/@example/pkg/skills/guide/references/notes.md',
  'node_modules/example-pkg/.claude/settings.json',
  'node_modules/@example/pkg/.agents/skills/guide/SKILL.md',
  'node_modules/example-pkg/SKILL.md',
  'node_modules/@example/pkg/SKILL.md',
  'node_modules/outer/node_modules/inner/skills/guide/SKILL.md',
  'node_modules/@example/outer/node_modules/@example/inner/framework-skills/x/SKILL.md',
];

describe('bundle agent-doc selector', () => {
  it('keeps nested runtime skills/ modules, including the MCP SDK extension', () => {
    expect(filterAgentDocEntries(RUNTIME_ENTRIES)).toEqual([]);
  });

  it('selects package-root skills/, framework-skills/, .claude/, .agents/, and SKILL.md', () => {
    expect(filterAgentDocEntries(AGENT_DOC_ENTRIES)).toEqual(AGENT_DOC_ENTRIES);
  });

  it('selects exactly the agent docs from a mixed listing', () => {
    expect(filterAgentDocEntries([...RUNTIME_ENTRIES, ...AGENT_DOC_ENTRIES])).toEqual(
      AGENT_DOC_ENTRIES,
    );
  });

  it('passes a cleaned bundle that still holds the runtime skills/ modules', async () => {
    const checkBundleEntries = await loadCheckBundleEntries();
    expect(checkBundleEntries(RUNTIME_ENTRIES, 'bundle.mcpb')).toEqual([]);
  });

  it('flags every entry the cleaner strips, and only those', async () => {
    const checkBundleEntries = await loadCheckBundleEntries();
    for (const entry of [...RUNTIME_ENTRIES, ...AGENT_DOC_ENTRIES]) {
      const flagged = checkBundleEntries([entry], 'bundle.mcpb').length > 0;
      expect({ entry, flagged }).toEqual({
        entry,
        flagged: filterAgentDocEntries([entry]).length > 0,
      });
    }
    const [error] = checkBundleEntries(AGENT_DOC_ENTRIES, 'bundle.mcpb');
    expect(error).toContain(`contains ${AGENT_DOC_ENTRIES.length} node_modules agent-doc entries`);
  });
});
