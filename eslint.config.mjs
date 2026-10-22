import nextCoreWebVitals from 'eslint-config-next/core-web-vitals';
import nextTypescript from 'eslint-config-next/typescript';

// Next.js 16 起 eslint-config-next 直接导出 flat config 数组，
// 不再需要 @eslint/eslintrc 的 FlatCompat 桥接（用 FlatCompat 包 flat config 会报
// "Converting circular structure to JSON"，因为插件对象里有 configs 自引用）。
const eslintConfig = [
  ...nextCoreWebVitals,
  ...nextTypescript,
  {
    ignores: ['.next/**', 'node_modules/**', 'next-env.d.ts'],
  },
  {
    rules: {
      // 播放器与 ArtPlayer/hls.js 交互处存在少量受控的 any（第三方类型未覆盖），
      // 保留告警即可，不阻塞构建
      '@typescript-eslint/no-explicit-any': 'warn',
      // 下面这批是 eslint-config-next 16 新引入的 React Compiler 规则（默认 error）。
      // 本站没有启用 React Compiler（next.config.ts 无 reactCompiler 选项），这些规则
      // 描述的是「编译器视角下不可优化」而非「代码有 bug」：refs 命中的是把 useRef 当
      // DOM/定时器句柄的正常写法，set-state-in-effect 命中的是「进页读 localStorage
      // 初始化派生状态」，两者都已在浏览器里实测正常。降级为 warn：保留提示，不阻塞
      // npm run lint 与 CI。
      'react-hooks/refs': 'warn',
      'react-hooks/set-state-in-effect': 'warn',
      'react-hooks/set-state-in-render': 'warn',
      'react-hooks/preserve-manual-memoization': 'warn',
      'react-hooks/immutability': 'warn',
      'react-hooks/purity': 'warn',
      'react-hooks/static-components': 'warn',
      'react-hooks/use-memo': 'warn',
      'react-hooks/incompatible-library': 'warn',
      'react-hooks/globals': 'warn',
      'react-hooks/error-boundaries': 'warn',
      'react-hooks/config': 'warn',
      'react-hooks/gating': 'warn',
    },
  },
];

export default eslintConfig;
