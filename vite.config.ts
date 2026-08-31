import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    host: '0.0.0.0',
    port: 5173,
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined;
          if (id.includes('/react/') || id.includes('/react-dom/')) return 'vendor-react';
          if (id.includes('/firebase/') || id.includes('/@firebase/')) return 'vendor-firebase';
          if (id.includes('/recharts/') || id.includes('/d3')) return 'vendor-charts';
          if (id.includes('/motion/') || id.includes('/lucide-react/')) return 'vendor-ui';
          return 'vendor';
        },
      },
    },
  },
});
