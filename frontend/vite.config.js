import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { writeFileSync } from 'fs'

export default defineConfig({
    plugins: [
        react(),
        {
            name: 'stamp-sw',
            closeBundle() {
                const swPath = 'dist/sw.js';
                const fs = require('fs');
                let content = fs.readFileSync(swPath, 'utf-8');
                content = content.replace(
                    /const CACHE_NAME = .+;/,
                    `const CACHE_NAME = 'cdrrmo-fews-${Date.now()}';`
                );
                fs.writeFileSync(swPath, content);
            }
        }
    ],
    base: "/",
    build: {
        outDir: "dist",
    },
})