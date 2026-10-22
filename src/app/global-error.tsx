'use client';

/**
 * 根布局级错误兜底：layout 本身崩溃时启用，必须自带 <html>/<body>。
 * 此时主题脚本等均已失效，用内联样式保证基本可读。
 *
 * 文案写死中文：这一层故意不接 i18n —— useT 依赖 store 与 Provider，
 * 而 Provider 正是根布局的一部分，崩溃时用 hook 会把兜底页也打崩。
 */
const GLOBAL_ERROR_TEXT = {
  message: '应用发生严重错误，请刷新页面重试。',
  reload: '刷新',
  digest: '错误编号：',
};
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  // 根布局崩溃时 store / Provider 可能已不可用，useT 会拿到字典里的中文默认值，
  // 这里刻意不用 hook：万一 Provider 挂了，hook 会二次抛错把兜底页也变成白屏。
  const text = GLOBAL_ERROR_TEXT;
  return (
    <html lang="zh-CN">
      <body
        style={{
          margin: 0,
          minHeight: '100vh',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 12,
          background: '#0b101a',
          color: '#c9d1d9',
          fontFamily: 'system-ui, sans-serif',
          textAlign: 'center',
          padding: 16,
        }}
      >
        <p style={{ margin: 0, fontSize: 14 }}>{text.message}</p>
        <button
          onClick={reset}
          style={{
            padding: '6px 16px',
            borderRadius: 6,
            border: '1px solid #2a3441',
            background: '#151b26',
            color: '#c9d1d9',
            cursor: 'pointer',
          }}
        >
          {text.reload}
        </button>
        {/* digest 用于线上日志定位，不含敏感信息，展示无妨 */}
        {error.digest && (
          <p style={{ margin: 0, fontSize: 11, color: '#6b7f99' }}>
            {text.digest}
            {error.digest}
          </p>
        )}
      </body>
    </html>
  );
}
