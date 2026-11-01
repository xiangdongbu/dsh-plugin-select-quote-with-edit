import React from 'react'

interface IconProps {
  className?: string
}

/** 引用图标：圆角方框内两个引号（对应截图里 chip 与工具条的图标）。 */
export function QuoteIcon(_props: IconProps): React.ReactNode {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="1.8" y="2.8" width="12.4" height="10.4" rx="2.6" stroke="currentColor" strokeWidth="1.3" />
      <path
        d="M6.1 6.2c-.85 0-1.45.6-1.45 1.42 0 .78.55 1.34 1.3 1.34.06 0 .13 0 .19-.01-.2.62-.63 1.05-1.24 1.25l.42.83c1.25-.38 2.08-1.45 2.08-2.87 0-1.16-.55-1.96-1.3-1.96Z"
        fill="currentColor"
      />
      <path
        d="M10.4 6.2c-.85 0-1.45.6-1.45 1.42 0 .78.55 1.34 1.3 1.34.06 0 .13 0 .19-.01-.2.62-.63 1.05-1.24 1.25l.42.83c1.25-.38 2.08-1.45 2.08-2.87 0-1.16-.55-1.96-1.3-1.96Z"
        fill="currentColor"
      />
    </svg>
  )
}

export function CopyIcon(_props: IconProps): React.ReactNode {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="9" y="9" width="13" height="13" rx="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  )
}

export function CheckIcon(_props: IconProps): React.ReactNode {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  )
}

export function XIcon(_props: IconProps): React.ReactNode {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </svg>
  )
}
