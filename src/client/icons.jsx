// Inline SVG icons sized through the current font.
const stroke = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round' }

function Svg({ size = 16, children, viewBox = '0 0 24 24', ...rest }) {
  return (
    <svg width={size} height={size} viewBox={viewBox} aria-hidden="true" {...rest}>
      {children}
    </svg>
  )
}

export function LibraryIcon({ size = 16 }) {
  return (
    <Svg size={size}>
      <path {...stroke} d="M4 5.5A1.5 1.5 0 0 1 5.5 4H9v16H5.5A1.5 1.5 0 0 1 4 18.5z" />
      <path {...stroke} d="M9 4h4.5A1.5 1.5 0 0 1 15 5.5v13a1.5 1.5 0 0 1-1.5 1.5H9z" />
      <path {...stroke} d="M15.4 5.2l3.1.8a1.5 1.5 0 0 1 1.06 1.84l-3.3 12.3" />
    </Svg>
  )
}

export function CollectionIcon({ size = 14 }) {
  return (
    <Svg size={size}>
      <path {...stroke} d="M3.5 7.5A1.5 1.5 0 0 1 5 6h4l2 2h8a1.5 1.5 0 0 1 1.5 1.5v8A1.5 1.5 0 0 1 19 19H5a1.5 1.5 0 0 1-1.5-1.5z" />
    </Svg>
  )
}

export function TagIcon({ size = 14 }) {
  return (
    <Svg size={size}>
      <path {...stroke} d="M12.6 3.9 20 11.3a1.5 1.5 0 0 1 0 2.1l-6.6 6.6a1.5 1.5 0 0 1-2.1 0L3.9 12.6V4.9A1 1 0 0 1 4.9 3.9z" />
      <circle cx="8" cy="8" r="1.4" fill="currentColor" />
    </Svg>
  )
}

export function TrashIcon({ size = 14 }) {
  return (
    <Svg size={size}>
      <path {...stroke} d="M4.5 6.5h15M9 6.5V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v1.5M6.5 6.5l.8 12a1.5 1.5 0 0 0 1.5 1.4h6.4a1.5 1.5 0 0 0 1.5-1.4l.8-12" />
    </Svg>
  )
}

export function InboxIcon({ size = 14 }) {
  return (
    <Svg size={size}>
      <path {...stroke} d="M4 13.5 6 5.5h12l2 8" />
      <path {...stroke} d="M4 13.5h4.5l1.2 2h4.6l1.2-2H20v4a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 17.5z" />
    </Svg>
  )
}

export function SearchIcon({ size = 15 }) {
  return (
    <Svg size={size}>
      <circle {...stroke} cx="10.5" cy="10.5" r="6" />
      <path {...stroke} d="m15 15 4.5 4.5" />
    </Svg>
  )
}

export function SyncIcon({ size = 15 }) {
  return (
    <Svg size={size}>
      <path {...stroke} d="M20 11a8 8 0 0 0-14.3-4.6M4 13a8 8 0 0 0 14.3 4.6" />
      <path {...stroke} d="M20 4.5V11h-6M4 19.5V13h6" />
    </Svg>
  )
}

export function GearIcon({ size = 15 }) {
  return (
    <Svg size={size}>
      <circle {...stroke} cx="12" cy="12" r="3" />
      <path {...stroke} d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06-2.83 2.83-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1.04 1.56V21h-4v-.08A1.7 1.7 0 0 0 8.96 19.4a1.7 1.7 0 0 0-1.87.34l-.06.06-2.83-2.83.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-1.56-1.04H3v-4h.08A1.7 1.7 0 0 0 4.6 8.96a1.7 1.7 0 0 0-.34-1.87l-.06-.06 2.83-2.83.06.06A1.7 1.7 0 0 0 8.96 4.6 1.7 1.7 0 0 0 10 3.08V3h4v.08a1.7 1.7 0 0 0 1.04 1.56 1.7 1.7 0 0 0 1.87-.34l.06-.06 2.83 2.83-.06.06a1.7 1.7 0 0 0-.34 1.87A1.7 1.7 0 0 0 20.92 10H21v4h-.08A1.7 1.7 0 0 0 19.4 15z" />
    </Svg>
  )
}

export function ChevronDown({ size = 12 }) {
  return (
    <Svg size={size}>
      <path {...stroke} d="m5 9 7 7 7-7" />
    </Svg>
  )
}

export function ChevronLeftIcon({ size = 12 }) {
  return (
    <Svg size={size}>
      <path {...stroke} d="m15 5-7 7 7 7" />
    </Svg>
  )
}

export function ChevronRightIcon({ size = 12 }) {
  return (
    <Svg size={size}>
      <path {...stroke} d="m9 5 7 7-7 7" />
    </Svg>
  )
}

export function PlusIcon({ size = 14 }) {
  return (
    <Svg size={size}>
      <path {...stroke} d="M12 5v14M5 12h14" />
    </Svg>
  )
}

export function CloseIcon({ size = 14 }) {
  return (
    <Svg size={size}>
      <path {...stroke} d="m6 6 12 12M18 6 6 18" />
    </Svg>
  )
}

export function PdfIcon({ size = 15 }) {
  return (
    <Svg size={size}>
      <path {...stroke} d="M6 3.5h7l5 5V20a.5.5 0 0 1-.5.5h-11A.5.5 0 0 1 6 20z" />
      <path {...stroke} d="M13 3.5V9h5" />
      <path {...stroke} d="M8.5 14.5h7M8.5 17.5h5" />
    </Svg>
  )
}

export function NoteIcon({ size = 15 }) {
  return (
    <Svg size={size}>
      <path {...stroke} d="M5 4.5h14v10l-5 5H5z" />
      <path {...stroke} d="M14 19.5v-5h5M8 8.5h8M8 11.5h6" />
    </Svg>
  )
}

export function AttachmentIcon({ size = 15 }) {
  return (
    <Svg size={size}>
      <path {...stroke} d="M9 12.5 15.8 5.7a2.8 2.8 0 1 1 4 4L12 17.5a4.6 4.6 0 0 1-6.5-6.5l7.3-7.3" />
    </Svg>
  )
}

export function ChatIcon({ size = 16 }) {
  return (
    <Svg size={size}>
      <path {...stroke} d="M4.5 5.5h15v10h-9l-4.5 3.5v-3.5h-1.5z" />
    </Svg>
  )
}

export function FolderIcon({ size = 14 }) {
  return <CollectionIcon size={size} />
}

export function ExternalIcon({ size = 13 }) {
  return (
    <Svg size={size}>
      <path {...stroke} d="M14 4h6v6M20 4l-9 9" />
      <path {...stroke} d="M18 14v5.5a.5.5 0 0 1-.5.5h-13a.5.5 0 0 1-.5-.5v-13a.5.5 0 0 1 .5-.5H10" />
    </Svg>
  )
}

export function HighlightIcon({ size = 14 }) {
  return (
    <Svg size={size}>
      <path {...stroke} d="M4 15h16v5H4z" />
      <path {...stroke} d="M6 15l2.5-6.5L14 3l4 4-5.5 5.5L9 14z" />
    </Svg>
  )
}

export function UnderlineIcon({ size = 14 }) {
  return (
    <Svg size={size}>
      <path {...stroke} d="M6 4v7a6 6 0 0 0 12 0V4" />
      <path {...stroke} d="M5 20h14" />
    </Svg>
  )
}

export function RotateLeftIcon({ size = 14 }) {
  return (
    <Svg size={size}>
      <path {...stroke} d="M4.5 5v4.5H9" />
      <path {...stroke} d="M5.2 13.5a7.5 7.5 0 1 0 1.6-6.9L4.5 9" />
    </Svg>
  )
}

export function RotateRightIcon({ size = 14 }) {
  return (
    <Svg size={size}>
      <path {...stroke} d="M19.5 5v4.5H15" />
      <path {...stroke} d="M18.8 13.5a7.5 7.5 0 1 1-1.6-6.9L19.5 9" />
    </Svg>
  )
}

export function CopyIcon({ size = 14 }) {
  return (
    <Svg size={size}>
      <rect {...stroke} x="9" y="9" width="11" height="11" rx="1.5" />
      <path {...stroke} d="M5 15H4.5A1.5 1.5 0 0 1 3 13.5v-9A1.5 1.5 0 0 1 4.5 3h9A1.5 1.5 0 0 1 15 4.5V5" />
    </Svg>
  )
}

export function WandIcon({ size = 14 }) {
  return (
    <Svg size={size}>
      <path {...stroke} d="m14.5 5.5 4 4L8 20l-4 .5L4.5 16z" />
      <path {...stroke} d="m13 7 4 4M17 3v3M21.5 5.5h-3M19 9l2 2" />
    </Svg>
  )
}

export function MinusIcon({ size = 13 }) {
  return (
    <Svg size={size}>
      <path {...stroke} d="M5 12h14" />
    </Svg>
  )
}

export function ArrowUpIcon({ size = 12 }) {
  return (
    <Svg size={size}>
      <path {...stroke} d="M12 19V5M6 11l6-6 6 6" />
    </Svg>
  )
}

export function ArrowDownIcon({ size = 12 }) {
  return (
    <Svg size={size}>
      <path {...stroke} d="M12 5v14M6 13l6 6 6-6" />
    </Svg>
  )
}

export function ChevronUp({ size = 12 }) {
  return (
    <Svg size={size}>
      <path {...stroke} d="m5 15 7-7 7 7" />
    </Svg>
  )
}

export function LinkIcon({ size = 12 }) {
  return (
    <Svg size={size}>
      <path {...stroke} d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 1 0-5.7-5.6L11.6 6.8" />
      <path {...stroke} d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 1 0 5.7 5.6l1.4-1.4" />
    </Svg>
  )
}

export function SwitchFieldIcon({ size = 12 }) {
  return (
    <Svg size={size}>
      <path {...stroke} d="M4 7h10M4 12h16M4 17h16" />
      <circle cx="17.5" cy="7" r="2.4" fill="currentColor" stroke="none" />
    </Svg>
  )
}


