import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5178,
    proxy: {
      '/api/311': {
        target: 'https://data.cityofnewyork.us',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/311/, '/resource/erm6-by3h.json'),
      },
    },
  },
});
