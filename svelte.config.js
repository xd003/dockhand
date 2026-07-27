import adapter from '@sveltejs/adapter-node';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	preprocess: [
		vitePreprocess(),
		{
			name: 'strip-ts-optional',
			script: async ({ content, attributes }) => {
				if (attributes.lang === 'ts') {
					return {
						code: content.replace(/(\w+)\?(\s*[:,)])/g, '$1$2')
					};
				}
			}
		}
	],

	kit: {
		adapter: adapter({
			out: 'build'
		}),
		csrf: {
			trustedOrigins: ['*']
		}
	}
};

export default config;
