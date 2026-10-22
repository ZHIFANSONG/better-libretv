import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    // 纯逻辑测试跑 node（快）；组件测试在文件头用 `// @vitest-environment jsdom`
    // 单独切换，不必给整个套件加载 DOM。
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    environment: 'node',
  },
  esbuild: {
    // 组件测试用 JSX
    jsx: 'automatic',
  },
  resolve: {
    alias: { '@': path.resolve(__dirname, './src') },
  },
});
