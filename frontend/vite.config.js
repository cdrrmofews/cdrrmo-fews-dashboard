import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { readFileSync, writeFileSync } from 'fs'

export default defineConfig({
    plugins: [
        react(),
        {
            name: 'stamp-sw',
            apply: 'build',
            closeBundle() {
                const swPath = 'dist/sw.js';
                let content = readFileSync(swPath, 'utf-8');
                const stamped = content.replace(
                    'BUILD_STAMP',
                    Date.now().toString()
                );
                if (stamped === content) {
                    console.warn('[stamp-sw] WARNING: BUILD_STAMP not found in sw.js!');
                } else {
                    writeFileSync(swPath, stamped);
                    console.log('[stamp-sw] sw.js stamped successfully');
                }
            }
        }
    ],
    base: "/",
    build: {
        outDir: "dist",
    },
})