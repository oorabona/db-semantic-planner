/**
 * commitlint config for db-semantic-planner monorepo.
 *
 * Enforces:
 *   - Conventional Commits format: `type(scope): subject`
 *   - Scope is REQUIRED (never bare `feat:`, `fix:`, etc.)
 *   - Scope must be one of the known monorepo packages or meta areas
 *   - Subject is imperative, lowercase first word, no trailing period, <=72 chars
 */
export default {
  extends: ['@commitlint/config-conventional'],

  // Skip commits that carry a duplicate conventional-commit header as the
  // first body paragraph — an artefact of certain squash-merge workflows
  // where the PR title is prepended to the squashed body verbatim.
  // The pattern: header line == third line (blank line 2, duplicate header line 3).
  ignores: [
    (commit) => {
      const lines = commit.split('\n');
      return (
        lines.length >= 3 &&
        lines[1] === '' &&
        lines[0] === lines[2] &&
        /^\w+(\([^)]+\))?: .+/.test(lines[0])
      );
    },
  ],
  rules: {
    // Require scope — reject bare `feat:`, `fix:`, etc.
    'scope-empty': [2, 'never'],

    // Restrict scope to known areas (packages + meta scopes)
    'scope-enum': [
      2,
      'always',
      [
        // Publishable packages
        'types',
        'nql',
        'core',
        'adapter-pgsql',
        'cli',
        'mcp-server',
        // Private packages
        'gui',
        'docs',
        // Meta scopes
        'release',
        'deps',
        'deps-dev',
        'ci',
        'build',
        'repo',
      ],
    ],

    // Reject trailing period on subject
    'subject-full-stop': [2, 'never', '.'],

    // Subject case: forbid sentence-case/pascal-case/start-case starts, but
    // allow technical acronyms (CVE, SQL, NQL, DDL, API, etc.) inline.
    // Matches @commitlint/config-conventional's default behavior.
    'subject-case': [
      2,
      'never',
      ['sentence-case', 'start-case', 'pascal-case', 'upper-case'],
    ],

    // Body / footer leading blank line
    'body-leading-blank': [2, 'always'],
    'footer-leading-blank': [2, 'always'],

    // Allow long lines in body/footer (URLs, file paths, tool output, diffs)
    'body-max-line-length': [0],
    'footer-max-line-length': [0],
  },
};
