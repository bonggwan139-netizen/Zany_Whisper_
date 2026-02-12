// @ts-check
import { defineConfig } from 'astro/config';

// https://astro.build/config
export default defineConfig({
	site: 'https://bonggwan139-netizen.github.io',
	base: '/Zany_Whisper_',
	server: {
		port: 4321,
		host: true,
	},
});
