import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
// base './' lets the built site run from a GitHub Pages sub-path (username.github.io/repo-name/)
export default defineConfig({ base: './', plugins: [react()] })
