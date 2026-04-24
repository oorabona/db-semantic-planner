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

    // Reject capitalized first word on subject
    'subject-case': [2, 'always', 'lower-case'],

    // Body / footer leading blank line
    'body-leading-blank': [2, 'always'],
    'footer-leading-blank': [2, 'always'],
  },
};
