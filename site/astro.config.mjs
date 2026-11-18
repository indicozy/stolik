// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

export default defineConfig({
  site: 'https://indicozy.github.io',
  base: '/stolik',
  trailingSlash: 'always',
  integrations: [
    starlight({
      title: 'stolik',
      description: 'Your desk, in your pocket.',
      favicon: '/mascot/favicon-64.png',
      social: [{ icon: 'github', label: 'GitHub', href: 'https://github.com/indicozy/stolik' }],
      customCss: [
        '@fontsource-variable/bricolage-grotesque',
        '@fontsource-variable/instrument-sans',
        '@fontsource-variable/jetbrains-mono',
        './src/styles/tokens.css',
        './src/styles/starlight.css',
      ],
      components: { SiteTitle: './src/components/starlight/SiteTitle.astro' },
      sidebar: [
        {
          label: 'Docs',
          items: [
            { label: 'Install', slug: 'docs/install' },
            { label: 'Topics and sessions', slug: 'docs/topics' },
            { label: 'Commands', slug: 'docs/commands' },
            { label: 'Approvals and away', slug: 'docs/approvals' },
            { label: 'Addons', slug: 'docs/addons' },
            { label: 'Why the flag?', slug: 'docs/why-the-flag' },
            { label: 'Troubleshooting', slug: 'docs/troubleshooting' },
          ],
        },
      ],
      expressiveCode: {
        styleOverrides: { borderRadius: '12px', codeFontFamily: 'var(--font-mono)', codeFontSize: '0.875rem' },
      },
    }),
  ],
});
